import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant } from './client';
import { migrate } from './migrator';
import { schema, tenantSettings, tenants } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let tdb: TestDatabase;
let admin: postgres.Sql;

beforeAll(async () => {
  tdb = await createTestDatabase();
  admin = postgres(tdb.adminUrl, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await admin?.end();
  await tdb?.drop();
});

/** Tabelas com tenant_id que, por decisão documentada, não usam RLS. */
const RLS_EXEMPT = new Set(['audit_logs']);

describe('migrations', () => {
  it('são idempotentes', async () => {
    const applied = await migrate({ adminUrl: tdb.adminUrl });
    expect(applied).toEqual([]);
  });

  it('cria partições mensais de auditoria à frente', async () => {
    const rows = await admin<{ relname: string }[]>`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'audit_logs'::regclass`;
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

describe('isolamento por cliente (RLS)', () => {
  it('toda tabela com tenant_id tem RLS habilitada, forçada e com política', async () => {
    const rows = await admin<
      { table_name: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
      from information_schema.columns col
      join pg_class c on c.relname = col.table_name and c.relkind in ('r', 'p')
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where col.column_name = 'tenant_id' and col.table_schema = 'public'
        and not c.relispartition`;
    expect(rows.length).toBeGreaterThan(0);
    const offenders = rows.filter(
      (r) => !RLS_EXEMPT.has(r.table_name) && !(r.rls && r.forced && r.policies > 0),
    );
    expect(offenders).toEqual([]);
  });

  it('o papel da aplicação não ignora RLS', async () => {
    const [role] = await admin<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'bm_app'`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('dados de um cliente não são visíveis nem graváveis por outro', async () => {
    const { db, close } = createDb(tdb.appUrl, { max: 2 });
    try {
      const [a] = await db.insert(tenants).values({ name: 'Loja A' }).returning();
      const [b] = await db.insert(tenants).values({ name: 'Loja B' }).returning();
      if (!a || !b) throw new Error('falha ao criar tenants');
      const policy = { firstPct: 5, min: 20, max: 200, growth: 2, gateMinutes: 15 };

      await withTenant(db, a.id, (tx) =>
        tx.insert(tenantSettings).values({ tenantId: a.id, wavePolicy: policy }),
      );

      // sem contexto: nada visível
      expect(await db.select().from(tenantSettings)).toEqual([]);
      // contexto de B: não vê A
      expect(await withTenant(db, b.id, (tx) => tx.select().from(tenantSettings))).toEqual([]);
      // contexto de A: vê A
      const own = await withTenant(db, a.id, (tx) => tx.select().from(tenantSettings));
      expect(own.map((r) => r.tenantId)).toEqual([a.id]);
      // contexto de B tentando gravar linha de A: bloqueado pela política
      await expect(
        withTenant(db, b.id, (tx) =>
          tx.insert(tenantSettings).values({ tenantId: a.id, wavePolicy: policy }),
        ),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('auditoria é append-only para a aplicação', async () => {
    const { db, close } = createDb(tdb.appUrl, { max: 1 });
    try {
      await db.insert(schema.auditLogs).values({ action: 'test', entityType: 'test' });
      await expect(db.delete(schema.auditLogs)).rejects.toThrow();
      await expect(db.update(schema.auditLogs).set({ action: 'x' })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

describe('drift entre schema Drizzle e banco', () => {
  it('todas as colunas declaradas existem no banco', async () => {
    const dbCols = await admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const set = new Set(dbCols.map((c) => `${c.table_name}.${c.column_name}`));
    const missing: string[] = [];
    for (const table of Object.values(schema)) {
      const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === 'drizzle:Name');
      const tableName = sym ? (table as unknown as Record<symbol, string>)[sym] : undefined;
      for (const col of Object.values(table as unknown as Record<string, { name?: string }>)) {
        if (col && typeof col === 'object' && typeof col.name === 'string') {
          const key = `${tableName}.${col.name}`;
          if (!set.has(key)) missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
