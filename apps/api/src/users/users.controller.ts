import { ROLES } from '@bm/shared';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '../auth/crypto';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/http';
import { Ctx, type RequestContext } from '../common/request-context';
import { UsersService } from './users.service';

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});
const updateSchema = z
  .object({ role: z.enum(ROLES).optional(), status: z.enum(['active', 'disabled']).optional() })
  .refine((v) => v.role || v.status, 'Informe role ou status');

@Controller('users')
@RequirePermission('users.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list() {
    return { data: await this.users.list() };
  }

  @Post()
  create(
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.users.create(body, ctx);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.users.update(id, body, ctx);
  }
}
