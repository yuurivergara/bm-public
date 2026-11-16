import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { ContactsService } from './contacts.service';
import { ImportsService } from './imports.service';

const confirmSchema = z.object({ listName: z.string().trim().min(1).max(120).optional() }).strict();
const membersQuery = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const suppressionSchema = z
  .object({
    phone: z.string().min(1).max(40),
    reason: z.enum(['manual', 'complaint']).default('manual'),
  })
  .strict();

/** Contatos: importação com prévia, listas e supressão (docs/04-endpoints.md §1.7). */
@Controller('tenants/:tenantId')
export class ContactsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly contacts: ContactsService,
  ) {}

  /**
   * multipart/form-data: campos `listName`, `originDeclaration`, `legalBasis`,
   * `declarationAccepted=true`, opcionais `declarationNotes`, `hasHeader`, `delimiter`, `mapping`
   * (JSON); por último o arquivo no campo `file`. Responde 202: a análise roda em segundo plano.
   */
  @Post('imports')
  @HttpCode(202)
  @RequirePermission('contacts.import')
  upload(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Req() req: FastifyRequest,
    @Ctx() ctx: RequestContext,
  ) {
    return this.imports.upload(tenantId, req, ctx);
  }

  @Get('imports')
  @RequirePermission('contacts.read')
  listImports(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.imports.list(tenantId);
  }

  @Get('imports/:importId')
  @RequirePermission('contacts.read')
  getImport(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.imports.get(tenantId, importId);
  }

  @Post('imports/:importId/confirm')
  @HttpCode(202)
  @RequirePermission('contacts.import')
  confirm(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body(new ZodPipe(confirmSchema)) body: z.infer<typeof confirmSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.imports.confirm(tenantId, importId, body.listName, ctx);
  }

  @Delete('imports/:importId')
  @RequirePermission('contacts.import')
  cancel(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.imports.cancel(tenantId, importId, ctx);
  }

  @Get('lists')
  @RequirePermission('contacts.read')
  lists(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.contacts.lists(tenantId);
  }

  @Get('lists/:listId')
  @RequirePermission('contacts.read')
  list(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('listId', ParseUUIDPipe) listId: string,
  ) {
    return this.contacts.list(tenantId, listId);
  }

  @Get('lists/:listId/members')
  @RequirePermission('contacts.read')
  members(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('listId', ParseUUIDPipe) listId: string,
    @Query(new ZodPipe(membersQuery)) q: z.infer<typeof membersQuery>,
  ) {
    return this.contacts.members(tenantId, listId, q.after, q.limit);
  }

  @Get('suppressions')
  @RequirePermission('contacts.read')
  suppressions(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.contacts.suppressionList(tenantId, 200);
  }

  /** Supressão é permanente: não há rota para remover (FR-CON-06). */
  @Post('suppressions')
  @HttpCode(200)
  @RequirePermission('contacts.suppress')
  suppress(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(suppressionSchema)) body: z.infer<typeof suppressionSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.contacts.suppress(tenantId, body, ctx);
  }
}
