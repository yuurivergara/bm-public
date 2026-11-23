import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { CampaignsService } from './campaigns.service';

const variable = z
  .object({
    source: z.enum(['name', 'attribute', 'fixed']),
    value: z.string().trim().max(1024).optional(),
    fallback: z.string().trim().max(1024).optional(),
  })
  .strict();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    listId: z.string().uuid(),
    templateId: z.string().uuid(),
    phoneNumberId: z.string().uuid(),
    variables: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), variable).default({}),
  })
  .strict();

const recipientsQuery = z
  .object({
    status: z
      .enum([
        'pending',
        'sending',
        'accepted',
        'sent',
        'delivered',
        'read',
        'failed',
        'skipped',
        'uncertain',
        'cancelled',
      ])
      .optional(),
    after: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/** Campanhas (S5, docs/04-endpoints.md §1.9) — sempre no contexto de um cliente. */
@Controller('tenants/:tenantId')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('campaigns')
  @RequirePermission('campaigns.read')
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.campaigns.list(tenantId);
  }

  @Post('campaigns')
  @RequirePermission('campaigns.write')
  create(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.campaigns.create(tenantId, body, ctx);
  }

  @Get('campaigns/:campaignId')
  @RequirePermission('campaigns.read')
  get(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.campaigns.get(tenantId, campaignId);
  }

  @Get('campaigns/:campaignId/preview')
  @RequirePermission('campaigns.read')
  preview(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.campaigns.preview(tenantId, campaignId);
  }

  @Get('campaigns/:campaignId/recipients')
  @RequirePermission('campaigns.read')
  recipients(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Query(new ZodPipe(recipientsQuery)) q: z.infer<typeof recipientsQuery>,
  ) {
    return this.campaigns.recipients(tenantId, campaignId, q);
  }

  @Post('campaigns/:campaignId/start')
  @HttpCode(200)
  @RequirePermission('campaigns.write')
  start(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.campaigns.start(tenantId, campaignId, ctx);
  }

  @Post('campaigns/:campaignId/pause')
  @HttpCode(200)
  @RequirePermission('campaigns.write')
  pause(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.campaigns.pause(tenantId, campaignId, ctx);
  }

  @Post('campaigns/:campaignId/resume')
  @HttpCode(200)
  @RequirePermission('campaigns.write')
  resume(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.campaigns.resume(tenantId, campaignId, ctx);
  }

  @Post('campaigns/:campaignId/cancel')
  @HttpCode(200)
  @RequirePermission('campaigns.write')
  cancel(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.campaigns.cancel(tenantId, campaignId, ctx);
  }

  @Get('capacity')
  @RequirePermission('campaigns.read')
  capacity(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.campaigns.capacity(tenantId);
  }
}
