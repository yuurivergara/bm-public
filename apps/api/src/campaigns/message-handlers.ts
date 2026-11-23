import { orm } from '@bm/db';
import { classifyMetaError, MetaApiError } from '@bm/meta-client';
import { hashPhone, maskPhone, normalizePhone } from '@bm/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { OPT_OUT_LABEL } from '../templates/templates.service';
import type {
  HandlerOutcome,
  WebhookFieldHandler,
  WebhookHandlerContext,
} from '../webhooks/webhook-processor.service';
import { suppressContact } from './campaign-engine.service';
import { CampaignsService } from './campaigns.service';

const { sql } = orm;
type Value = Record<string, unknown>;
const PROCESSED: HandlerOutcome = { outcome: 'processed' };

/** Ordem dos status: nunca regredir (webhooks podem chegar fora de ordem, docs/10 §2.3). */
const RANK: Record<string, number> = {
  pending: 0,
  sending: 1,
  uncertain: 1,
  accepted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
};

/**
 * Palavras de saída numa mensagem de texto. Mais estrito que o rótulo do botão: a mensagem inteira
 * (sem acento/pontuação) precisa ser a palavra-chave, para "parece bom" não virar opt-out.
 */
const KEYWORDS = new Set([
  'sair',
  'parar',
  'pare',
  'stop',
  'cancelar',
  'descadastrar',
  'nao quero',
  'nao quero mais',
  'nao quero receber',
  'remover',
  'unsubscribe',
]);

export function isOptOutText(text: string): boolean {
  const norm = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return KEYWORDS.has(norm);
}

