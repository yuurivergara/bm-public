import { isValidCnpj, normalizeCnpj, normalizePhone } from '@bm/shared';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { type TenantStatus, TenantsService } from './tenants.service';

const STATUSES = [
  'onboarding',
  'active',
  'paused',
  'offboarded',
] as const satisfies readonly TenantStatus[];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

const cnpjField = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : normalizeCnpj(v)))
  .refine((v) => v === null || isValidCnpj(v), 'CNPJ inválido')
  .nullish();

const phoneField = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === '') return null;
    const r = normalizePhone(v);
    if (!r.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Telefone inválido (${r.reason})` });
      return z.NEVER;
    }
    return r.e164;
  })
  .nullish();

const tenantFields = {
  name: z.string().trim().min(1).max(160),
  legalName: optionalText(200),
  cnpj: cnpjField,
  contactName: optionalText(120),
  contactPhone: phoneField,
  contactEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  notes: optionalText(4000),
};
const createSchema = z.object(tenantFields).strict();
const updateSchema = z.object(tenantFields).partial().strict();

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const statusSchema = z.object({ status: z.enum(['active', 'paused']) }).strict();

const settingsSchema = z
  .object({
    monthlyCostCapUsd: z.number().nonnegative().max(10_000_000).nullable(),
    capacitySafetyPct: z.number().int().min(50).max(100),
    wavePolicy: z
      .object({
        firstPct: z.number().min(1).max(100),
        min: z.number().int().min(1),
        max: z.number().int().min(1),
        growth: z.number().min(1).max(10),
        gateMinutes: z.number().int().min(1).max(240),
      })
      .refine((w) => w.min <= w.max, 'min deve ser ≤ max'),
    maxMsgsPerContact24h: z.number().int().min(1).max(10),
    contactButtonUrl: z.string().url().startsWith('https://').max(500).nullable(),
  })
  .partial()
  .strict();

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @RequirePermission('tenants.read')
  list(@Query(new ZodPipe(listSchema)) query: z.infer<typeof listSchema>) {
    return this.tenants.list(query);
  }

  @Post()
  @RequirePermission('tenants.write')
  create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.tenants.create(body, ctx);
  }

  @Get(':id')
  @RequirePermission('tenants.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id')
  @RequirePermission('tenants.write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.tenants.update(id, body, ctx);
  }

  @Post(':id/status')
  @RequirePermission('tenants.write')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.tenants.changeStatus(id, body.status, ctx);
  }

  @Put(':id/settings')
  @RequirePermission('tenants.settings.write')
  updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.tenants.updateSettings(id, body, ctx);
  }
}
