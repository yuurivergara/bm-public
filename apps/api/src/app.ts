import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type DynamicModule, type LogLevel, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthController, authRateLimitSettings } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionService } from './auth/session.service';
import { ErrorFilter } from './common/http';
import type { AppConfig } from './config/config';
import { CoreModule } from './core/core.module';
import { HealthController } from './health/health.controller';
import { TenantsController } from './tenants/tenants.controller';
import { TenantsService } from './tenants/tenants.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

/** Campos removidos de todos os logs (tokens, senhas, cookies, códigos). */
export const LOG_REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.code',
  '*.challengeToken',
  '*.token',
  '*.accessToken',
];

@Module({})
class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config)],
      controllers: [HealthController, AuthController, UsersController, TenantsController],
      providers: [
        SessionService,
        AuthService,
        UsersService,
        TenantsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

function nestLogLevels(level: AppConfig['LOG_LEVEL']): LogLevel[] | false {
  if (level === 'silent') return false;
  const order: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
  const map: Record<string, LogLevel> = { info: 'log', trace: 'verbose' };
  const idx = order.indexOf(map[level] ?? (level as LogLevel));
  return order.slice(0, idx + 1);
}

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  authRateLimitSettings.max = config.AUTH_RATE_LIMIT_PER_MIN;
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 1_048_576,
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL, redact: LOG_REDACT },
    genReqId: () => crypto.randomUUID(),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config), adapter, {
    logger: nestLogLevels(config.LOG_LEVEL),
    bufferLogs: false,
  });
  await app.register(helmet);
  await app.register(fastifyCookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();
  return app;
}
