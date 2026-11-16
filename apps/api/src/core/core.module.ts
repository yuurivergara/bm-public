import { createDb, type DbHandle } from '@bm/db';
import type { KeyProvider } from '@bm/shared';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, keyProviderFromConfig } from '../config/config';
import { AuditService } from './audit.service';
import { DB, KEY_PROVIDER } from './tokens';

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
        AuditService,
      ],
      exports: [APP_CONFIG, DB, KEY_PROVIDER, AuditService],
    };
  }

  async onApplicationShutdown() {
    await this.handle.close();
  }
}
