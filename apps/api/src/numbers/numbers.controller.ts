import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { NumbersService } from './numbers.service';

const providerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    apiKind: z.enum(['manual', 'sms_webhook', 'voice_transcription']).default('manual'),
  })
  .strict();

const inventorySchema = z
  .object({
    providerId: z.string().uuid(),
    phone: z.string().trim().min(8).max(20),
    monthlyCostBrl: z.number().min(0).max(100_000),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();

const inventoryQuery = z.object({
  status: z.enum(['available', 'verifying', 'active', 'quarantine', 'cancelled']).optional(),
});

const assignSchema = z
  .object({
    wabaId: z.string().uuid(),
    inventoryId: z.string().uuid().optional(),
    verifiedName: z.string().trim().min(3).max(120),
  })
  .strict();

const requestCodeSchema = z
  .object({
    method: z.enum(['SMS', 'VOICE']).default('SMS'),
    language: z
      .string()
      .regex(/^[a-z]{2}(_[A-Z]{2})?$/)
      .default('pt_BR'),
  })
  .strict();

const verifySchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Código de 6 dígitos'),
  })
  .strict();

const releaseSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** Estoque de números (docs/04-endpoints.md §1.6). */
@Controller()
export class NumbersController {
  constructor(private readonly numbers: NumbersService) {}

  @Get('number-providers')
  @RequirePermission('numbers.manage')
  async providers() {
    return { data: await this.numbers.listProviders() };
  }

  @Post('number-providers')
  @RequirePermission('numbers.manage')
  createProvider(
    @Body(new ZodPipe(providerSchema)) body: z.infer<typeof providerSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.createProvider(body, ctx);
  }

  @Get('number-inventory')
  @RequirePermission('numbers.read')
  async inventory(@Query(new ZodPipe(inventoryQuery)) q: z.infer<typeof inventoryQuery>) {
    return { data: await this.numbers.listInventory(q.status) };
  }

  @Post('number-inventory')
  @RequirePermission('numbers.manage')
  addInventory(
    @Body(new ZodPipe(inventorySchema)) body: z.infer<typeof inventorySchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.addInventory(body, ctx);
  }

  @Get('tenants/:tenantId/number')
  @RequirePermission('numbers.read')
  tenantNumber(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.numbers.tenantNumber(tenantId);
  }

  /** Atribui e adiciona à WABA (passo 1). Idempotente: repetir retoma após falha. */
  @Post('tenants/:tenantId/number/assign')
  @HttpCode(200)
  @RequirePermission('numbers.assign')
  assign(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(assignSchema)) body: z.infer<typeof assignSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.assign(tenantId, body, ctx);
  }

  @Post('tenants/:tenantId/phone-numbers/:phoneId/verification/request')
  @HttpCode(200)
  @RequirePermission('numbers.assign')
  requestCode(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
    @Body(new ZodPipe(requestCodeSchema)) body: z.infer<typeof requestCodeSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.requestCode(tenantId, phoneId, body, ctx);
  }

  @Post('tenants/:tenantId/phone-numbers/:phoneId/verification/verify')
  @HttpCode(200)
  @RequirePermission('numbers.assign')
  verify(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
    @Body(new ZodPipe(verifySchema)) body: z.infer<typeof verifySchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.verifyCode(tenantId, phoneId, body.code, ctx);
  }

  @Post('tenants/:tenantId/phone-numbers/:phoneId/register')
  @HttpCode(200)
  @RequirePermission('numbers.assign')
  register(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.register(tenantId, phoneId, ctx);
  }

  /** Somente em offboarding: libera para quarentena (FR-NUM-05). */
  @Post('tenants/:tenantId/number/release')
  @HttpCode(200)
  @RequirePermission('numbers.manage')
  release(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(releaseSchema)) body: z.infer<typeof releaseSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.numbers.release(tenantId, body.reason, ctx);
  }
}
