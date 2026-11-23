import { auditLogs, type Database, type DbHandle, type Tx } from '@bm/db';
import { Inject, Injectable } from '@nestjs/common';
import type { RequestContext } from '../common/request-context';
import { DB } from './tokens';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  tenantId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Campos que nunca entram na auditoria. */
const SENSITIVE = new Set([
  'passwordHash',
  'totpSecretEnc',
  'tokenHash',
  'password',
  'accessTokenEnc',
  'appSecretEnc',
  'appSecret',
]);

function scrub(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(scrub);
  if (Buffer.isBuffer(value)) return '[binary]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SENSITIVE.has(k))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  /** Grava na mesma transação da alteração, quando `tx` é informado. */
  async record(ctx: RequestContext, entry: AuditEntry, tx?: Tx | Database): Promise<void> {
    await (tx ?? this.handle.db).insert(auditLogs).values({
      userId: ctx.userId ?? null,
      tenantId: entry.tenantId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: scrub(entry.before) ?? null,
      after: scrub(entry.after) ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  }
}
