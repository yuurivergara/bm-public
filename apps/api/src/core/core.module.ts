import { createDb, type DbHandle } from '@bm/db';
import { type KeyProvider, LocalKeyProvider } from '@bm/shared';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from './audit.service';
import { DB, KEY_PROVIDER } from './tokens';

/**
 * Provedores de infraestrutura compartilhados: configuração, banco, chaves e auditoria.
 * O KeyProvider da AWS KMS entra na S2 (tokens Meta); em dev/test usamos a chave local.
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
          useFactory: (): KeyProvider => {
            if (config.LOCAL_MASTER_KEY) return new LocalKeyProvider(config.LOCAL_MASTER_KEY);
            throw new Error('KMS KeyProvider ainda não implementado (previsto para S2)');
          },
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
