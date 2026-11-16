import { verifyMetaSignature } from '@bm/meta-client';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators';
import { AppError } from '../common/http';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { WebhookIngestService } from './webhook-ingest.service';

/**
 * Webhooks da Meta (docs/04-endpoints.md §2.1, docs/10-meta-referencia.md).
 * GET: desafio de verificação. POST: valida X-Hub-Signature-256 sobre o corpo bruto,
 * grava os eventos e responde 200 rápido; o processamento é assíncrono.
 */
@Controller('webhooks/meta')
@Public()
export class MetaWebhooksController {
  private readonly logger = new Logger('MetaWebhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ingest: WebhookIngestService,
  ) {}

  @Get()
  verify(@Query() q: Record<string, string | undefined>, @Res() reply: FastifyReply) {
    const expected = this.config.META_WEBHOOK_VERIFY_TOKEN;
    if (
      expected &&
      q['hub.mode'] === 'subscribe' &&
      q['hub.verify_token'] === expected &&
      typeof q['hub.challenge'] === 'string'
    ) {
      return reply.status(200).type('text/plain').send(q['hub.challenge']);
    }
    return reply.status(403).type('text/plain').send('forbidden');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const secret = this.config.META_APP_SECRET;
    if (!secret) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'webhooks_not_configured',
        'META_APP_SECRET não configurado',
      );
    }
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, signature, secret)) {
      this.logger.warn('webhook Meta com assinatura ausente ou inválida');
      throw new AppError(HttpStatus.UNAUTHORIZED, 'invalid_signature', 'Assinatura inválida');
    }
    return this.ingest.ingestMeta(req.body);
  }
}
