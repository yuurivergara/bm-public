import { type DbHandle, loginChallenges, orm, users } from '@bm/db';
import { decryptSecret, generateToken, type KeyProvider, sha256 } from '@bm/shared';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { AuditService } from '../core/audit.service';
import { DB, KEY_PROVIDER } from '../core/tokens';
import { getDummyHash, totpUri, verifyPassword, verifyTotp } from './crypto';
import { SessionService } from './session.service';

const { and, eq, gt, isNull, sql } = orm;

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const MAX_TOTP_ATTEMPTS = 5;

const invalidCredentials = () =>
  new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'E-mail ou senha inválidos');

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Etapa 1: senha. Devolve um desafio de uso único para a etapa TOTP. */
  async login(email: string, password: string, ctx: RequestContext) {
    const db = this.handle.db;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      await verifyPassword(await getDummyHash(), password);
      throw invalidCredentials();
    }
    if (user.status !== 'active') throw invalidCredentials();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'account_locked',
        'Conta bloqueada temporariamente por tentativas inválidas',
      );
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await db
        .update(users)
        .set({
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
        })
        .where(eq(users.id, user.id));
      await this.audit.record(
        { ...ctx, userId: user.id },
        {
          action: lock ? 'auth.locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
        },
      );
      throw invalidCredentials();
    }

    const { token, hash } = generateToken();
    await db.insert(loginChallenges).values({
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
    });

    const enrolled = Boolean(user.totpEnrolledAt);
    return {
      challengeToken: token,
      totpEnrolled: enrolled,
      // Primeiro acesso: o app autenticador precisa ser configurado (QR code no painel).
      otpauthUri: enrolled
        ? undefined
        : totpUri(user.email, await decryptSecret(user.totpSecretEnc, this.keys)),
    };
  }

  /** Etapa 2: TOTP. Cria a sessão. */
  async verifyTotp(challengeToken: string, code: string, ctx: RequestContext) {
    const db = this.handle.db;
    const [challenge] = await db
      .select()
      .from(loginChallenges)
      .where(
        and(
          eq(loginChallenges.tokenHash, sha256(challengeToken)),
          isNull(loginChallenges.usedAt),
          gt(loginChallenges.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!challenge || challenge.attempts >= MAX_TOTP_ATTEMPTS) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'challenge_invalid', 'Faça login novamente');
    }

    const [user] = await db.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
    if (user?.status !== 'active') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'challenge_invalid', 'Faça login novamente');
    }

    const secret = await decryptSecret(user.totpSecretEnc, this.keys);
    const step = verifyTotp(code, secret);
    if (step === null || (user.totpLastUsedStep !== null && step <= user.totpLastUsedStep)) {
      await db
        .update(loginChallenges)
        .set({ attempts: sql`${loginChallenges.attempts} + 1` })
        .where(eq(loginChallenges.id, challenge.id));
      await this.audit.record(
        { ...ctx, userId: user.id },
        { action: 'auth.totp_failed', entityType: 'user', entityId: user.id },
      );
      throw new AppError(HttpStatus.UNAUTHORIZED, 'invalid_totp', 'Código inválido');
    }

    // Consome o desafio de forma atômica (evita duas sessões com o mesmo desafio)
    const consumed = await db
      .update(loginChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(loginChallenges.id, challenge.id), isNull(loginChallenges.usedAt)))
      .returning({ id: loginChallenges.id });
    if (consumed.length === 0) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'challenge_invalid', 'Faça login novamente');
    }

    await db
      .update(users)
      .set({
        totpLastUsedStep: step,
        totpEnrolledAt: user.totpEnrolledAt ?? new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const session = await this.sessions.create(user.id, ctx);
    await this.audit.record(
      { ...ctx, userId: user.id },
      { action: 'auth.login', entityType: 'session', entityId: session.id },
    );
    return { session, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  }

  async logout(sessionId: string, ctx: RequestContext) {
    if (!ctx.userId) return;
    await this.sessions.revoke(sessionId, ctx.userId);
    await this.audit.record(ctx, {
      action: 'auth.logout',
      entityType: 'session',
      entityId: sessionId,
    });
  }

  async me(userId: string) {
    const [user] = await this.handle.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user;
  }
}
