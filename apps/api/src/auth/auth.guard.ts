import { can, type Permission } from '@bm/shared';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC, PERMISSION } from './decorators';
import { SESSION_COOKIE, SessionService } from './session.service';

/**
 * Guard global: toda rota exige sessão válida, exceto as marcadas com @Public().
 * Depois, aplica a permissão declarada com @RequirePermission().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    // Token aleatório de 256 bits; o banco guarda apenas o hash.
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Sessão ausente');

    const auth = await this.sessions.resolve(token);
    if (!auth) throw new UnauthorizedException('Sessão expirada ou inválida');
    req.auth = auth;

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION,
      targets,
    );
    if (permission && !can(auth.role, permission)) {
      throw new ForbiddenException('Permissão insuficiente');
    }
    return true;
  }
}
