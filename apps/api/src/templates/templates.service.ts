import {
  type DbHandle,
  messageTemplates,
  metaConnections,
  orm,
  type Tx,
  tenants,
  whatsappAccounts,
  withTenant,
} from '@bm/db';
import {
  type CreateTemplateInput,
  type MetaClient,
  type MetaTemplate,
  templateQuality,
} from '@bm/meta-client';
import { decryptSecret, type KeyProvider } from '@bm/shared';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import { metaWriteError } from '../common/meta-errors';
import type { RequestContext } from '../common/request-context';
import { AuditService } from '../core/audit.service';
import { DB, KEY_PROVIDER, META_CLIENT } from '../core/tokens';

const { and, asc, eq, notInArray } = orm;

export interface TemplateCreateInput extends CreateTemplateInput {
  /** WABA local (uuid). */
  wabaId: string;
}

/** Palavras de opt-out (docs/02-arquitetura.md §6.4) aceitas no botão de quick reply. */
export const OPT_OUT_LABEL = /sair|parar|pare|stop|cancelar|descadastr|n[ãa]o quero|unsubscribe/i;

interface Button {
  type?: string;
  text?: string;
}

/** FR-TPL-05: template de marketing precisa de botão de opt-out (quick reply). */
export function hasOptOutButton(components: unknown[]): boolean {
  return components.some((c) => {
    const comp = c as { type?: string; buttons?: Button[] };
    return (
      String(comp.type).toUpperCase() === 'BUTTONS' &&
      (comp.buttons ?? []).some(
        (b) => String(b.type).toUpperCase() === 'QUICK_REPLY' && OPT_OUT_LABEL.test(b.text ?? ''),
      )
    );
  });
}

