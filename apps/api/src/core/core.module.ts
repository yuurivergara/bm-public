import { createDb, type DbHandle } from '@bm/db';
import { MetaClient } from '@bm/meta-client';
import type { KeyProvider } from '@bm/shared';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, keyProviderFromConfig } from '../config/config';
import { AuditService } from './audit.service';
import { DB, KEY_PROVIDER, META_CLIENT } from './tokens';

/**
 * Provedores de infraestrutura compartilhados: configuração, banco, chaves e auditoria.
 * Chave mestra: MASTER_KEY na VPS (D-16), LOCAL_MASTER_KEY em dev/test; KMS fica para depois.
 */
@Global()
@Module({})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  static forRoot(config: AppConfig) {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB, useFactory: () => createDb(config.DATABASE_URL) },
        {
          provide: KEY_PROVIDER,
          useFactory: (): KeyProvider => keyProviderFromConfig(config),
        },
        {
          provide: META_CLIENT,
          useFactory: () =>
            new MetaClient({
              baseUrl: config.META_GRAPH_BASE_URL,
              graphVersion: config.META_GRAPH_VERSION,
              // Sem app secret (só em dev local), chamadas à Meta falham com erro claro da Graph.
              appSecret: config.META_APP_SECRET ?? 'meta-app-secret-nao-configurado',
              appId: config.META_APP_ID,
              timeoutMs: config.META_HTTP_TIMEOUT_MS,
            }),
        },
        AuditService,
      ],
      exports: [APP_CONFIG, DB, KEY_PROVIDER, META_CLIENT, AuditService],
    };
  }

  async onApplicationShutdown() {
    await this.handle.close();
  }
}