/** `messages`: status das mensagens enviadas (§3.1) e mensagens recebidas (§3.2). */
@Injectable()
export class MessagesHandler implements WebhookFieldHandler {
  readonly field = 'messages';
  private readonly logger = new Logger('MessagesHandler');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly campaigns: CampaignsService,
  ) {}

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const value = (ctx.event.payload.value ?? {}) as Value;
    const statuses = Array.isArray(value.statuses) ? (value.statuses as Value[]) : [];
    const messages = Array.isArray(value.messages) ? (value.messages as Value[]) : [];
    for (const st of statuses) await this.status(ctx, st);
    for (const m of messages) await this.inbound(ctx, m);
    if (!statuses.length && !messages.length) {
      return { outcome: 'ignored', reason: 'messages sem statuses nem messages' };
    }
    return PROCESSED;
  }

  private async status(ctx: WebhookHandlerContext, st: Value) {
    const wamid = typeof st.id === 'string' ? st.id : undefined;
    const status = typeof st.status === 'string' ? st.status : undefined;
    if (!wamid || !status) return;
    const at = (
      Number(st.timestamp) > 0 ? new Date(Number(st.timestamp) * 1000) : new Date()
    ).toISOString();
    const [r] = [
      ...(await ctx.tx.execute<{
        id: number;
        status: string;
        campaign_id: string;
        contact_id: string;
        phone_e164: string;
        phone_hash: Buffer;
      }>(sql`
        select r.id, r.status, r.campaign_id, r.contact_id, c.phone_e164, c.phone_hash
          from campaign_recipients r join contacts c on c.id = r.contact_id
         where r.wamid = ${wamid}
         for update of r`)),
    ];
    if (!r) return; // mensagem enviada fora da plataforma
    if (status === 'failed') {
      if (r.status === 'delivered' || r.status === 'read') return;
      const err = (Array.isArray(st.errors) ? st.errors[0] : undefined) as Value | undefined;
      const code = Number(err?.code) || null;
      const info = classifyMetaError(
        new MetaApiError({
          message: String(err?.title ?? err?.message ?? 'failed'),
          code,
          subcode: null,
          type: null,
          httpStatus: 200,
          fbtraceId: null,
          errorData: err?.error_data,
        }),
      );
      await ctx.tx.execute(sql`
        update campaign_recipients
           set status = 'failed', failed_at = ${at}::timestamptz, error_code = ${code},
               error_message = ${`${info.description}${code ? ` (código ${code})` : ''}`}, updated_at = now()
         where id = ${r.id}`);
      if (info.action === 'suppress_contact') {
        await suppressContact(
          ctx.tx,
          ctx.tenantId,
          Buffer.from(r.phone_hash),
          maskPhone(r.phone_e164),
          'marketing_opt_out',
        );
      } else if (code === 131026) {
        await ctx.tx.execute(
          sql`update contacts set invalid_at = now() where id = ${r.contact_id}`,
        );
      } else if (
        ['pause_campaign', 'pause_campaign_sync_template', 'pause_tenant'].includes(info.action)
      ) {
        await this.campaigns.setPaused(
          ctx.tx,
          r.campaign_id,
          `Pausada automaticamente: ${info.description} (código ${code})`,
        );
        this.logger.warn(`campanha ${r.campaign_id} pausada por webhook: código ${code}`);
      }
      return;
    }
    const target = RANK[status];
    if (target === undefined || (RANK[r.status] ?? 99) >= target) return;
    await ctx.tx.execute(sql`
      update campaign_recipients
         set status = ${status},
             sent_at = coalesce(sent_at, ${at}::timestamptz),
             delivered_at = ${status === 'sent' ? sql`delivered_at` : sql`coalesce(delivered_at, ${at}::timestamptz)`},
             read_at = ${status === 'read' ? sql`${at}::timestamptz` : sql`read_at`},
             error_message = case when status = 'uncertain' then null else error_message end,
             updated_at = now()
       where id = ${r.id}`);
  }

  private async inbound(ctx: WebhookHandlerContext, m: Value) {
    const from = typeof m.from === 'string' ? m.from : undefined;
    if (!from) return;
    let reason: 'opt_out_keyword' | 'opt_out_button' | undefined;
    if (m.type === 'button') {
      const b = (m.button ?? {}) as Value;
      const label = `${String(b.text ?? '')} ${String(b.payload ?? '')}`;
      if (OPT_OUT_LABEL.test(label)) reason = 'opt_out_button';
    } else if (m.type === 'interactive') {
      const reply = ((m.interactive ?? {}) as Value).button_reply as Value | undefined;
      if (reply && OPT_OUT_LABEL.test(String(reply.title ?? ''))) reason = 'opt_out_button';
    } else if (m.type === 'text') {
      const body = String(((m.text ?? {}) as Value).body ?? '');
      if (isOptOutText(body)) reason = 'opt_out_keyword';
    }
    if (!reason) return;
    const n = normalizePhone(`+${from.replace(/\D/g, '')}`);
    if (!n.ok) return;
    const created = await suppressContact(
      ctx.tx,
      ctx.tenantId,
      hashPhone(n.e164, this.config.PHONE_HASH_PEPPER, ctx.tenantId),
      maskPhone(n.e164),
      reason,
    );
    if (created) this.logger.log(`opt-out de ${maskPhone(n.e164)} (${reason})`);
  }
}

/** `user_preferences` (§3.3): usuário parou as mensagens de marketing pelo próprio WhatsApp. */
@Injectable()
export class UserPreferencesHandler implements WebhookFieldHandler {
  readonly field = 'user_preferences';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const value = (ctx.event.payload.value ?? {}) as Value;
    const prefs = Array.isArray(value.user_preferences) ? (value.user_preferences as Value[]) : [];
    let stops = 0;
    for (const p of prefs) {
      // "resume" não desfaz: a supressão da plataforma é permanente (só sai por decisão manual).
      if (p.category !== 'marketing_messages' || p.value !== 'stop') continue;
      const waId = typeof p.wa_id === 'string' ? p.wa_id : undefined;
      if (!waId) continue;
      const n = normalizePhone(`+${waId.replace(/\D/g, '')}`);
      if (!n.ok) continue;
      await suppressContact(
        ctx.tx,
        ctx.tenantId,
        hashPhone(n.e164, this.config.PHONE_HASH_PEPPER, ctx.tenantId),
        maskPhone(n.e164),
        'marketing_opt_out',
      );
      stops++;
    }
    return stops ? PROCESSED : { outcome: 'ignored', reason: 'sem pedido de parada de marketing' };
  }
}

export const MESSAGE_WEBHOOK_HANDLERS = [MessagesHandler, UserPreferencesHandler];
