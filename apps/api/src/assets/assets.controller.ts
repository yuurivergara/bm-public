import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { AssetsService } from './assets.service';

/** IDs da Meta são numéricos (strings longas). */
const metaId = z
  .string()
  .trim()
  .regex(/^\d{5,25}$/, 'ID da Meta inválido');

const connectSchema = z
  .object({
    businessId: metaId,
    wabaId: metaId,
    /** Token de system user com acesso aos ativos (cifrado; nunca devolvido nem logado). */
    accessToken: z.string().trim().min(20).max(1024),
    method: z.enum(['partner_share', 'manual']).default('partner_share'),
    subscribeWebhooks: z.boolean().default(true),
    /**
     * App próprio do cliente (ponte até o Tech Provider): ID e App Secret do app dele. O secret
     * assina as chamadas (appsecret_proof) e valida os webhooks desse app; cifrado, nunca devolvido.
     */
    appId: metaId.optional(),
    appSecret: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/i, 'App Secret inválido (32 caracteres hexadecimais)')
      .optional(),
  })
  .strict()
  .refine((v) => !v.appSecret === !v.appId, {
    message: 'Informe o ID do app e o App Secret juntos',
    path: ['appSecret'],
  });

@Controller('tenants/:tenantId/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermission('assets.read')
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.assets.list(tenantId);
  }

  /** Cadastro por parceria/manual (docs/04-endpoints.md §1.3). */
  @Post('partner-share')
  @RequirePermission('assets.write')
  connect(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(connectSchema)) body: z.infer<typeof connectSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.assets.connect(tenantId, body, ctx);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('assets.write')
  sync(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Ctx() ctx: RequestContext) {
    return this.assets.sync(tenantId, ctx);
  }
}