const view = (t: typeof messageTemplates.$inferSelect) => {
  const { metaRaw: _raw, tenantId: _t, ...rest } = t;
  return rest;
};

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(META_CLIENT) private readonly meta: MetaClient,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    await this.requireTenant(tenantId);
    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .select()
        .from(messageTemplates)
        .orderBy(asc(messageTemplates.name), asc(messageTemplates.language)),
    );
    return { data: rows.map(view) };
  }

  /** Cria na WABA do cliente (submete à revisão da Meta) e grava localmente. */
  async create(tenantId: string, input: TemplateCreateInput, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    if (input.category === 'MARKETING' && !hasOptOutButton(input.components)) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'optout_button_required',
        'Template de marketing precisa de um botão de resposta rápida de descadastro (ex.: "Não quero receber")',
      );
    }
    const waba = await this.wabaWithToken(tenantId, input.wabaId);

    let created: { id: string; status?: string; category?: string };
    try {
      created = await this.meta
        .withToken(waba.token, waba.appSecret)
        .createTemplate(waba.metaWabaId, input);
    } catch (err) {
      throw metaWriteError(err);
    }

    return withTenant(this.handle.db, tenantId, async (tx) => {
      const now = new Date();
      const values = {
        metaTemplateId: created.id,
        category: created.category ?? input.category,
        submittedCategory: input.category,
        parameterFormat: input.parameterFormat ?? 'POSITIONAL',
        status: created.status ?? 'PENDING',
        components: input.components,
        rejectionReason: null,
        lastStatusAt: now,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(messageTemplates)
        .values({
          tenantId,
          wabaId: waba.id,
          name: input.name,
          language: input.language,
          createdBy: ctx.userId ?? null,
          ...values,
        })
        .onConflictDoUpdate({
          target: [messageTemplates.wabaId, messageTemplates.name, messageTemplates.language],
          set: values,
        })
        .returning();
      if (!row) throw new Error('falha ao gravar template');
      await this.audit.record(
        ctx,
        {
          action: 'template.create',
          entityType: 'message_template',
          entityId: row.id,
          tenantId,
          after: {
            name: row.name,
            language: row.language,
            submittedCategory: input.category,
            category: row.category,
            status: row.status,
            metaTemplateId: row.metaTemplateId,
          },
        },
        tx,
      );
      return view(row);
    });
  }

  /** Sincroniza status, categoria, qualidade e componentes de todos os templates do cliente. */
  async sync(tenantId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    const wabas = await this.wabasWithToken(tenantId);
    const errors: { wabaId: string; code: string; message: string }[] = [];
    let synced = 0;
    for (const w of wabas) {
      let remote: MetaTemplate[];
      try {
        remote = await this.meta.withToken(w.token, w.appSecret).listTemplates(w.metaWabaId);
      } catch (err) {
        const e = metaWriteError(err);
        errors.push({ wabaId: w.metaWabaId, code: e.code, message: e.message });
        continue;
      }
      await withTenant(this.handle.db, tenantId, async (tx) => {
        for (const t of remote) await this.upsertRemote(tx, tenantId, w.id, t);
        // Locais que sumiram da Meta (apagados no WhatsApp Manager)
        const ids = remote.map((t) => String(t.id));
        await tx
          .update(messageTemplates)
          .set({ status: 'DELETED', updatedAt: new Date() })
          .where(
            and(
              eq(messageTemplates.wabaId, w.id),
              ids.length ? notInArray(messageTemplates.metaTemplateId, ids) : undefined,
            ),
          );
        await this.audit.record(
          ctx,
          {
            action: 'template.sync',
            entityType: 'whatsapp_account',
            entityId: w.id,
            tenantId,
            after: { count: remote.length },
          },
          tx,
        );
      });
      synced += remote.length;
    }
    return { ...(await this.list(tenantId)), synced, syncErrors: errors };
  }

  /** Apaga UM template na Meta (hsm_id + name) e localmente. */
  async remove(tenantId: string, templateId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    const row = await withTenant(this.handle.db, tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(messageTemplates)
        .where(eq(messageTemplates.id, templateId));
      return r;
    });
    if (!row) throw new NotFoundException('Template não encontrado');
    if (row.metaTemplateId && row.status !== 'DELETED') {
      const waba = await this.wabaWithToken(tenantId, row.wabaId);
      try {
        await this.meta
          .withToken(waba.token, waba.appSecret)
          .deleteTemplate(waba.metaWabaId, { name: row.name, hsmId: row.metaTemplateId });
      } catch (err) {
        throw metaWriteError(err);
      }
    }
    await withTenant(this.handle.db, tenantId, async (tx) => {
      await tx.delete(messageTemplates).where(eq(messageTemplates.id, templateId));
      await this.audit.record(
        ctx,
        {
          action: 'template.delete',
          entityType: 'message_template',
          entityId: templateId,
          tenantId,
          before: { name: row.name, language: row.language, status: row.status },
        },
        tx,
      );
    });
    return { deleted: true };
  }

  private async upsertRemote(tx: Tx, tenantId: string, wabaId: string, t: MetaTemplate) {
    const now = new Date();
    const values = {
      metaTemplateId: String(t.id),
      status: t.status ?? 'PENDING',
      category: t.category ?? null,
      previousCategory: t.previous_category ?? null,
      parameterFormat: t.parameter_format ?? null,
      qualityScore: templateQuality(t.quality_score),
      rejectionReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      components: t.components ?? [],
      metaRaw: t,
      syncedAt: now,
      updatedAt: now,
    };
    await tx
      .insert(messageTemplates)
      .values({ tenantId, wabaId, name: t.name, language: t.language, ...values })
      .onConflictDoUpdate({
        target: [messageTemplates.wabaId, messageTemplates.name, messageTemplates.language],
        set: values,
      });
  }

  private async wabasWithToken(tenantId: string, wabaId?: string) {
    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .select({
          id: whatsappAccounts.id,
          metaWabaId: whatsappAccounts.metaWabaId,
          tokenEnc: metaConnections.accessTokenEnc,
          appSecretEnc: metaConnections.appSecretEnc,
          connStatus: metaConnections.status,
        })
        .from(whatsappAccounts)
        .innerJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
        .where(wabaId ? eq(whatsappAccounts.id, wabaId) : undefined),
    );
    const out = [];
    for (const r of rows) {
      if (r.connStatus !== 'active') continue;
      out.push({
        id: r.id,
        metaWabaId: r.metaWabaId,
        token: await decryptSecret(r.tokenEnc, this.keys),
        appSecret: r.appSecretEnc ? await decryptSecret(r.appSecretEnc, this.keys) : undefined,
      });
    }
    return out;
  }

  private async wabaWithToken(tenantId: string, wabaId: string) {
    const [w] = await this.wabasWithToken(tenantId, wabaId);
    if (!w) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'waba_not_found',
        'WABA não encontrada para este cliente ou conexão com a Meta inativa',
      );
    }
    return w;
  }

  private async requireTenant(tenantId: string) {
    const [t] = await this.handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw new NotFoundException('Cliente não encontrado');
  }
}
