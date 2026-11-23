import {
  businessPortfolios,
  type CampaignStatus,
  type CampaignVariable,
  campaignDispatch,
  campaigns,
  contactLists,
  type DbHandle,
  messageTemplates,
  metaConnections,
  orm,
  phoneNumbers,
  type Tx,
  tenants,
  whatsappAccounts,
  withTenant,
} from '@bm/db';
import { maskPhone } from '@bm/shared';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../core/audit.service';
import { DB } from '../core/tokens';
import { analyzeTemplate, renderBody, resolveValue } from './render';

const { and, desc, eq, sql } = orm;

export interface CreateCampaignInput {
  name: string;
  listId: string;
  templateId: string;
  phoneNumberId: string;
  variables: Record<string, CampaignVariable>;
}

export type Counts = Record<
  | 'total'
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'skipped'
  | 'uncertain'
  | 'cancelled',
  number
>;

const emptyCounts = (): Counts => ({
  total: 0,
  pending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
  uncertain: 0,
  cancelled: 0,
});

/** Status do destinatário → contador do painel. */
const BUCKET: Record<string, keyof Counts> = {
  pending: 'pending',
  sending: 'pending',
  accepted: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  skipped: 'skipped',
  uncertain: 'uncertain',
  cancelled: 'cancelled',
};

