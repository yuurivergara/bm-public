import { type CampaignVariable, type DbHandle, orm, type Tx, withTenant } from '@bm/db';
import {
  classifyMetaError,
  type MetaClient,
  MetaNetworkError,
  type SendMessageResult,
} from '@bm/meta-client';
import { decryptSecret, type KeyProvider, maskPhone } from '@bm/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, KEY_PROVIDER, META_CLIENT } from '../core/tokens';
import { CampaignsService, effectiveLimit } from './campaigns.service';
import { analyzeTemplate, resolveParams, type TemplateAnalysis } from './render';

const { sql } = orm;

/** Tentativas por destinatário para erros transitórios. */
const MAX_ATTEMPTS = 5;
/** `sending` mais velho que isso = processo caiu no meio da chamada: não sabemos se a Meta aceitou. */
const STALE_SENDING = '2 minutes';
/** Limite de pares da Meta: 1 mensagem a cada 6 s para o mesmo usuário (docs/10 §5). */
const PAIR_GAP = '6 seconds';
/** Portão de qualidade (docs/02 §6.1): pausa se falhar mais que isso, a partir de MIN_SAMPLE envios. */
const FAIL_RATE = 0.1;
const MIN_SAMPLE = 50;
const CONCURRENCY = 10;

interface Ctx {
  tenantId: string;
  campaignId: string;
  portfolioId: string;
  limit: number | null;
  metaPhoneId: string;
  token: string;
  appSecret?: string;
  template: { name: string; language: string; analysis: TemplateAnalysis };
  variables: Record<string, CampaignVariable>;
}

interface Claimed {
  id: number;
  contactId: string;
  phone: string;
  phoneHash: Buffer;
  name: string | null;
  attributes: Record<string, unknown> | null;
  attempts: number;
}

type Outcome = 'more' | 'idle' | 'waiting_capacity' | 'done' | 'stop';

/**
 * Motor de envio (docs/02-arquitetura.md §4.2, §5, §6): a cada ciclo, para cada campanha em
 * andamento, reserva destinatários dentro do limite de 24 h do portfolio (lock por portfolio),
 * envia até CAMPAIGN_RATE_PER_TICK por número e trata o resultado pelo catálogo de erros.
 * Idempotência: o destinatário vira `sending` antes da chamada; se o processo cair, vira
 * `uncertain` (nunca reenviado sozinho).
 */
