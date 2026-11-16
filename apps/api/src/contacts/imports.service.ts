import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  contactImportJobs,
  contactImports,
  type DbHandle,
  type ImportMapping,
  orm,
  tenants,
  withTenant,
} from '@bm/db';
import type { MultipartFile } from '@fastify/multipart';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../core/audit.service';
import { DB } from '../core/tokens';
import { detectFormat, MappingError, readHeader, resolveMapping } from './import-file';

const { and, desc, eq, inArray } = orm;

/** Campos do formulário (multipart) — enviados ANTES do arquivo. */
export const importFieldsSchema = z
  .object({
    listName: z.string().trim().min(1).max(120),
    originDeclaration: z.enum(['customers', 'signup', 'leads', 'other']),
    legalBasis: z.enum(['consentimento', 'legitimo_interesse', 'execucao_contrato']),
    declarationNotes: z.string().trim().max(2000).optional(),
    /** Confirmação explícita da declaração (FR-CON-03). */
    declarationAccepted: z.literal('true', {
      errorMap: () => ({ message: 'É obrigatório declarar a origem e a base legal dos contatos' }),
    }),
    hasHeader: z.enum(['true', 'false']).optional(),
    delimiter: z.enum([';', ',', 'tab', '|']).optional(),
    /** JSON: {"phone": "Celular" | 2, "name"?: ..., "attributes"?: {"primeiro_nome": "Nome"}} */
    mapping: z.string().max(5000).optional(),
  })
  .strict();

const mappingSchema = z
  .object({
    phone: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    name: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    attributes: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'variável: minúsculas, números e _'),
        z.union([z.string().min(1), z.number().int().positive()]),
      )
      .optional(),
  })
  .strict();

type ImportRow = typeof contactImports.$inferSelect;
const view = (r: ImportRow) => {
  const { fileSha256, tenantId: _t, ...rest } = r;
  return { ...rest, fileSha256: fileSha256.toString('hex') };
};

