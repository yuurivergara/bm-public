import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  contactImportJobs,
  contactImports,
  type DbHandle,
  type ImportMapping,
  orm,
  withTenant,
  withTenantSql,
} from '@bm/db';
import { normalizePhone, phoneHasher } from '@bm/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB } from '../core/tokens';
import { detectFormat, readHeader, readRows, resolveMapping } from './import-file';
import { ImportsService } from './imports.service';

const { eq, sql } = orm;

const MAX_ATTEMPTS = 3;
const LEASE = '30 minutes';
const ERROR_SAMPLE = 20;

const REASONS: Record<string, string> = {
  empty: 'telefone vazio',
  invalid_characters: 'caracteres inválidos',
  invalid_length: 'quantidade de dígitos inválida',
  invalid_number: 'número inválido (DDD/formato)',
};

/** Escapa um valor para o formato texto do COPY. */
function copyText(v: string | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  return v.replace(
    /[\\\t\n\r]/g,
    (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c] as string,
  );
}

class PermanentError extends Error {}

/**
 * Processa a fila `contact_import_jobs` (análise do arquivo e confirmação), um job por vez, sempre
 * com o contexto do cliente. Análise e confirmação são uma transação cada: se o processo cair no
 * meio, nada fica pela metade e o job volta à fila quando a lease expira.
 */
