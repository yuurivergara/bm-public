import { sql as dsql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type RawSql = postgres.Sql;
export type RawTx = postgres.TransactionSql;

export interface DbHandle {
  db: Database;
  /** Cliente postgres.js cru: só para o que o Drizzle não cobre (COPY em massa). */
  sql: RawSql;
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end() };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação com o contexto de tenant definido (SET LOCAL app.tenant_id).
 * Todas as tabelas por cliente têm RLS forçada: sem esse contexto, nada é lido nem escrito.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return fn(tx);
  });
}

/** Define o tenant da transação corrente (válido até o fim da transação). */
export async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  if (!UUID_RE.test(tenantId)) throw new Error('tenantId inválido');
  await tx.execute(dsql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/** Como `withTenant`, mas com o cliente cru (necessário para `COPY ... FROM STDIN`). */
export async function withTenantSql<T>(
  sql: RawSql,
  tenantId: string,
  fn: (tx: RawTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('tenantId inválido');
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
