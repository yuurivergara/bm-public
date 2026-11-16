import type { Role } from '@bm/shared';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AuthInfo {
  userId: string;
  role: Role;
  sessionId: string;
}

export interface RequestContext {
  userId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

export function contextFromRequest(req: FastifyRequest): RequestContext {
  return {
    userId: req.auth?.userId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    requestId: String(req.id),
  };
}

/** Injeta o contexto (operador, IP, user-agent) usado em auditoria. */
export const Ctx = createParamDecorator((_: unknown, exec: ExecutionContext): RequestContext => {
  return contextFromRequest(exec.switchToHttp().getRequest<FastifyRequest>());
});

/** Injeta o operador autenticado. */
export const CurrentUser = createParamDecorator((_: unknown, exec: ExecutionContext) => {
  return exec.switchToHttp().getRequest<FastifyRequest>().auth;
});