@Injectable()
export class ImportProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ImportProcessor');
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly imports: ImportsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.IMPORT_PROCESSOR_ENABLED) return;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.drain()
        .catch((err) => this.logger.error(`falha no ciclo: ${(err as Error).message}`))
        .finally(() => {
          if (!this.stopped)
            this.timer = setTimeout(tick, this.config.IMPORT_PROCESSOR_INTERVAL_MS);
        });
    };
    this.timer = setTimeout(tick, this.config.IMPORT_PROCESSOR_INTERVAL_MS);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Processa jobs até a fila esvaziar. Devolve quantos rodaram. */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      if (this.stopped) return n;
      const job = await this.claim();
      if (!job) return n;
      await this.run(job);
      n++;
    }
  }

  private async claim() {
    const rows = await this.handle.db.execute<{
      import_id: string;
      tenant_id: string;
      kind: 'parse' | 'confirm';
      attempts: number;
    }>(sql`
      update contact_import_jobs j
         set attempts = j.attempts + 1, lease_until = now() + ${LEASE}::interval
       where j.import_id = (
         select import_id from contact_import_jobs
          where available_at <= now() and (lease_until is null or lease_until < now())
          order by available_at
          limit 1
          for update skip locked)
      returning j.import_id, j.tenant_id, j.kind, j.attempts`);
    const r = [...rows][0];
    return r
      ? { importId: r.import_id, tenantId: r.tenant_id, kind: r.kind, attempts: r.attempts }
      : undefined;
  }

  private async run(job: {
    importId: string;
    tenantId: string;
    kind: 'parse' | 'confirm';
    attempts: number;
  }) {
    const t0 = Date.now();
    try {
      if (job.kind === 'parse') await this.parse(job.tenantId, job.importId);
      else await this.confirmImport(job.tenantId, job.importId);
      await this.handle.db
        .delete(contactImportJobs)
        .where(eq(contactImportJobs.importId, job.importId));
      this.logger.log(`importação ${job.importId}: ${job.kind} ok em ${Date.now() - t0} ms`);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const permanent = err instanceof PermanentError || job.attempts >= MAX_ATTEMPTS;
      this.logger.warn(`importação ${job.importId}: ${job.kind} falhou (${message})`);
      if (permanent) {
        await withTenant(this.handle.db, job.tenantId, async (tx) => {
          await tx
            .update(contactImports)
            .set({
              status: job.kind === 'parse' ? 'failed' : 'preview',
              error: message,
              updatedAt: new Date(),
              finishedAt: job.kind === 'parse' ? new Date() : null,
            })
            .where(eq(contactImports.id, job.importId));
          await tx.delete(contactImportJobs).where(eq(contactImportJobs.importId, job.importId));
        });
        if (job.kind === 'parse') await rm(this.imports.filePath(job.importId), { force: true });
      } else {
        await this.handle.db
          .update(contactImportJobs)
          .set({
            leaseUntil: null,
            lastError: message,
            availableAt: new Date(Date.now() + 30_000 * job.attempts),
          })
          .where(eq(contactImportJobs.importId, job.importId));
      }
    }
  }

  /** Lê o arquivo, normaliza, classifica (válido/inválido/duplicado/suprimido) e monta a prévia. */
  private async parse(tenantId: string, importId: string) {
    const [imp] = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select().from(contactImports).where(eq(contactImports.id, importId)),
    );
    if (!imp || !['uploaded', 'parsing'].includes(imp.status)) return;
    await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .update(contactImports)
        .set({ status: 'parsing', updatedAt: new Date() })
        .where(eq(contactImports.id, importId)),
    );

    const path = this.imports.filePath(importId);
    const format = detectFormat(imp.originalFilename);
    if (!format) throw new PermanentError('formato não suportado');
    const m: ImportMapping = imp.mapping;
    const opts = { format, delimiter: m.delimiter, hasHeader: m.hasHeader };
    let header: Awaited<ReturnType<typeof readHeader>>;
    try {
      header = await readHeader(path, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PermanentError('arquivo não está mais disponível: envie de novo');
      }
      throw err;
    }
    const map = resolveMapping(header.columns, m);
    const hash = phoneHasher(this.config.PHONE_HASH_PEPPER, tenantId);
    const maxRows = this.config.IMPORT_MAX_ROWS;
    let rowNo = 0;
    let tooMany = false;

    const lines = async function* () {
      let first = true;
      for await (const cols of readRows(path, opts)) {
        if (first && m.hasHeader) {
          first = false;
          continue;
        }
        first = false;
        if (cols.every((c) => c === '')) continue;
        if (++rowNo > maxRows) {
          tooMany = true;
          return;
        }
        const raw = cols[map.phone] ?? '';
        const n = normalizePhone(raw);
        const name = map.name !== undefined ? cols[map.name]?.slice(0, 200) || null : null;
        const attrs: Record<string, string> = {};
        for (const [k, i] of map.attributes) attrs[k] = (cols[i] ?? '').slice(0, 1000);
        const attributes = JSON.stringify(attrs);
        if (n.ok) {
          yield `${rowNo}\t${n.e164}\t\\\\x${hash(n.e164).toString('hex')}\t${copyText(name)}\t${copyText(attributes)}\tvalid\t\\N\n`;
        } else {
          yield `${rowNo}\t\\N\t\\N\t${copyText(name)}\t${copyText(attributes)}\tinvalid\t${copyText(REASONS[n.reason] ?? n.reason)}\n`;
        }
      }
    };

    const counts = await withTenantSql(this.handle.sql, tenantId, async (tx) => {
      await tx`delete from contact_import_rows where import_id = ${importId}`;
      // COPY FROM não funciona em tabela com RLS: copia para uma temporária e insere de lá.
      await tx`create temp table import_stage (
        row_no int, phone_e164 text, phone_hash bytea, name text, attributes jsonb, status text, reason text
      ) on commit drop`;
      const writable = await tx`copy import_stage from stdin`.writable();
      await pipeline(Readable.from(lines()), writable);
      if (tooMany)
        throw new PermanentError(`arquivo com mais de ${maxRows.toLocaleString('pt-BR')} linhas`);
      if (rowNo === 0) throw new PermanentError('nenhuma linha de dados no arquivo');

      await tx`
        insert into contact_import_rows
          (import_id, tenant_id, row_no, phone_e164, phone_hash, name, attributes, status, reason)
        select ${importId}, ${tenantId}, s.row_no, s.phone_e164, s.phone_hash, s.name, s.attributes,
               case
                 when s.status = 'invalid' then 'invalid'
                 when row_number() over (partition by s.phone_e164 order by s.row_no) > 1 then 'duplicate'
                 when exists (select 1 from suppressions x
                               where x.tenant_id = ${tenantId} and x.phone_hash = s.phone_hash) then 'suppressed'
                 else 'valid'
               end,
               s.reason
          from import_stage s`;
      const [c] = await tx<
        {
          total: number;
          valid: number;
          invalid: number;
          duplicate: number;
          suppressed: number;
          existing: number;
        }[]
      >`
        select count(*)::int as total,
               count(*) filter (where r.status = 'valid')::int as valid,
               count(*) filter (where r.status = 'invalid')::int as invalid,
               count(*) filter (where r.status = 'duplicate')::int as duplicate,
               count(*) filter (where r.status = 'suppressed')::int as suppressed,
               count(c.id) filter (where r.status = 'valid')::int as existing
          from contact_import_rows r
          left join contacts c on c.tenant_id = r.tenant_id and c.phone_e164 = r.phone_e164
         where r.import_id = ${importId}`;
      const sample = await tx<{ row: number; reason: string }[]>`
        select row_no as row, reason from contact_import_rows
         where import_id = ${importId} and status = 'invalid'
         order by row_no limit ${ERROR_SAMPLE}`;
      await tx`
        update contact_imports
           set status = 'preview', row_count = ${c?.total ?? 0}, valid_count = ${c?.valid ?? 0},
               invalid_count = ${c?.invalid ?? 0}, duplicate_count = ${c?.duplicate ?? 0},
               suppressed_count = ${c?.suppressed ?? 0}, existing_count = ${c?.existing ?? 0},
               error_sample = ${JSON.stringify(sample.map((s) => ({ row: s.row, reason: s.reason })))}::jsonb,
               error = null, updated_at = now()
         where id = ${importId}`;
      return c;
    });
    // O arquivo não é mais necessário: a prévia está no banco (minimização, LGPD).
    await rm(path, { force: true });
    this.logger.log(
      `importação ${importId}: ${counts?.total} linhas, ${counts?.valid} válidas, ${counts?.invalid} inválidas, ` +
        `${counts?.duplicate} duplicadas, ${counts?.suppressed} suprimidas`,
    );
  }

  /** Cria contatos (upsert), a lista, os membros (nunca suprimidos) e o registro de consentimento. */
  private async confirmImport(tenantId: string, importId: string) {
    await withTenantSql(this.handle.sql, tenantId, async (tx) => {
      const [imp] = await tx<
        {
          status: string;
          list_name: string;
          legal_basis: string;
          origin_declaration: string;
          declaration_notes: string | null;
          declared_by: string;
          declared_at: Date;
        }[]
      >`select status, list_name, legal_basis, origin_declaration, declaration_notes, declared_by, declared_at
          from contact_imports where id = ${importId} for update`;
      if (imp?.status !== 'confirming') return;

      // Supressões criadas depois da prévia também valem.
      await tx`
        update contact_import_rows r set status = 'suppressed'
         where r.import_id = ${importId} and r.status = 'valid'
           and exists (select 1 from suppressions x where x.tenant_id = r.tenant_id and x.phone_hash = r.phone_hash)`;

      const [list] = await tx<{ id: string }[]>`
        insert into contact_lists (tenant_id, import_id, name, created_by)
        values (${tenantId}, ${importId}, ${imp.list_name}, ${imp.declared_by})
        returning id`;
      const listId = list?.id as string;

      await tx`
        insert into contacts (tenant_id, phone_e164, phone_hash, name, attributes, first_import_id)
        select tenant_id, phone_e164, phone_hash, name, attributes, import_id
          from contact_import_rows where import_id = ${importId} and status = 'valid'
        on conflict (tenant_id, phone_e164) do update
          set name = coalesce(excluded.name, contacts.name),
              attributes = contacts.attributes || excluded.attributes,
              updated_at = now()`;

      await tx`
        insert into contact_list_members (list_id, contact_id, tenant_id)
        select ${listId}, c.id, c.tenant_id
          from contact_import_rows r
          join contacts c on c.tenant_id = r.tenant_id and c.phone_e164 = r.phone_e164
         where r.import_id = ${importId} and r.status = 'valid'
           and not exists (select 1 from suppressions x where x.tenant_id = c.tenant_id and x.phone_hash = c.phone_hash)`;

      const evidence = {
        origin: imp.origin_declaration,
        notes: imp.declaration_notes,
        declaredBy: imp.declared_by,
        declaredAt: imp.declared_at,
      };
      await tx`
        insert into consent_records (tenant_id, contact_id, basis, source, import_id, evidence)
        select tenant_id, contact_id, ${imp.legal_basis}, 'import_declaration', ${importId}, ${JSON.stringify(evidence)}::jsonb
          from contact_list_members where list_id = ${listId}`;

      const [size] = await tx<{ n: number }[]>`
        update contact_lists set size = (select count(*) from contact_list_members where list_id = ${listId})
         where id = ${listId} returning size as n`;
      const [sup] = await tx<{ n: number }[]>`
        select count(*)::int as n from contact_import_rows where import_id = ${importId} and status = 'suppressed'`;
      await tx`delete from contact_import_rows where import_id = ${importId}`;
      await tx`
        update contact_imports
           set status = 'confirmed', list_id = ${listId}, suppressed_count = ${sup?.n ?? 0},
               updated_at = now(), finished_at = now()
         where id = ${importId}`;
      await tx`
        insert into audit_logs (user_id, tenant_id, action, entity_type, entity_id, after)
        values (null, ${tenantId}, 'contact_list.create', 'contact_list', ${listId},
                ${JSON.stringify({ importId, name: imp.list_name, size: size?.n ?? 0 })}::jsonb)`;
    });
  }
}