@Injectable()
export class CampaignEngine implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CampaignEngine');
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(META_CLIENT) private readonly meta: MetaClient,
    private readonly campaigns: CampaignsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.CAMPAIGN_ENGINE_ENABLED) return;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.tick()
        .catch((err) => this.logger.error(`falha no ciclo: ${(err as Error).message}`))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.config.CAMPAIGN_ENGINE_INTERVAL_MS);
        });
    };
    this.timer = setTimeout(tick, this.config.CAMPAIGN_ENGINE_INTERVAL_MS);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Um ciclo: cada campanha elegível avança um lote. Devolve quantas campanhas rodaram. */
  async tick(): Promise<number> {
    const due = [
      ...(await this.handle.db.execute<{ campaign_id: string; tenant_id: string }>(sql`
        update campaign_dispatch d set lease_until = now() + interval '1 minute'
         where d.campaign_id in (
           select campaign_id from campaign_dispatch
            where next_run_at <= now() and (lease_until is null or lease_until < now())
            order by next_run_at limit 50
            for update skip locked)
        returning d.campaign_id, d.tenant_id`)),
    ];
    for (const d of due) {
      if (this.stopped) break;
      let outcome: Outcome;
      try {
        outcome = await this.step(d.tenant_id, d.campaign_id);
      } catch (err) {
        this.logger.error(`campanha ${d.campaign_id}: ${(err as Error).message}`);
        outcome = 'idle';
      }
      const delay =
        outcome === 'more'
          ? 0
          : outcome === 'waiting_capacity'
            ? 60_000
            : outcome === 'idle'
              ? 2_000
              : 0;
      if (outcome === 'done' || outcome === 'stop') {
        await this.handle.db.execute(
          sql`delete from campaign_dispatch where campaign_id = ${d.campaign_id}`,
        );
      } else {
        await this.handle.db.execute(sql`
          update campaign_dispatch
             set lease_until = null, next_run_at = now() + make_interval(secs => ${delay / 1000})
           where campaign_id = ${d.campaign_id}`);
      }
    }
    return due.length;
  }

  /** Para testes: roda ciclos até nenhuma campanha ter trabalho imediato. */
  async drain(maxTicks = 1000): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      const [r] = [
        ...(await this.handle.db.execute<{ n: number }>(sql`
          select count(*)::int as n from campaign_dispatch where next_run_at <= now()`)),
      ];
      if (!r?.n) return;
      await this.tick();
    }
  }

  // ------------------------------------------------------------------ um lote de uma campanha

  private async step(tenantId: string, campaignId: string): Promise<Outcome> {
    const ctx = await this.context(tenantId, campaignId);
    if (!ctx) return 'stop';
    const { claimed, capacityExhausted, remaining } = await this.reserve(ctx);
    if (!claimed.length) {
      if (remaining === 0) {
        await this.complete(ctx);
        return 'done';
      }
      return capacityExhausted ? 'waiting_capacity' : 'idle';
    }
    let stop = false;
    const queue = [...claimed];
    const worker = async () => {
      for (;;) {
        const r = queue.shift();
        if (!r || stop) {
          if (r) await this.release(ctx, r);
          return;
        }
        const halt = await this.sendOne(ctx, r);
        if (halt) stop = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));
    if (stop) return 'stop';
    if (await this.qualityGate(ctx)) return 'stop';
    return 'more';
  }

  /** Carrega tudo o que o envio precisa; pausa a campanha se algo impede o envio. */
  private async context(tenantId: string, campaignId: string): Promise<Ctx | null> {
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const [c] = [
        ...(await tx.execute<{
          status: string;
          variables: Record<string, CampaignVariable>;
          meta_phone_number_id: string;
          portfolio_id: string;
          tier: string | null;
          limit_value: number | null;
          token_enc: Buffer | null;
          app_secret_enc: Buffer | null;
          conn_status: string | null;
          tpl_name: string;
          tpl_language: string;
          tpl_status: string;
          tpl_components: unknown;
          tpl_format: string | null;
          tpl_category: string | null;
        }>(sql`
          select c.status, c.variables, p.meta_phone_number_id, w.portfolio_id,
                 bp.messaging_limit_tier as tier, bp.messaging_limit_value as limit_value,
                 mc.access_token_enc as token_enc, mc.app_secret_enc, mc.status as conn_status,
                 t.name as tpl_name, t.language as tpl_language, t.status as tpl_status,
                 t.components as tpl_components, t.parameter_format as tpl_format,
                 t.category as tpl_category
            from campaigns c
            join phone_numbers p on p.id = c.phone_number_id
            join whatsapp_accounts w on w.id = p.waba_id
            join business_portfolios bp on bp.id = w.portfolio_id
            left join meta_connections mc on mc.id = w.connection_id
            join message_templates t on t.id = c.template_id
           where c.id = ${campaignId}`)),
      ];
      if (!c || c.status !== 'running') return null;
      // processo caiu durante a chamada à Meta: não sabemos se foi aceita
      await tx.execute(sql`
        update campaign_recipients
           set status = 'uncertain', updated_at = now(),
               error_message = 'envio interrompido: confirme pelo status antes de reenviar'
         where campaign_id = ${campaignId} and status = 'sending'
           and updated_at < now() - ${STALE_SENDING}::interval`);
      if (!c.token_enc || c.conn_status !== 'active') {
        await this.campaigns.setPaused(
          tx,
          campaignId,
          'Conexão com a Meta inativa: reconecte o token do cliente',
        );
        return null;
      }
      if (c.tpl_status !== 'APPROVED') {
        await this.campaigns.setPaused(
          tx,
          campaignId,
          `O modelo deixou de estar aprovado (status: ${c.tpl_status})`,
        );
        return null;
      }
      const analysis = analyzeTemplate(c.tpl_components, c.tpl_format, c.tpl_category);
      return {
        tenantId,
        campaignId,
        portfolioId: c.portfolio_id,
        limit: effectiveLimit(c.tier, c.limit_value, this.config),
        metaPhoneId: c.meta_phone_number_id,
        token: await decryptSecret(Buffer.from(c.token_enc), this.keys),
        appSecret: c.app_secret_enc
          ? await decryptSecret(Buffer.from(c.app_secret_enc), this.keys)
          : undefined,
        template: { name: c.tpl_name, language: c.tpl_language, analysis },
        variables: c.variables,
      };
    });
  }

  /**
   * Reserva atômica (lock por portfolio): destinatário que já recebeu template nas últimas 24 h
   * não consome vaga; os demais só até o limite (usados + em voo).
   */
  private async reserve(ctx: Ctx) {
    return withTenant(this.handle.db, ctx.tenantId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ctx.portfolioId}::text, 7))`,
      );
      let available = Number.POSITIVE_INFINITY;
      if (ctx.limit !== null) {
        const used = await this.campaigns.usedInWindow(tx, ctx.portfolioId);
        const [inflight] = [
          ...(await tx.execute<{ n: number }>(sql`
            select count(*)::int as n
              from campaign_recipients r
              join campaigns c on c.id = r.campaign_id
              join phone_numbers p on p.id = c.phone_number_id
              join whatsapp_accounts w on w.id = p.waba_id
             where w.portfolio_id = ${ctx.portfolioId} and r.status = 'sending'`)),
        ];
        available = ctx.limit - used - (inflight?.n ?? 0);
      }
      const rows = [
        ...(await tx.execute<{
          id: number;
          contact_id: string;
          phone_e164: string;
          phone_hash: Buffer;
          name: string | null;
          attributes: Record<string, unknown> | null;
          attempts: number;
          in_window: boolean;
          pair_blocked: boolean;
        }>(sql`
          select r.id, r.contact_id, c.phone_e164, c.phone_hash, c.name, c.attributes, r.attempts,
                 coalesce(u.last_sent_at > now() - interval '24 hours', false) as in_window,
                 coalesce(u.last_sent_at > now() - ${PAIR_GAP}::interval, false) as pair_blocked
            from campaign_recipients r
            join contacts c on c.id = r.contact_id
            left join capacity_usage u
              on u.portfolio_id = ${ctx.portfolioId} and u.phone_hash = c.phone_hash
           where r.campaign_id = ${ctx.campaignId} and r.status = 'pending'
             and (r.next_attempt_at is null or r.next_attempt_at <= now())
           order by r.id
           limit ${this.config.CAMPAIGN_RATE_PER_TICK}
           for update of r skip locked`)),
      ];
      const chosen: Claimed[] = [];
      const pairDelayed: number[] = [];
      let capacityExhausted = false;
      for (const r of rows) {
        if (r.pair_blocked) {
          pairDelayed.push(Number(r.id));
          continue;
        }
        if (!r.in_window) {
          if (available <= 0) {
            // sem vaga para contato novo; quem já está na janela de 24 h ainda pode ir
            capacityExhausted = true;
            continue;
          }
          available--;
        }
        chosen.push({
          id: Number(r.id),
          contactId: r.contact_id,
          phone: r.phone_e164,
          phoneHash: Buffer.from(r.phone_hash),
          name: r.name,
          attributes: r.attributes,
          attempts: r.attempts + 1,
        });
      }
      if (pairDelayed.length) {
        await tx.execute(sql`
          update campaign_recipients set next_attempt_at = now() + ${PAIR_GAP}::interval
           where id in ${sql.raw(`(${pairDelayed.join(',')})`)}`);
      }
      if (chosen.length) {
        await tx.execute(sql`
          update campaign_recipients
             set status = 'sending', attempts = attempts + 1, updated_at = now()
           where id in ${sql.raw(`(${chosen.map((c) => c.id).join(',')})`)}`);
      }
      const [left] = [
        ...(await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from campaign_recipients
           where campaign_id = ${ctx.campaignId} and status in ('pending', 'sending')`)),
      ];
      return { claimed: chosen, capacityExhausted, remaining: left?.n ?? 0 };
    });
  }

  /** Envia um destinatário e grava o resultado. Devolve true se a campanha deve parar. */
  private async sendOne(ctx: Ctx, r: Claimed): Promise<boolean> {
    const params = resolveParams(ctx.template.analysis, ctx.variables, {
      name: r.name,
      attributes: r.attributes,
    });
    if (!params.ok) {
      await this.finish(ctx, r, { status: 'skipped', errorMessage: params.reason });
      return false;
    }
    let res: SendMessageResult;
    try {
      res = await this.meta.withToken(ctx.token, ctx.appSecret).sendTemplate(ctx.metaPhoneId, {
        to: r.phone,
        name: ctx.template.name,
        language: ctx.template.language,
        bodyParameters: params.params,
      });
    } catch (err) {
      return this.onError(ctx, r, err);
    }
    await withTenant(this.handle.db, ctx.tenantId, async (tx) => {
      await tx.execute(sql`
        update campaign_recipients
           set status = 'accepted', wamid = ${res.wamid}, sent_at = now(), error_code = null,
               error_message = ${res.messageStatus === 'held_for_quality_assessment' ? 'retida pela Meta para avaliação de qualidade (pacing)' : null},
               updated_at = now()
         where id = ${r.id} and status = 'sending'`);
      await tx.execute(sql`
        insert into capacity_usage (portfolio_id, tenant_id, phone_hash, last_sent_at)
        values (${ctx.portfolioId}, ${ctx.tenantId}, ${r.phoneHash}, now())
        on conflict (portfolio_id, phone_hash) do update set last_sent_at = excluded.last_sent_at`);
    });
    return false;
  }

  private async onError(ctx: Ctx, r: Claimed, err: unknown): Promise<boolean> {
    if (err instanceof MetaNetworkError && err.ambiguous) {
      await this.finish(ctx, r, {
        status: 'uncertain',
        errorMessage: 'tempo esgotado: a Meta pode ter aceitado; não reenviado automaticamente',
      });
      return false;
    }
    const info = classifyMetaError(err);
    const code = info.code;
    const message = `${info.description}${code ? ` (código ${code})` : ''}`;
    const backoff = (base: number) => Math.min(base * 2 ** (r.attempts - 1), 600);
    switch (info.action) {
      case 'retry':
      case 'retry_slower':
      case 'reschedule_recipient': {
        if (r.attempts >= MAX_ATTEMPTS) {
          await this.finish(ctx, r, { status: 'failed', code, errorMessage: message });
          return false;
        }
        const secs = info.action === 'reschedule_recipient' ? 4 ** r.attempts : backoff(5);
        await withTenant(this.handle.db, ctx.tenantId, (tx) =>
          tx.execute(sql`
            update campaign_recipients
               set status = 'pending', next_attempt_at = now() + make_interval(secs => ${secs}),
                   error_code = ${code}, error_message = ${message}, updated_at = now()
             where id = ${r.id} and status = 'sending'`),
        );
        return false;
      }
      case 'skip_recipient':
        await this.finish(ctx, r, { status: 'skipped', code, errorMessage: message });
        return false;
      case 'suppress_contact':
        await this.finish(ctx, r, {
          status: 'skipped',
          code,
          errorMessage: message,
          suppress: true,
        });
        return false;
      case 'fail_recipient':
        await this.finish(ctx, r, {
          status: 'failed',
          code,
          errorMessage: message,
          markInvalid: code === 131026,
        });
        return false;
      case 'pause_tenant':
      case 'reconnect':
        await this.release(ctx, r);
        await this.pauseTenant(ctx, message, info.action === 'reconnect');
        return true;
      default:
        // pause_campaign, pause_campaign_sync_template, fix_request, uncertain sem rede
        await this.release(ctx, r);
        await withTenant(this.handle.db, ctx.tenantId, (tx) =>
          this.campaigns.setPaused(tx, ctx.campaignId, `Pausada automaticamente: ${message}`),
        );
        this.logger.warn(`campanha ${ctx.campaignId} pausada: ${message}`);
        return true;
    }
  }

  private async finish(
    ctx: Ctx,
    r: Claimed,
    o: {
      status: 'failed' | 'skipped' | 'uncertain';
      code?: number | null;
      errorMessage: string;
      suppress?: boolean;
      markInvalid?: boolean;
    },
  ) {
    await withTenant(this.handle.db, ctx.tenantId, async (tx) => {
      await tx.execute(sql`
        update campaign_recipients
           set status = ${o.status}, error_code = ${o.code ?? null}, error_message = ${o.errorMessage},
               failed_at = ${o.status === 'failed' ? sql`now()` : sql`failed_at`}, updated_at = now()
         where id = ${r.id} and status = 'sending'`);
      if (o.suppress) {
        await suppressContact(
          tx,
          ctx.tenantId,
          r.phoneHash,
          maskPhone(r.phone),
          'marketing_opt_out',
        );
      }
      if (o.markInvalid) {
        await tx.execute(sql`update contacts set invalid_at = now() where id = ${r.contactId}`);
      }
    });
  }

  /** Devolve à fila sem gastar tentativa (campanha vai pausar). */
  private async release(ctx: Ctx, r: Claimed) {
    await withTenant(this.handle.db, ctx.tenantId, (tx) =>
      tx.execute(sql`
        update campaign_recipients set status = 'pending', attempts = greatest(attempts - 1, 0),
               updated_at = now()
         where id = ${r.id} and status = 'sending'`),
    );
  }

  private async pauseTenant(ctx: Ctx, message: string, reconnect: boolean) {
    await withTenant(this.handle.db, ctx.tenantId, async (tx) => {
      if (reconnect) {
        await tx.execute(sql`
          update meta_connections mc set status = 'broken', updated_at = now(),
                 last_error = ${JSON.stringify({ message, at: new Date().toISOString() })}::jsonb
            from whatsapp_accounts w join phone_numbers p on p.waba_id = w.id
           where w.connection_id = mc.id and p.meta_phone_number_id = ${ctx.metaPhoneId}`);
      }
      const running = await tx.execute<{ id: string }>(
        sql`select id from campaigns where status = 'running'`,
      );
      for (const c of running) {
        await this.campaigns.setPaused(tx, c.id, `Pausada automaticamente (cliente): ${message}`);
      }
    });
    this.logger.warn(`cliente ${ctx.tenantId}: campanhas pausadas — ${message}`);
  }

  /** Portão simples: falhas acima de 10% (com amostra mínima) pausam a campanha. */
  private async qualityGate(ctx: Ctx): Promise<boolean> {
    return withTenant(this.handle.db, ctx.tenantId, async (tx) => {
      const [r] = [
        ...(await tx.execute<{ attempted: number; failed: number }>(sql`
          select count(*) filter (where status in ('accepted','sent','delivered','read','failed'))::int as attempted,
                 count(*) filter (where status = 'failed')::int as failed
            from campaign_recipients where campaign_id = ${ctx.campaignId}`)),
      ];
      if (!r || r.attempted < MIN_SAMPLE || r.failed / r.attempted <= FAIL_RATE) return false;
      await this.campaigns.setPaused(
        tx,
        ctx.campaignId,
        `Pausada automaticamente: ${Math.round((100 * r.failed) / r.attempted)}% de falhas (limite 10%). Revise a lista e o modelo antes de retomar.`,
      );
      return true;
    });
  }

  private async complete(ctx: Ctx) {
    await withTenant(this.handle.db, ctx.tenantId, (tx) =>
      tx.execute(sql`
        update campaigns set status = 'completed', completed_at = now(), updated_at = now()
         where id = ${ctx.campaignId} and status = 'running'`),
    );
  }
}