@Injectable()
export class ImportsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  filePath(importId: string): string {
    return join(this.config.IMPORT_DIR, importId);
  }

  /**
   * Recebe o upload (multipart: campos primeiro, arquivo por último), grava em disco calculando o
   * SHA-256, valida declaração e mapeamento e enfileira a análise. Responde antes da análise.
   */
  async upload(tenantId: string, req: FastifyRequest, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    if (!req.isMultipart()) {
      throw new AppError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'multipart_required',
        'Envie multipart/form-data',
      );
    }
    await mkdir(this.config.IMPORT_DIR, { recursive: true, mode: 0o700 });
    const importId = crypto.randomUUID();
    const path = this.filePath(importId);
    const fields: Record<string, string> = {};
    let file: { filename: string; size: number; sha256: Buffer } | undefined;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (file) {
            throw new AppError(
              HttpStatus.BAD_REQUEST,
              'fields_after_file',
              'Envie os campos antes do arquivo',
            );
          }
          fields[part.fieldname] = String(part.value);
          continue;
        }
        if (part.fieldname !== 'file' || file) {
          part.file.resume();
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'invalid_file_field',
            'Envie um único arquivo no campo "file"',
          );
        }
        file = await this.saveFile(part, path);
      }
    } catch (err) {
      await rm(path, { force: true });
      throw this.uploadError(err);
    }

    try {
      if (!file)
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'file_required',
          'Arquivo ausente (campo "file")',
        );
      const format = detectFormat(file.filename);
      if (!format) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'unsupported_format',
          'Formatos aceitos: .csv, .txt, .xlsx',
        );
      }
      if (file.size === 0)
        throw new AppError(HttpStatus.BAD_REQUEST, 'empty_file', 'Arquivo vazio');
      const parsedFields = importFieldsSchema.safeParse(fields);
      if (!parsedFields.success) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'validation_error',
          'Dados inválidos',
          parsedFields.error.flatten(),
        );
      }
      const f = parsedFields.data;
      let rawMapping: unknown = {};
      try {
        rawMapping = f.mapping ? JSON.parse(f.mapping) : {};
      } catch {
        throw new AppError(HttpStatus.BAD_REQUEST, 'validation_error', 'mapping não é JSON válido');
      }
      const m = mappingSchema.safeParse(rawMapping);
      if (!m.success) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'validation_error',
          'mapping inválido',
          m.error.flatten(),
        );
      }
      const hasHeader = f.hasHeader ? f.hasHeader === 'true' : format !== 'txt';
      const delimiter = f.delimiter === 'tab' ? '\t' : f.delimiter;

      let header: Awaited<ReturnType<typeof readHeader>>;
      try {
        header = await readHeader(path, { format, delimiter, hasHeader });
      } catch {
        throw new AppError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'unreadable_file',
          'Não foi possível ler o arquivo',
        );
      }
      try {
        resolveMapping(header.columns, m.data);
      } catch (err) {
        if (err instanceof MappingError) {
          throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'mapping_required', err.message, {
            columns: err.columns,
          });
        }
        throw err;
      }
      const mapping: ImportMapping = {
        ...(m.data.phone !== undefined ? { phone: m.data.phone } : { phone: '' }),
        ...(m.data.name !== undefined ? { name: m.data.name } : {}),
        ...(m.data.attributes ? { attributes: m.data.attributes } : {}),
        hasHeader,
        ...(delimiter ? { delimiter } : {}),
      };
      if (mapping.phone === '') {
        // grava a coluna detectada para a análise usar a mesma
        mapping.phone = resolveMapping(header.columns, m.data).phone + 1;
      }

      const row = await withTenant(this.handle.db, tenantId, async (tx) => {
        const now = new Date();
        const [r] = await tx
          .insert(contactImports)
          .values({
            id: importId,
            tenantId,
            originalFilename: file.filename.slice(0, 255),
            fileFormat: format,
            fileSize: file.size,
            fileSha256: file.sha256,
            mapping,
            listName: f.listName,
            originDeclaration: f.originDeclaration,
            legalBasis: f.legalBasis,
            declarationNotes: f.declarationNotes ?? null,
            declaredBy: ctx.userId as string,
            declaredAt: now,
          })
          .returning();
        if (!r) throw new Error('falha ao gravar importação');
        await tx.insert(contactImportJobs).values({ importId, tenantId, kind: 'parse' });
        await this.audit.record(
          ctx,
          {
            action: 'contact_import.create',
            entityType: 'contact_import',
            entityId: importId,
            tenantId,
            after: {
              filename: r.originalFilename,
              format,
              size: file.size,
              sha256: file.sha256.toString('hex'),
              originDeclaration: f.originDeclaration,
              legalBasis: f.legalBasis,
              listName: f.listName,
            },
          },
          tx,
        );
        return r;
      });
      return { ...view(row), columns: header.columns };
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
  }

  async list(tenantId: string) {
    await this.requireTenant(tenantId);
    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select().from(contactImports).orderBy(desc(contactImports.createdAt)).limit(100),
    );
    return { data: rows.map(view) };
  }

  async get(tenantId: string, importId: string) {
    await this.requireTenant(tenantId);
    return view(await this.find(tenantId, importId));
  }

  /** Confirma a prévia: o processador cria contatos, lista e registros de consentimento. */
  async confirm(
    tenantId: string,
    importId: string,
    listName: string | undefined,
    ctx: RequestContext,
  ) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const [r] = await tx
        .update(contactImports)
        .set({ status: 'confirming', ...(listName ? { listName } : {}), updatedAt: new Date() })
        .where(and(eq(contactImports.id, importId), eq(contactImports.status, 'preview')))
        .returning();
      if (!r) {
        const cur = await this.find(tenantId, importId);
        throw new AppError(
          HttpStatus.CONFLICT,
          'invalid_import_state',
          `Só é possível confirmar uma importação em prévia (status atual: ${cur.status})`,
        );
      }
      await tx
        .insert(contactImportJobs)
        .values({ importId, tenantId, kind: 'confirm' })
        .onConflictDoUpdate({
          target: contactImportJobs.importId,
          set: {
            kind: 'confirm',
            attempts: 0,
            availableAt: new Date(),
            leaseUntil: null,
            lastError: null,
          },
        });
      await this.audit.record(
        ctx,
        {
          action: 'contact_import.confirm',
          entityType: 'contact_import',
          entityId: importId,
          tenantId,
          after: { listName: r.listName, validCount: r.validCount },
        },
        tx,
      );
      return view(r);
    });
  }

  /** Descarta uma importação que ainda não virou lista (apaga arquivo e prévia). */
  async cancel(tenantId: string, importId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    const r = await withTenant(this.handle.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(contactImports)
        .set({ status: 'cancelled', updatedAt: new Date(), finishedAt: new Date() })
        .where(
          and(
            eq(contactImports.id, importId),
            inArray(contactImports.status, ['uploaded', 'preview', 'failed']),
          ),
        )
        .returning();
      if (!row) {
        const cur = await this.find(tenantId, importId);
        throw new AppError(
          HttpStatus.CONFLICT,
          'invalid_import_state',
          `Não é possível cancelar uma importação em "${cur.status}"`,
        );
      }
      await tx.delete(contactImportJobs).where(eq(contactImportJobs.importId, importId));
      await tx.execute(orm.sql`delete from contact_import_rows where import_id = ${importId}`);
      await this.audit.record(
        ctx,
        {
          action: 'contact_import.cancel',
          entityType: 'contact_import',
          entityId: importId,
          tenantId,
        },
        tx,
      );
      return row;
    });
    await rm(this.filePath(importId), { force: true });
    return view(r);
  }

  private async saveFile(part: MultipartFile, path: string) {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(part.file, meter, createWriteStream(path, { mode: 0o600 }));
    if (part.file.truncated) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'file_too_large',
        `Arquivo maior que ${Math.round(this.config.IMPORT_MAX_BYTES / 1024 / 1024)} MB`,
      );
    }
    return { filename: part.filename, size, sha256: hash.digest() };
  }

  private uploadError(err: unknown): unknown {
    if (err instanceof AppError) return err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'file_too_large', 'Arquivo grande demais');
    }
    if (code?.startsWith('FST_')) {
      return new AppError(HttpStatus.BAD_REQUEST, 'invalid_multipart', (err as Error).message);
    }
    return err;
  }

  private async find(tenantId: string, importId: string): Promise<ImportRow> {
    const [r] = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select().from(contactImports).where(eq(contactImports.id, importId)),
    );
    if (!r) throw new NotFoundException('Importação não encontrada');
    return r;
  }

  private async requireTenant(tenantId: string) {
    const [t] = await this.handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw new NotFoundException('Cliente não encontrado');
  }
}
