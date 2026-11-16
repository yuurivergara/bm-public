import { type DbHandle, orm } from '@bm/db';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DB } from '../core/tokens';

@Controller()
@Public()
export class HealthController {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  /** Processo vivo (liveness). */
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  /** Pronto para tráfego (readiness): banco acessível. */
  @Get('readyz')
  async ready() {
    try {
      await this.handle.db.execute(orm.sql`select 1`);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
