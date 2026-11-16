import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  type PipeTransform,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';

/** Erro de domínio com código estável (consumido pelo painel). */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value);
  }
}

/** Formato único de erro: { code, message, details, traceId }. Nunca vaza stack/SQL. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    const traceId = String(req.id);

    if (exception instanceof ZodError) {
      return reply.status(400).send({
        code: 'validation_error',
        message: 'Dados inválidos',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        traceId,
      });
    }
    if (exception instanceof AppError) {
      return reply.status(exception.getStatus()).send({
        code: exception.code,
        message: exception.message,
        details: exception.details,
        traceId,
      });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const codes: Record<number, string> = {
        400: 'bad_request',
        401: 'unauthenticated',
        403: 'forbidden',
        404: 'not_found',
        409: 'conflict',
        429: 'rate_limited',
      };
      return reply.status(status).send({
        code: codes[status] ?? 'http_error',
        message: exception.message,
        traceId,
      });
    }
    // Erros do próprio Fastify/plugins (rate limit, payload grande, JSON inválido) trazem statusCode.
    const statusCode = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const code =
        statusCode === 429
          ? 'rate_limited'
          : statusCode === 413
            ? 'payload_too_large'
            : 'bad_request';
      const message =
        statusCode === 429
          ? 'Muitas requisições; tente novamente em instantes'
          : 'Requisição inválida';
      return reply.status(statusCode).send({ code, message, traceId });
    }
    this.logger.error({ err: exception, traceId }, 'erro não tratado');
    return reply
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send({ code: 'internal_error', message: 'Erro interno', traceId });
  }
}