/** Limite efetivo do portfolio (null = ilimitado). */
export function effectiveLimit(
  tier: string | null,
  value: number | null,
  config: Pick<AppConfig, 'CAPACITY_MARGIN' | 'DEFAULT_MESSAGING_LIMIT'>,
): number | null {
  if (tier === 'TIER_UNLIMITED' && value === null) return null;
  return Math.floor((value ?? config.DEFAULT_MESSAGING_LIMIT) * config.CAPACITY_MARGIN);
}

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ leitura

  async list(tenantId: string) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const rows = await this.baseQuery(tx).orderBy(desc(campaigns.createdAt)).limit(200);
      const counts = await this.counts(tx, null);
      return { data: rows.map((r) => this.view(r, counts.get(r.id))) };
    });
  }

  async get(tenantId: string, campaignId: string) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, (tx) => this.load(tx, campaignId));
  }

  async recipients(
    tenantId: string,
    campaignId: string,
    q: { status?: string; after?: number; limit: number },
  ) {
    await this.get(tenantId, campaignId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const rows = await tx.execute<{
        id: number;
        phone_e164: string;
        name: string | null;
        status: string;
        error_code: number | null;
        error_message: string | null;
        updated_at: string;
      }>(sql`
        select r.id, c.phone_e164, c.name, r.status, r.error_code, r.error_message, r.updated_at
          from campaign_recipients r join contacts c on c.id = r.contact_id
         where r.campaign_id = ${campaignId}
           ${q.status ? sql`and r.status = ${q.status}` : sql``}
           ${q.after ? sql`and r.id > ${q.after}` : sql``}
         order by r.id
         limit ${q.limit + 1}`);
      const list = [...rows];
      const page = list.slice(0, q.limit);
      return {
        data: page.map((r) => ({
          id: Number(r.id),
          phoneMasked: maskPhone(r.phone_e164),
          name: r.name,
          status: r.status,
          errorCode: r.error_code,
          errorMessage: r.error_message,
          updatedAt: r.updated_at,
        })),
        next: list.length > q.limit ? Number(page[page.length - 1]?.id) : null,
      };
    });
  }

  /** Limite de 24 h por portfolio e números do cliente. */
  async capacity(tenantId: string) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const portfolios = await tx
        .select({
          id: businessPortfolios.id,
          name: businessPortfolios.name,
          tier: businessPortfolios.messagingLimitTier,
          value: businessPortfolios.messagingLimitValue,
        })
        .from(businessPortfolios);
      const out = [];
      for (const p of portfolios) {
        const used = await this.usedInWindow(tx, p.id);
        const limit = effectiveLimit(p.tier, p.value, this.config);
        const phones = await tx
          .select({
            id: phoneNumbers.id,
            displayPhone: phoneNumbers.displayPhoneNumber,
            verifiedName: phoneNumbers.verifiedName,
            status: phoneNumbers.status,
            qualityRating: phoneNumbers.qualityRating,
            throughput: phoneNumbers.throughputLevel,
          })
          .from(phoneNumbers)
          .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, phoneNumbers.wabaId))
          .where(eq(whatsappAccounts.portfolioId, p.id));
        out.push({
          portfolioId: p.id,
          name: p.name,
          tier: p.tier,
          metaLimit: p.value,
          limit,
          used24h: used,
          available: limit === null ? null : Math.max(0, limit - used),
          phoneNumbers: phones,
        });
      }
      // Atalhos para o painel quando há um só portfolio (caso comum).
      const first = out[0];
      return {
        limit: first?.limit ?? null,
        used24h: first?.used24h ?? 0,
        available: first?.available ?? null,
        phoneNumbers: out.flatMap((p) => p.phoneNumbers),
        portfolios: out,
      };
    });
  }

  /** Prévia da mensagem com os dados de um contato de exemplo (ou do primeiro da lista). */
  async preview(tenantId: string, campaignId: string) {
    const c = await this.get(tenantId, campaignId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const [tpl] = await tx
        .select()
        .from(messageTemplates)
        .where(eq(messageTemplates.id, c.templateId));
      const a = analyzeTemplate(tpl?.components, tpl?.parameterFormat, tpl?.category);
      const [sample] = [
        ...(await tx.execute<{ name: string | null; attributes: Record<string, unknown> }>(sql`
          select c.name, c.attributes from contact_list_members m join contacts c on c.id = m.contact_id
           where m.list_id = ${c.listId} limit 1`)),
      ];
      const values: Record<string, string> = {};
      for (const p of a.placeholders) {
        values[p] = resolveValue(c.variables[p], {
          name: sample?.name ?? null,
          attributes: sample?.attributes ?? {},
        });
      }
      return { body: renderBody(a, values), placeholders: a.placeholders };
    });
  }

  // ------------------------------------------------------------------ escrita

  async create(tenantId: string, input: CreateCampaignInput, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const [list] = await tx
        .select({ id: contactLists.id, size: contactLists.size })
        .from(contactLists)
        .where(eq(contactLists.id, input.listId));
      if (!list) throw new AppError(HttpStatus.NOT_FOUND, 'list_not_found', 'Lista não encontrada');
      const phone = await this.phone(tx, input.phoneNumberId);
      const tpl = await this.template(tx, input.templateId);
      if (tpl.wabaId !== phone.wabaId) {
        throw new AppError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'template_phone_mismatch',
          'O modelo precisa ser da mesma conta de WhatsApp (WABA) do número escolhido',
        );
      }
      this.checkTemplate(tpl, input.variables);
      const [row] = await tx
        .insert(campaigns)
        .values({
          tenantId,
          name: input.name,
          listId: input.listId,
          templateId: input.templateId,
          phoneNumberId: input.phoneNumberId,
          variables: input.variables,
          audienceSize: list.size,
          createdBy: ctx.userId ?? null,
        })
        .returning({ id: campaigns.id });
      const id = row?.id as string;
      await this.audit.record(
        ctx,
        {
          action: 'campaign.create',
          entityType: 'campaign',
          entityId: id,
          tenantId,
          after: { name: input.name, listId: input.listId, templateId: input.templateId },
        },
        tx,
      );
      return this.load(tx, id);
    });
  }

  /** Valida tudo de novo, congela a audiência (sem suprimidos/inválidos) e põe na fila do motor. */
  async start(tenantId: string, campaignId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const c = await this.lock(tx, campaignId);
      if (c.status !== 'draft') throw this.badState(c.status, 'iniciar');
      const phone = await this.phone(tx, c.phoneNumberId);
      if (phone.status === 'restricted' || phone.status === 'disconnected') {
        throw new AppError(
          HttpStatus.CONFLICT,
          'phone_not_ready',
          `O número está ${phone.status === 'restricted' ? 'restrito' : 'desconectado'} na Meta`,
        );
      }
      if (phone.connectionStatus !== 'active') {
        throw new AppError(
          HttpStatus.CONFLICT,
          'connection_inactive',
          'A conexão com a Meta deste cliente não está ativa: reconecte o token',
        );
      }
      const tpl = await this.template(tx, c.templateId);
      this.checkTemplate(tpl, c.variables);
      const inserted = await tx.execute(sql`
        insert into campaign_recipients (campaign_id, tenant_id, contact_id)
        select ${campaignId}, ${tenantId}, c.id
          from contact_list_members m join contacts c on c.id = m.contact_id
         where m.list_id = ${c.listId} and c.invalid_at is null
           and not exists (select 1 from suppressions s
                            where s.tenant_id = c.tenant_id and s.phone_hash = c.phone_hash)
        on conflict (campaign_id, contact_id) do nothing`);
      const size = Number((inserted as unknown as { count?: number }).count ?? 0);
      if (size === 0) {
        throw new AppError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'empty_audience',
          'A lista não tem contatos que possam receber (vazia ou todos em opt-out)',
        );
      }
      await tx
        .update(campaigns)
        .set({
          status: 'running',
          audienceSize: size,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId));
      await tx.insert(campaignDispatch).values({ campaignId, tenantId }).onConflictDoNothing();
      await this.audit.record(
        ctx,
        {
          action: 'campaign.start',
          entityType: 'campaign',
          entityId: campaignId,
          tenantId,
          after: { audience: size },
        },
        tx,
      );
      return this.load(tx, campaignId);
    });
  }

  async pause(tenantId: string, campaignId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const c = await this.lock(tx, campaignId);
      if (c.status !== 'running') throw this.badState(c.status, 'pausar');
      await this.setPaused(tx, campaignId, 'Pausada manualmente');
      await this.audit.record(
        ctx,
        { action: 'campaign.pause', entityType: 'campaign', entityId: campaignId, tenantId },
        tx,
      );
      return this.load(tx, campaignId);
    });
  }

  async resume(tenantId: string, campaignId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const c = await this.lock(tx, campaignId);
      if (c.status !== 'paused') throw this.badState(c.status, 'retomar');
      const tpl = await this.template(tx, c.templateId);
      this.checkTemplate(tpl, c.variables);
      await tx
        .update(campaigns)
        .set({ status: 'running', pauseReason: null, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));
      await tx.insert(campaignDispatch).values({ campaignId, tenantId }).onConflictDoNothing();
      await this.audit.record(
        ctx,
        { action: 'campaign.resume', entityType: 'campaign', entityId: campaignId, tenantId },
        tx,
      );
      return this.load(tx, campaignId);
    });
  }

  async cancel(tenantId: string, campaignId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const c = await this.lock(tx, campaignId);
      if (!['draft', 'running', 'paused'].includes(c.status))
        throw this.badState(c.status, 'cancelar');
      await tx.execute(sql`
        update campaign_recipients set status = 'cancelled', updated_at = now()
         where campaign_id = ${campaignId} and status = 'pending'`);
      await tx
        .update(campaigns)
        .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));
      await tx.delete(campaignDispatch).where(eq(campaignDispatch.campaignId, campaignId));
      await this.audit.record(
        ctx,
        { action: 'campaign.cancel', entityType: 'campaign', entityId: campaignId, tenantId },
        tx,
      );
      return this.load(tx, campaignId);
    });
  }

  /** Usado também pelo motor (pausa automática com motivo). */
  async setPaused(tx: Tx, campaignId: string, reason: string) {
    await tx
      .update(campaigns)
      .set({ status: 'paused', pauseReason: reason, updatedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'running')));
    await tx.delete(campaignDispatch).where(eq(campaignDispatch.campaignId, campaignId));
  }

  async usedInWindow(tx: Tx, portfolioId: string): Promise<number> {
    const [r] = [
      ...(await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from capacity_usage
         where portfolio_id = ${portfolioId} and last_sent_at > now() - interval '24 hours'`)),
    ];
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------------ auxiliares

  private baseQuery(tx: Tx) {
    return tx
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        pauseReason: campaigns.pauseReason,
        listId: campaigns.listId,
        listName: contactLists.name,
        templateId: campaigns.templateId,
        templateName: messageTemplates.name,
        language: messageTemplates.language,
        templateStatus: messageTemplates.status,
        phoneNumberId: campaigns.phoneNumberId,
        displayPhone: phoneNumbers.displayPhoneNumber,
        variables: campaigns.variables,
        audienceSize: campaigns.audienceSize,
        createdAt: campaigns.createdAt,
        startedAt: campaigns.startedAt,
        finishedAt: campaigns.completedAt,
      })
      .from(campaigns)
      .innerJoin(contactLists, eq(contactLists.id, campaigns.listId))
      .innerJoin(messageTemplates, eq(messageTemplates.id, campaigns.templateId))
      .innerJoin(phoneNumbers, eq(phoneNumbers.id, campaigns.phoneNumberId));
  }

  private async counts(tx: Tx, campaignId: string | null): Promise<Map<string, Counts>> {
    const rows = await tx.execute<{ campaign_id: string; status: string; n: number }>(sql`
      select campaign_id, status, count(*)::int as n from campaign_recipients
       ${campaignId ? sql`where campaign_id = ${campaignId}` : sql``}
       group by campaign_id, status`);
    const out = new Map<string, Counts>();
    for (const r of rows) {
      const c = out.get(r.campaign_id) ?? emptyCounts();
      const bucket = BUCKET[r.status];
      if (bucket) c[bucket] += r.n;
      c.total += r.n;
      out.set(r.campaign_id, c);
    }
    return out;
  }

  private view(r: Awaited<ReturnType<CampaignsService['baseQuery']>>[number], counts?: Counts) {
    const c = counts ?? emptyCounts();
    if (r.status === 'draft') c.total = r.audienceSize ?? 0;
    return { ...r, counts: c };
  }

  private async load(tx: Tx, campaignId: string) {
    const [row] = await this.baseQuery(tx).where(eq(campaigns.id, campaignId));
    if (!row) throw new NotFoundException('Campanha não encontrada');
    const counts = await this.counts(tx, campaignId);
    return this.view(row, counts.get(campaignId));
  }

  private async lock(tx: Tx, campaignId: string) {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for('update');
    if (!c) throw new NotFoundException('Campanha não encontrada');
    return c;
  }

  private async phone(tx: Tx, phoneNumberId: string) {
    const [p] = await tx
      .select({
        id: phoneNumbers.id,
        wabaId: phoneNumbers.wabaId,
        status: phoneNumbers.status,
        connectionStatus: metaConnections.status,
      })
      .from(phoneNumbers)
      .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, phoneNumbers.wabaId))
      .leftJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
      .where(eq(phoneNumbers.id, phoneNumberId));
    if (!p) throw new AppError(HttpStatus.NOT_FOUND, 'phone_not_found', 'Número não encontrado');
    return p;
  }

  private async template(tx: Tx, templateId: string) {
    const [t] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, templateId));
    if (!t) throw new AppError(HttpStatus.NOT_FOUND, 'template_not_found', 'Modelo não encontrado');
    return t;
  }

  private checkTemplate(
    tpl: typeof messageTemplates.$inferSelect,
    variables: Record<string, CampaignVariable>,
  ) {
    if (tpl.status !== 'APPROVED') {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'template_not_approved',
        `O modelo "${tpl.name}" não está aprovado pela Meta (status: ${tpl.status})`,
      );
    }
    const a = analyzeTemplate(tpl.components, tpl.parameterFormat, tpl.category);
    if (a.unsupported) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'template_not_supported', a.unsupported);
    }
    const missing = a.placeholders.filter((p) => {
      const v = variables[p];
      if (!v) return true;
      if (v.source === 'fixed') return !v.value?.trim();
      if (v.source === 'attribute') return !v.value?.trim();
      return false;
    });
    if (missing.length) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'variables_missing',
        `Preencha as variáveis do modelo: ${missing.map((m) => `{{${m}}}`).join(', ')}`,
        { missing, placeholders: a.placeholders },
      );
    }
  }

  private badState(status: CampaignStatus, action: string) {
    return new AppError(
      HttpStatus.CONFLICT,
      'invalid_campaign_state',
      `Não é possível ${action} uma campanha com status "${status}"`,
    );
  }

  private async requireTenant(tenantId: string) {
    const [t] = await this.handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw new NotFoundException('Cliente não encontrado');
  }
}
