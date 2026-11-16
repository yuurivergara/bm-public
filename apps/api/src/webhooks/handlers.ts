import {
  accountHealth,
  businessPortfolios,
  type HealthEntity,
  orm,
  phoneNumbers,
  type Tx,
  type WabaStatus,
  whatsappAccounts,
} from '@bm/db';
import { displayToE164, messagingLimitValue } from '@bm/meta-client';
import { Injectable } from '@nestjs/common';
import type {
  HandlerOutcome,
  WebhookFieldHandler,
  WebhookHandlerContext,
} from './webhook-processor.service';

/**
 * Handlers dos campos de webhook de ativos (S2). Payloads conforme docs/10-meta-referencia.md §3
 * (exemplos verbatim da documentação oficial). `entry.id` = ID da WABA/Messaging account.
 * `messages`, `user_preferences` e templates entram nas semanas seguintes (S3/S4).
 */

const { eq, and } = orm;
type Value = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

async function findWaba(tx: Tx, metaWabaId: string) {
  const [w] = await tx
    .select()
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.metaWabaId, metaWabaId))
    .limit(1);
  return w;
}

async function findPhoneByDisplay(tx: Tx, wabaRowId: string, display: unknown) {
  const e164 = displayToE164(str(display));
  if (!e164) return undefined;
  const [p] = await tx
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.wabaId, wabaRowId), eq(phoneNumbers.phoneE164, e164)))
    .limit(1);
  return p;
}

async function health(
  ctx: WebhookHandlerContext,
  entityType: HealthEntity,
  entityId: string,
  data: { qualityRating?: string | null; status?: string | null },
) {
  await ctx.tx.insert(accountHealth).values({
    tenantId: ctx.tenantId,
    entityType,
    entityId,
    qualityRating: data.qualityRating ?? null,
    status: data.status ?? null,
    source: 'webhook',
    signal: { field: ctx.event.field, value: ctx.event.payload.value } as Record<string, unknown>,
  });
}

const PROCESSED: HandlerOutcome = { outcome: 'processed' };
const unknownWaba = (id: string | null): HandlerOutcome => ({
  outcome: 'ignored',
  reason: `WABA não cadastrada: ${id}`,
});

/** Normaliza o limite: string TIER_* ou número (o exemplo oficial traz 2000; legado usa -1 = ilimitado). */
export function normalizeLimitTier(v: unknown): string | null {
  if (typeof v === 'string' && /^TIER_|^UNTIERED$/.test(v)) return v;
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null;
  if (n === null) return null;
  const map: Record<number, string> = {
    [-1]: 'TIER_UNLIMITED',
    50: 'TIER_50',
    250: 'TIER_250',
    1000: 'TIER_1K',
    2000: 'TIER_2K',
    10000: 'TIER_10K',
    100000: 'TIER_100K',
  };
  return map[n] ?? null;
}

/** §3.7 — restrições, violações, banimento, desligamento. */
@Injectable()
export class AccountUpdateHandler implements WebhookFieldHandler {
  readonly field = 'account_update';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const value = (ctx.event.payload.value ?? {}) as Value;
    const event = str(value.event);
    let status: WabaStatus | undefined;
    let restrictionInfo: unknown;

    switch (event) {
      case 'ACCOUNT_RESTRICTION': {
        const info = Array.isArray(value.restriction_info) ? value.restriction_info : [];
        status = info.length ? 'restricted' : 'active';
        restrictionInfo = info.length ? info : null;
        break;
      }
      case 'DISABLED_UPDATE': {
        const state = str((value.ban_info as Value | undefined)?.waba_ban_state);
        if (state === 'DISABLE') status = 'disabled';
        else if (state === 'REINSTATE') status = 'active';
        restrictionInfo = value.ban_info ?? null;
        break;
      }
      case 'ACCOUNT_DELETED':
      case 'ACCOUNT_OFFBOARDED':
        status = 'disabled';
        break;
      case 'ACCOUNT_RECONNECTED':
        status = 'active';
        break;
      default:
        // ACCOUNT_VIOLATION, PARTNER_*, etc.: registra o sinal sem mudar o status.
        break;
    }

    if (status !== undefined) {
      await ctx.tx
        .update(whatsappAccounts)
        .set({
          status,
          ...(restrictionInfo !== undefined ? { restrictionInfo } : {}),
          updatedAt: new Date(),
        })
        .where(eq(whatsappAccounts.id, waba.id));
    }
    await health(ctx, 'waba', waba.id, { status: event ?? null });
    return PROCESSED;
  }
}

