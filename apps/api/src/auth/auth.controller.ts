import { can, PERMISSIONS, type Permission } from '@bm/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
import { type AuthInfo, Ctx, CurrentUser, type RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuthService } from './auth.service';
import { Public } from './decorators';
import { SESSION_COOKIE, SessionService } from './session.service';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
const totpSchema = z.object({
  challengeToken: z.string().min(20).max(128),
  code: z.string().regex(/^\d{6}$/),
});

/** Limite por IP nas rotas de login; ajustado por AUTH_RATE_LIMIT_PER_MIN em createApp(). */
export const authRateLimitSettings = { max: 10 };
const AUTH_RATE_LIMIT = {
  rateLimit: { max: () => authRateLimitSettings.max, timeWindow: '1 minute' },
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @RouteConfig(AUTH_RATE_LIMIT)
  login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    return this.auth.login(body.email, body.password, ctx);
  }

  @Public()
  @Post('totp')
  @HttpCode(200)
  @RouteConfig(AUTH_RATE_LIMIT)
  async totp(
    @Body(new ZodPipe(totpSchema)) body: z.infer<typeof totpSchema>,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { session, user } = await this.auth.verifyTotp(body.challengeToken, body.code, ctx);
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: this.config.SESSION_COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      expires: session.absoluteExpiresAt,
    });
    return { user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() auth: AuthInfo,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(auth.sessionId, ctx);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  async me(@CurrentUser() auth: AuthInfo) {
    const user = await this.auth.me(auth.userId);
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(auth.role, p));
    return { user, permissions };
  }

  @Get('sessions')
  async listSessions(@CurrentUser() auth: AuthInfo) {
    const rows = await this.sessions.listActive(auth.userId);
    return { data: rows.map((s) => ({ ...s, current: s.id === auth.sessionId })) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() auth: AuthInfo, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.sessions.revoke(id, auth.userId))) throw new NotFoundException();
  }
}
