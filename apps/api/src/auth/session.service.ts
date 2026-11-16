import { type DbHandle, orm, userSessions, users } from '@bm/db';
import { generateToken, type Role, sha256 } from '@bm/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthInfo } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB } from '../core/tokens';

const { and, eq, gt, isNull, sql } = orm;

export const SESSION_COOKIE = 'bm_sid';
const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, meta: { ip?: string; userAgent?: string }) {
    const { token, hash } = generateToken();
    const now = Date.now();
    const [session] = await this.handle.db
      .insert(userSessions)
      .values({
        userId,
        tokenHash: hash,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        idleExpiresAt: new Date(now + this.config.SESSION_IDLE_MINUTES * 60_000),
        absoluteExpiresAt: new Date(now + this.config.SESSION_ABSOLUTE_HOURS * 3_600_000),
      })
      .returning({ id: userSessions.id, absoluteExpiresAt: userSessions.absoluteExpiresAt });
    if (!session) throw new Error('falha ao criar sessão');
    return { token, ...session };
  }

  /** Resolve o token do cookie; renova a expiração por inatividade (no máx. 1×/min). */
  async resolve(token: string): Promise<AuthInfo | null> {
    const now = new Date();
    const [row] = await this.handle.db
      .select({
        sessionId: userSessions.id,
        userId: users.id,
        role: users.role,
        lastSeenAt: userSessions.lastSeenAt,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, sha256(token)),
          isNull(userSessions.revokedAt),
          gt(userSessions.idleExpiresAt, now),
          gt(userSessions.absoluteExpiresAt, now),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) return null;

    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.handle.db
        .update(userSessions)
        .set({
          lastSeenAt: now,
          idleExpiresAt: sql`least(${userSessions.absoluteExpiresAt}, now() + make_interval(mins => ${this.config.SESSION_IDLE_MINUTES}))`,
        })
        .where(eq(userSessions.id, row.sessionId));
    }
    return { userId: row.userId, role: row.role as Role, sessionId: row.sessionId };
  }

  async revoke(sessionId: string, userId: string): Promise<boolean> {
    const rows = await this.handle.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.id, sessionId),
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
        ),
      )
      .returning({ id: userSessions.id });
    return rows.length > 0;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.handle.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  }

  listActive(userId: string) {
    const now = new Date();
    return this.handle.db
      .select({
        id: userSessions.id,
        ip: userSessions.ip,
        userAgent: userSessions.userAgent,
        lastSeenAt: userSessions.lastSeenAt,
        createdAt: userSessions.createdAt,
      })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          gt(userSessions.idleExpiresAt, now),
        ),
      );
  }
}
