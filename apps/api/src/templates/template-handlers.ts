import { accountHealth, messageTemplates, orm, type Tx, whatsappAccounts } from '@bm/db';
import { Injectable } from '@nestjs/common';
import type {
  HandlerOutcome,
  WebhookFieldHandler,
  WebhookHandlerContext,
} from '../webhooks/webhook-processor.service';

/**
 * Webhooks de template (docs/10-meta-referencia.md §3.9–3.11, payloads verbatim).
 * `entry.id` = WABA; o template é localizado por `message_template_id` ou por nome + idioma.
 * Template criado fora da plataforma (WhatsApp Manager) entra como registro mínimo; o sync
 * completa os componentes.
 */

const { eq, and } = orm;
type Value = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const idStr = (v: unknown) =>
  typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : undefined;

interface TemplateRef {
  metaTemplateId?: string;
  name?: string;
  language?: string;
}

function refOf(value: Value): TemplateRef {
  return {
    metaTemplateId: idStr(value.message_template_id),
    name: str(value.message_template_name),
    language: str(value.message_template_language),
  };
}

async function findWaba(tx: Tx, metaWabaId: string | null) {
  if (!metaWabaId) return undefined;
  const [w] = await tx
    .select()
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.metaWabaId, metaWabaId))
    .limit(1);
  return w;
}

/** Encontra o template ou cria o registro mínimo (template criado fora da plataforma). */
async function findOrStub(ctx: WebhookHandlerContext, wabaId: string, ref: TemplateRef) {
  const { tx } = ctx;
  if (ref.metaTemplateId) {
    const [byId] = await tx
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.metaTemplateId, ref.metaTemplateId))
      .limit(1);
    if (byId) return byId;
  }
  if (!ref.name || !ref.language) return undefined;
  const [byName] = await tx
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.wabaId, wabaId),
        eq(messageTemplates.name, ref.name),
        eq(messageTemplates.language, ref.language),
      ),
    )
    .limit(1);
  if (byName) {
    if (ref.metaTemplateId && !byName.metaTemplateId) {
      await tx
        .update(messageTemplates)
        .set({ metaTemplateId: ref.metaTemplateId })
        .where(eq(messageTemplates.id, byName.id));
    }
    return byName;
  }
  const [stub] = await tx
    .insert(messageTemplates)
    .values({
      tenantId: ctx.tenantId,
      wabaId,
      metaTemplateId: ref.metaTemplateId ?? null,
      name: ref.name,
      language: ref.language,
      status: 'PENDING',
      components: [],
    })
    .returning();
  return stub;
}

async function health(
  ctx: WebhookHandlerContext,
  templateId: string,
  status: string,
  quality?: string,
) {
  await ctx.tx.insert(accountHealth).values({
    tenantId: ctx.tenantId,
    entityType: 'template',
    entityId: templateId,
    qualityRating: quality ?? null,
    status,
    source: 'webhook',
    signal: { field: ctx.event.field, value: ctx.event.payload.value } as Record<string, unknown>,
  });
}

abstract class TemplateHandler implements WebhookFieldHandler {
  abstract readonly field: string;
  protected abstract apply(
    ctx: WebhookHandlerContext,
    template: { id: string },
    value: Value,
  ): Promise<string>;

  async handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome> {
    const waba = await findWaba(ctx.tx, ctx.event.entryId);
    if (!waba) return { outcome: 'ignored', reason: `WABA não cadastrada: ${ctx.event.entryId}` };
    const value = (ctx.event.payload.value ?? {}) as Value;
    const template = await findOrStub(ctx, waba.id, refOf(value));
    if (!template) return { outcome: 'ignored', reason: 'template sem id nem nome/idioma' };
    const signal = await this.apply(ctx, template, value);
    await health(ctx, template.id, signal, str(value.new_quality_score));
    return { outcome: 'processed' };
  }
}

/** §3.9 — APPROVED, REJECTED, PAUSED, DISABLED, … (o `event` vira o status). */
@Injectable()
export class TemplateStatusHandler extends TemplateHandler {
  readonly field = 'message_template_status_update';

  protected async apply(ctx: WebhookHandlerContext, t: { id: string }, value: Value) {
    const event = str(value.event) ?? 'UNKNOWN';
    const reason = str(value.reason);
    const category = str(value.message_template_category);
    await ctx.tx
      .update(messageTemplates)
      .set({
        status: event,
        rejectionReason: event === 'REJECTED' && reason && reason !== 'NONE' ? reason : null,
        ...(category ? { category } : {}),
        lastStatusAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messageTemplates.id, t.id));
    return `TEMPLATE_${event}`;
  }
}

/** §3.10 — GREEN | YELLOW | RED | UNKNOWN. */
@Injectable()
export class TemplateQualityHandler extends TemplateHandler {
  readonly field = 'message_template_quality_update';

  protected async apply(ctx: WebhookHandlerContext, t: { id: string }, value: Value) {
    const score = str(value.new_quality_score);
    if (score) {
      await ctx.tx
        .update(messageTemplates)
        .set({ qualityScore: score, updatedAt: new Date() })
        .where(eq(messageTemplates.id, t.id));
    }
    return `TEMPLATE_QUALITY_${score ?? 'UNKNOWN'}`;
  }
}

/**
 * §3.11 — dois formatos: aviso prévio (24 h antes: `correct_category`; `new_category` ainda é a
 * atual) e efetivação (`previous_category` → `new_category`).
 */
@Injectable()
export class TemplateCategoryHandler extends TemplateHandler {
  readonly field = 'template_category_update';

  protected async apply(ctx: WebhookHandlerContext, t: { id: string }, value: Value) {
    const previous = str(value.previous_category);
    const next = str(value.new_category);
    if (previous && next) {
      await ctx.tx
        .update(messageTemplates)
        .set({ category: next, previousCategory: previous, updatedAt: new Date() })
        .where(eq(messageTemplates.id, t.id));
      return `TEMPLATE_CATEGORY_${previous}_TO_${next}`;
    }
    const correct = str(value.correct_category);
    return correct ? `TEMPLATE_CATEGORY_NOTICE_${correct}` : 'TEMPLATE_CATEGORY_UPDATE';
  }
}

export const TEMPLATE_WEBHOOK_HANDLERS = [
  TemplateStatusHandler,
  TemplateQualityHandler,
  TemplateCategoryHandler,
];
