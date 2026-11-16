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

/**
 * Tabelas com tenant_id que, por decisão documentada, não usam RLS.
 * - audit_logs: log do operador, cross-tenant, append-only.
 * - meta_asset_routes: só identificadores Meta → tenant; o processador de webhooks precisa
 *   resolver o tenant antes de ter contexto (0002_meta_assets.sql).
 */
// contact_import_jobs: fila do worker, só IDs (migration 0004).
const RLS_EXEMPT = new Set(['audit_logs', 'meta_asset_routes', 'contact_import_jobs']);

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

  it('cria partições mensais de webhook_events à frente', async () => {
    const rows = await admin<{ relname: string }[]>`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'webhook_events'::regclass`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
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

  it('ativos Meta de um cliente não são visíveis por outro', async () => {
    const { db, close } = createDb(tdb.appUrl, { max: 2 });
    try {
      const [a] = await db.insert(tenants).values({ name: 'Ativos A' }).returning();
      const [b] = await db.insert(tenants).values({ name: 'Ativos B' }).returning();
      if (!a || !b) throw new Error('falha ao criar tenants');
      await withTenant(db, a.id, async (tx) => {
        const [p] = await tx
          .insert(schema.businessPortfolios)
          .values({ tenantId: a.id, metaBusinessId: `biz-${a.id}` })
          .returning();
        if (!p) throw new Error('portfolio');
        const [w] = await tx
          .insert(schema.whatsappAccounts)
          .values({ tenantId: a.id, portfolioId: p.id, metaWabaId: `waba-${a.id}` })
          .returning();
        if (!w) throw new Error('waba');
        await tx.insert(schema.phoneNumbers).values({
          tenantId: a.id,
          wabaId: w.id,
          metaPhoneNumberId: `pn-${a.id}`,
          phoneE164: '+5511900000001',
        });
      });
      for (const table of [
        schema.businessPortfolios,
        schema.whatsappAccounts,
        schema.phoneNumbers,
      ]) {
        expect(await withTenant(db, b.id, (tx) => tx.select().from(table))).toEqual([]);
        expect(await db.select().from(table)).toEqual([]);
        expect(await withTenant(db, a.id, (tx) => tx.select().from(table))).toHaveLength(1);
      }
    } finally {
      await close();
    }
  });

  it('um número só pode estar ativo em uma WABA por vez (D-13)', async () => {
    const { db, close } = createDb(tdb.appUrl, { max: 1 });
    try {
      const [t] = await db.insert(tenants).values({ name: 'Números' }).returning();
      if (!t) throw new Error('tenant');
      await withTenant(db, t.id, async (tx) => {
        const [p] = await tx
          .insert(schema.businessPortfolios)
          .values({ tenantId: t.id, metaBusinessId: `biz-n-${t.id}` })
          .returning();
        if (!p) throw new Error('portfolio');
        const [w] = await tx
          .insert(schema.whatsappAccounts)
          .values({ tenantId: t.id, portfolioId: p.id, metaWabaId: `waba-n-${t.id}` })
          .returning();
        if (!w) throw new Error('waba');
        await tx.insert(schema.phoneNumbers).values({
          tenantId: t.id,
          wabaId: w.id,
          metaPhoneNumberId: `pn-n1-${t.id}`,
          phoneE164: '+5511900000099',
        });
      });
      await expect(
        withTenant(db, t.id, async (tx) => {
          const [w] = await tx.select().from(schema.whatsappAccounts).limit(1);
          if (!w) throw new Error('waba');
          await tx.insert(schema.phoneNumbers).values({
            tenantId: t.id,
            wabaId: w.id,
            metaPhoneNumberId: `pn-n2-${t.id}`,
            phoneE164: '+5511900000099',
          });
        }),
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

/**
 * FKs com ON DELETE CASCADE/SET NULL fazem o Postgres procurar as linhas filhas pela coluna da FK.
 * Sem um índice que comece por ela, cada linha apagada no pai vira uma varredura completa do filho
 * (apagar 1M contatos levou horas no staging por causa de consent_records). Exceções: FKs para
 * tabelas pequenas/raramente apagadas, listadas aqui com o motivo.
 */
const FK_INDEX_EXEMPT = new Set<string>([
  // usuários são desativados, não apagados
  'contact_imports.contact_imports_declared_by_fkey',
  'contact_lists.contact_lists_created_by_fkey',
  'message_templates.message_templates_created_by_fkey',
  'number_assignments.number_assignments_assigned_by_fkey',
  'suppressions.suppressions_created_by_fkey',
  // tabelas pequenas (dezenas a milhares de linhas) ou de vida curta
  'contact_import_jobs.contact_import_jobs_tenant_id_fkey',
  'contact_imports.contact_imports_list_fk',
  'login_challenges.login_challenges_user_id_fkey',
  'number_assignments.number_assignments_phone_number_id_fkey',
  'number_inventory.number_inventory_provider_id_fkey',
  'phone_numbers.phone_numbers_inventory_id_fkey',
  'whatsapp_accounts.whatsapp_accounts_connection_id_fkey',
  'whatsapp_accounts.whatsapp_accounts_portfolio_id_fkey',
]);

describe('chaves estrangeiras', () => {
  it('toda FK tem um índice que começa pelas colunas dela', async () => {
    const rows = await admin<{ fk: string }[]>`
      select c.conrelid::regclass || '.' || c.conname as fk
        from pg_constraint c
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
              and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
       order by 1`;
    expect(rows.map((r) => r.fk).filter((fk) => !FK_INDEX_EXEMPT.has(fk))).toEqual([]);
  });
});
