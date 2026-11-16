import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const LOCK_KEY = 7_420_001;

export interface MigrateOptions {
  /** URL do papel dono do schema (DATABASE_ADMIN_URL). */
  adminUrl: string;
  /** Senha do papel da aplicação `bm_app`. Se ausente, o papel é criado sem login (útil em testes). */
  appPassword?: string;
  dir?: string;
  log?: (msg: string) => void;
}

/**
 * Migrador SQL simples e explícito:
 * - arquivos `NNNN_nome.sql` aplicados em ordem, uma única vez (tabela schema_migrations);
 * - cada arquivo em transação, exceto os que começam com `-- no-transaction`;
 * - advisory lock impede execuções concorrentes (deploys paralelos);
 * - garante a existência do papel `bm_app` antes das migrations (usado nos GRANTs).
 */
export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const sql = postgres(opts.adminUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    await ensureAppRole(sql, opts.appPassword);
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const done = new Set(
      (await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    );
    const files = readdirSync(opts.dir ?? MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const body = readFileSync(join(opts.dir ?? MIGRATIONS_DIR, file), 'utf8');
      log(`aplicando ${file}`);
      if (body.startsWith('-- no-transaction')) {
        await sql.unsafe(body);
        await sql`insert into schema_migrations (name) values (${file})`;
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`insert into schema_migrations (name) values (${file})`;
        });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}

/**
 * Papéis são globais no cluster: migrações simultâneas em bancos diferentes (testes paralelos,
 * múltiplos ambientes no mesmo servidor) podem colidir. As operações são idempotentes, então
 * conflitos de concorrência são simplesmente repetidos.
 */
async function ensureAppRole(sql: postgres.Sql, password?: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await sql<{ exists: boolean }[]>`
        select exists(select 1 from pg_roles where rolname = 'bm_app') as exists`;
      if (!row?.exists) {
        await sql.unsafe('create role bm_app nologin nosuperuser nobypassrls');
      }
      if (password) {
        // senha passada como literal escapado pelo próprio Postgres (format %L)
        const [stmt] = await sql<{ q: string }[]>`
          select format('alter role bm_app login password %L', ${password}::text) as q`;
        if (stmt) await sql.unsafe(stmt.q);
      }
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // XX000: tuple concurrently updated · 42710: duplicate_object · 23505: unique_violation
      const retryable = code === 'XX000' || code === '42710' || code === '23505';
      if (!retryable || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
