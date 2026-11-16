import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { TemplatesService } from './templates.service';

/**
 * Validação local das regras oficiais (docs/10-meta-referencia.md §11.2) para falhar cedo; a
 * Meta continua sendo a autoridade (revisão em até 24 h).
 */
const button = z
  .object({
    type: z.string().transform((s) => s.toUpperCase()),
    text: z.string().trim().min(1).max(25),
  })
  .passthrough();

const component = z
  .object({ type: z.string().transform((s) => s.toUpperCase()) })
  .passthrough()
  .superRefine((c, ctx) => {
    const text = (c as { text?: unknown }).text;
    const max = { HEADER: 60, BODY: 1024, FOOTER: 60 }[c.type];
    if (max && typeof text === 'string' && text.length > max) {
      ctx.addIssue({ code: 'custom', message: `${c.type}: máximo de ${max} caracteres` });
    }
    if (c.type === 'BUTTONS') {
      const parsed = z
        .array(button)
        .min(1)
        .max(10)
        .safeParse((c as { buttons?: unknown }).buttons);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: 'BUTTONS: 1 a 10 botões, rótulo até 25 caracteres',
        });
      }
    }
  });

const createSchema = z
  .object({
    wabaId: z.string().uuid(),
    name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Só letras minúsculas, números e _'),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
      .default('pt_BR'),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
    parameterFormat: z.enum(['NAMED', 'POSITIONAL']).optional(),
    components: z
      .array(component)
      .min(1)
      .refine((cs) => cs.filter((c) => c.type === 'BODY').length === 1, 'Exatamente um BODY'),
  })
  .strict();

/** Templates por cliente (docs/04-endpoints.md §1.8). */
@Controller('tenants/:tenantId/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('templates.read')
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.templates.list(tenantId);
  }

  @Post()
  @RequirePermission('templates.write')
  create(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.templates.create(tenantId, body, ctx);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('templates.write')
  sync(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Ctx() ctx: RequestContext) {
    return this.templates.sync(tenantId, ctx);
  }

  @Delete(':templateId')
  @RequirePermission('templates.delete')
  remove(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.templates.remove(tenantId, templateId, ctx);
  }
}
