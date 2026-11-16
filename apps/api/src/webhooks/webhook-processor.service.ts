import { type DbHandle, metaAssetRoutes, orm, type Tx, withTenant } from '@bm/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB } from '../core/tokens';
import type { StoredWebhookPayload } from './webhook-ingest.service';

const { eq, sql } = orm;

export const MAX_ATTEMPTS = 8;
/** Lease de um evento em processamento; após isso ele volta a ser elegível (processo caiu). */
const LEASE = '5 minutes';
const DEDUPE_WINDOW = '7 days';

export interface ClaimedEvent {
  id: number;
  /** Valor exato do Postgres (com microssegundos): parte da chave da tabela particionada. */
  receivedAt: string;
  field: string | null;
  entryId: string | null;
  object: string | null;
  dedupeKey: string;
  attempts: number;
  payload: StoredWebhookPayload;
}

export type HandlerOutcome = { outcome: 'processed' } | { outcome: 'ignored'; reason: string };

export interface WebhookHandlerContext {
  tx: Tx;
  tenantId: string;
  event: ClaimedEvent;
}

/** Handler de um campo de webhook. Executa dentro da transação do tenant (RLS). */
export interface WebhookFieldHandler {
  readonly field: string;
  handle(ctx: WebhookHandlerContext): Promise<HandlerOutcome>;
}

export const WEBHOOK_HANDLERS = Symbol('WEBHOOK_HANDLERS');

export interface BatchResult {
  processed: number;
  ignored: number;
  failed: number;
  dead: number;
}

@Injectable()
export class WebhookProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WebhookProcessor');
  private readonly handlers: Map<string, WebhookFieldHandler>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WEBHOOK_HANDLERS) handlers: WebhookFieldHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.field, h]));
  }

  onApplicationBootstrap() {
    if (!this.config.WEBHOOK_PROCESSOR_ENABLED) return;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.drain()
        .catch((err) => this.logger.error(`falha no ciclo: ${(err as Error).message}`))
        .finally(() => {
          if (!this.stopped)
            this.timer = setTimeout(tick, this.config.WEBHOOK_PROCESSOR_INTERVAL_MS);
        });
    };
    this.timer = setTimeout(tick, this.config.WEBHOOK_PROCESSOR_INTERVAL_MS);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Processa lotes até esvaziar a fila elegível. */
  async drain(batchSize = 50): Promise<BatchResult> {
    const total: BatchResult = { processed: 0, ignored: 0, failed: 0, dead: 0 };
    for (;;) {
      const r = await this.processBatch(batchSize);
      for (const k of Object.keys(total) as (keyof BatchResult)[]) total[k] += r[k];
      if (r.processed + r.ignored + r.failed + r.dead < batchSize || this.stopped) return total;
    }
  }

  async processBatch(limit = 50): Promise<BatchResult> {
    const result: BatchResult = { processed: 0, ignored: 0, failed: 0, dead: 0 };
    for (const event of await this.claim(limit)) {
      const outcome = await this.processOne(event);
      result[outcome]++;
    }
    return result;
  }

  private async claim(limit: number): Promise<ClaimedEvent[]> {
    const rows = await this.handle.db.execute<{
      id: string;
      received_at: string;
      field: string | null;
      entry_id: string | null;
      object: string | null;
      dedupe_key: string;
      attempts: number;
      payload: StoredWebhookPayload;
    }>(sql`
      with c as (
        select id, received_at from webhook_events
        where status in ('queued', 'failed', 'processing') and next_attempt_at <= now()
        order by next_attempt_at
        limit ${limit}
        for update skip locked
      )
      update webhook_events w
         set status = 'processing', attempts = w.attempts + 1,
             next_attempt_at = now() + ${LEASE}::interval
        from c
       where w.id = c.id and w.received_at = c.received_at
      returning w.id, w.received_at::text as received_at, w.field, w.entry_id, w.object, w.dedupe_key, w.attempts, w.payload`);
    return [...rows].map((r) => ({
      id: Number(r.id),
      receivedAt: r.received_at,
      field: r.field,
      entryId: r.entry_id,
      object: r.object,
      dedupeKey: r.dedupe_key,
      attempts: r.attempts,
      payload: r.payload,
    }));
  }

  private async processOne(event: ClaimedEvent): Promise<keyof BatchResult> {
    try {
      const outcome = await this.route(event);
      if (outcome.outcome === 'processed') {
        await this.finish(event, 'processed', null);
        return 'processed';
      }
      await this.finish(event, 'ignored', outcome.reason);
      return 'ignored';
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'erro desconhecido';
      if (event.attempts >= MAX_ATTEMPTS) {
        this.logger.error(
          `evento ${event.id} (${event.field}) descartado após ${event.attempts} tentativas: ${message}`,
        );
        await this.finish(event, 'dead', message);
        return 'dead';
      }
      const backoffMin = Math.min(2 ** (event.attempts - 1), 60);
      this.logger.warn(
        `evento ${event.id} (${event.field}) falhou (tentativa ${event.attempts}): ${message}`,
      );
      await this.handle.db.execute(sql`
        update webhook_events set status = 'failed', error = ${message},
               next_attempt_at = now() + make_interval(mins => ${backoffMin})
         where id = ${event.id} and received_at = ${event.receivedAt}::timestamptz`);
      return 'failed';
    }
  }

  private async route(event: ClaimedEvent): Promise<HandlerOutcome> {
    const handler = event.field ? this.handlers.get(event.field) : undefined;
    if (!handler) return { outcome: 'ignored', reason: `sem handler para o campo ${event.field}` };

    const dup = await this.handle.db.execute<{ one: number }>(sql`
      select 1 as one from webhook_events
       where dedupe_key = ${event.dedupeKey} and status = 'processed'
         and received_at > now() - ${DEDUPE_WINDOW}::interval
         and not (id = ${event.id} and received_at = ${event.receivedAt}::timestamptz)
       limit 1`);
    if ([...dup].length) return { outcome: 'ignored', reason: 'duplicado' };

    const tenantId = await this.resolveTenant(event);
    if (!tenantId) {
      return { outcome: 'ignored', reason: `ativo desconhecido: ${event.entryId}` };
    }
    return withTenant(this.handle.db, tenantId, (tx) => handler.handle({ tx, tenantId, event }));
  }

  /** O entry.id dos webhooks de WABA é o ID da WABA; mapeado em meta_asset_routes. */
  private async resolveTenant(event: ClaimedEvent): Promise<string | null> {
    if (!event.entryId) return null;
    const [route] = await this.handle.db
      .select({ tenantId: metaAssetRoutes.tenantId })
      .from(metaAssetRoutes)
      .where(eq(metaAssetRoutes.metaId, event.entryId))
      .limit(1);
    return route?.tenantId ?? null;
  }

  private async finish(
    event: ClaimedEvent,
    status: 'processed' | 'ignored' | 'dead',
    error: string | null,
  ) {
    await this.handle.db.execute(sql`
      update webhook_events set status = ${status}, error = ${error}, processed_at = now()
       where id = ${event.id} and received_at = ${event.receivedAt}::timestamptz`);
  }
}