/**
 * Supressão automática (opt-out): grava, tira o contato das listas e cancela envios pendentes
 * dele em todas as campanhas do cliente. Idempotente.
 */
export async function suppressContact(
  tx: Tx,
  tenantId: string,
  phoneHash: Buffer,
  phoneMasked: string,
  reason: 'opt_out_keyword' | 'opt_out_button' | 'marketing_opt_out',
): Promise<boolean> {
  const inserted = await tx.execute(sql`
    insert into suppressions (tenant_id, phone_hash, phone_masked, reason)
    values (${tenantId}, ${phoneHash}, ${phoneMasked}, ${reason})
    on conflict do nothing`);
  await tx.execute(sql`
    update campaign_recipients r set status = 'skipped', error_message = 'contato pediu para sair (opt-out)',
           updated_at = now()
      from contacts c
     where c.id = r.contact_id and c.tenant_id = ${tenantId} and c.phone_hash = ${phoneHash}
       and r.status = 'pending'`);
  const removed = await tx.execute<{ list_id: string }>(sql`
    delete from contact_list_members m using contacts c
     where c.id = m.contact_id and c.tenant_id = ${tenantId} and c.phone_hash = ${phoneHash}
    returning m.list_id`);
  for (const { list_id } of removed) {
    await tx.execute(
      sql`update contact_lists set size = greatest(size - 1, 0) where id = ${list_id}`,
    );
  }
  return Number((inserted as unknown as { count?: number }).count ?? 0) > 0;
}
