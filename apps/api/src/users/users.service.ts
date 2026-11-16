import { type DbHandle, orm, users } from '@bm/db';
import { encryptSecret, type KeyProvider, type Role } from '@bm/shared';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { generateTotpSecret, hashPassword } from '../auth/crypto';
import { SessionService } from '../auth/session.service';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { AuditService } from '../core/audit.service';
import { DB, KEY_PROVIDER } from '../core/tokens';

const { asc, eq } = orm;

const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  status: users.status,
  totpEnrolledAt: users.totpEnrolledAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  password: string;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  list() {
    return this.handle.db.select(publicColumns).from(users).orderBy(asc(users.createdAt));
  }

  /**
   * Cria operador com segredo TOTP próprio. O QR code é exibido no primeiro login
   * (após a senha), quando o operador configura o app autenticador.
   */
  async create(input: CreateUserInput, ctx: RequestContext) {
    const totpSecretEnc = await encryptSecret(generateTotpSecret(), this.keys);
    const passwordHash = await hashPassword(input.password);
    return this.handle.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          passwordHash,
          totpSecretEnc,
        })
        .onConflictDoNothing({ target: users.email })
        .returning(publicColumns);
      if (!user) throw new AppError(HttpStatus.CONFLICT, 'email_taken', 'E-mail já cadastrado');
      await this.audit.record(
        ctx,
        { action: 'user.create', entityType: 'user', entityId: user.id, after: user },
        tx,
      );
      return user;
    });
  }

  async update(
    id: string,
    patch: { role?: Role; status?: 'active' | 'disabled' },
    ctx: RequestContext,
  ) {
    if (id === ctx.userId && (patch.role || patch.status)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'self_change',
        'Não é possível alterar o próprio papel/status',
      );
    }
    const updated = await this.handle.db.transaction(async (tx) => {
      const [before] = await tx.select(publicColumns).from(users).where(eq(users.id, id)).limit(1);
      if (!before) throw new NotFoundException();
      const [after] = await tx
        .update(users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning(publicColumns);
      await this.audit.record(
        ctx,
        { action: 'user.update', entityType: 'user', entityId: id, before, after },
        tx,
      );
      return after;
    });
    if (patch.status === 'disabled') await this.sessions.revokeAllForUser(id);
    return updated;
  }
}