/** §3.8 — decisão da revisão da conta. */
@Injectable()
export class AccountReviewUpdateHandler implements WebhookFieldHandler {
  readonly field = 'account_review_update';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const decision = str(((ctx.event.payload.value ?? {}) as Value).decision);
    if (!decision) return { outcome: 'ignored', reason: 'sem decision' };
    await ctx.tx
      .update(whatsappAccounts)
      .set({ accountReviewStatus: decision, updatedAt: new Date() })
      .where(eq(whatsappAccounts.id, waba.id));
    await health(ctx, 'waba', waba.id, { status: `REVIEW_${decision}` });
    return PROCESSED;
  }
}

/** §3.5 — limite de mensagens do portfolio (e limite de números). */
@Injectable()
export class BusinessCapabilityUpdateHandler implements WebhookFieldHandler {
  readonly field = 'business_capability_update';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const value = (ctx.event.payload.value ?? {}) as Value;
    const tier =
      normalizeLimitTier(value.max_daily_conversations_per_business) ??
      normalizeLimitTier(value.max_daily_conversation_per_phone);
    if (tier) {
      await ctx.tx
        .update(businessPortfolios)
        .set({
          messagingLimitTier: tier,
          messagingLimitValue: messagingLimitValue(tier),
          limitSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(businessPortfolios.id, waba.portfolioId));
    }
    await health(ctx, 'portfolio', waba.portfolioId, {
      status: tier ? `LIMIT_${tier}` : 'CAPABILITY_UPDATE',
    });
    return PROCESSED;
  }
}

/** §3.4 — hoje trata de throughput (ONBOARDING/THROUGHPUT_UPGRADE); legado traz limite. */
@Injectable()
export class PhoneNumberQualityUpdateHandler implements WebhookFieldHandler {
  readonly field = 'phone_number_quality_update';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const value = (ctx.event.payload.value ?? {}) as Value;
    const phone = await findPhoneByDisplay(ctx.tx, waba.id, value.display_phone_number);
    if (!phone)
      return {
        outcome: 'ignored',
        reason: `número não cadastrado: ${str(value.display_phone_number)}`,
      };
    const tier =
      normalizeLimitTier(value.max_daily_conversations_per_business) ??
      normalizeLimitTier(value.current_limit);
    if (tier) {
      await ctx.tx
        .update(phoneNumbers)
        .set({ messagingLimitTier: tier, updatedAt: new Date() })
        .where(eq(phoneNumbers.id, phone.id));
    }
    await health(ctx, 'phone_number', phone.id, {
      qualityRating: phone.qualityRating,
      status: str(value.event) ?? 'QUALITY_UPDATE',
    });
    return PROCESSED;
  }
}

/** §3.12 — resultado da verificação do nome exibido. */
@Injectable()
export class PhoneNumberNameUpdateHandler implements WebhookFieldHandler {
  readonly field = 'phone_number_name_update';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const value = (ctx.event.payload.value ?? {}) as Value;
    const phone = await findPhoneByDisplay(ctx.tx, waba.id, value.display_phone_number);
    if (!phone)
      return {
        outcome: 'ignored',
        reason: `número não cadastrado: ${str(value.display_phone_number)}`,
      };
    const decision = str(value.decision);
    const requested = str(value.requested_verified_name);
    await ctx.tx
      .update(phoneNumbers)
      .set({
        ...(decision ? { nameStatus: decision } : {}),
        ...(decision === 'APPROVED' && requested ? { verifiedName: requested } : {}),
        // §10.4: após aprovação de nome, o número registrado precisa de novo register em até 14 dias
        ...(decision === 'APPROVED' && phone.registrationStatus === 'registered'
          ? { registrationError: 'Nome aprovado: re-registre o número em até 14 dias' }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(phoneNumbers.id, phone.id));
    const reregister = decision === 'APPROVED' && phone.registrationStatus === 'registered';
    await health(ctx, 'phone_number', phone.id, {
      status: reregister ? 'NAME_APPROVED_REREGISTER_NEEDED' : `NAME_${decision ?? 'UPDATE'}`,
    });
    return PROCESSED;
  }
}

/** §3.6 — alertas da conta (limite negado/adiado, OBA, foto do perfil): só registra o sinal. */
@Injectable()
export class AccountAlertsHandler implements WebhookFieldHandler {
  readonly field = 'account_alerts';

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId ?? '');
    if (!waba) return unknownWaba(ctx.event.entryId);
    const info = (((ctx.event.payload.value ?? {}) as Value).alert_info ?? {}) as Value;
    await health(ctx, 'waba', waba.id, { status: str(info.alert_type) ?? 'ACCOUNT_ALERT' });
    return PROCESSED;
  }
}

export const ASSET_WEBHOOK_HANDLERS = [
  AccountUpdateHandler,
  AccountReviewUpdateHandler,
  BusinessCapabilityUpdateHandler,
  PhoneNumberQualityUpdateHandler,
  PhoneNumberNameUpdateHandler,
  AccountAlertsHandler,
];
