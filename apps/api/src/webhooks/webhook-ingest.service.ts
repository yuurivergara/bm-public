import { createHash } from 'node:crypto';
import { type DbHandle, webhookEvents } from '@bm/db';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/http';
import { DB } from '../core/tokens';

/**
 * Envelope dos webhooks da Meta: { object, entry: [{ id, changes: [{ field, value }] }] }.
 * Validação frouxa de propósito: campos desconhecidos são preservados no payload.
 */
const envelopeSchema = z.object({
  object: z.string().max(100),
  entry: z
    .array(
      z
        .object({
          id: z.string().max(100),
          time: z.number().optional(),
          changes: z
            .array(z.object({ field: z.string().max(100), value: z.unknown() }).passthrough())
            .max(1000)
            .optional(),
        })
        .passthrough(),
    )
    .max(1000),
});

export interface StoredWebhookPayload {
  entryId: string;
  time?: number;
  field: string;
  value: unknown;
}

@Injectable()
export class WebhookIngestService {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  /** Grava um evento por change (assinatura já validada). Responde rápido; processa depois. */
  async ingestMeta(body: unknown): Promise<{ received: number }> {
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_webhook', 'Envelope de webhook inválido');
    }
    const { object, entry } = parsed.data;
    const rows = entry.flatMap((e) =>
      (e.changes ?? []).map((c) => {
        const payload: StoredWebhookPayload = {
          entryId: e.id,
          time: e.time,
          field: c.field,
          value: c.value,
        };
        return {
          source: 'meta' as const,
          object,
          field: c.field,
          entryId: e.id,
          dedupeKey: createHash('sha256')
            .update(`${object}|${e.id}|${c.field}|${JSON.stringify(c.value)}`)
            .digest('hex'),
          payload,
        };
      }),
    );
    if (rows.length) await this.handle.db.insert(webhookEvents).values(rows);
    return { received: rows.length };
  }
}
