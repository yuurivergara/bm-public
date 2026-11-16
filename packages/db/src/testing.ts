import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { migrate } from './migrator';

export interface TestDatabase {
  adminUrl: string;
  appUrl: string;
  drop: () => Promise<void>;
}

/**
 * Cria um banco isolado, aplica as migrations e devolve URLs do dono e do papel da aplicação.
 * Usa TEST_DATABASE_ADMIN_URL (padrão: postgres local do docker-compose).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = new URL(
    process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://bm_owner:bm_owner@localhost:5432/bm',
  );
  const appPassword = process.env.DATABASE_APP_PASSWORD ?? 'bm_app_dev';
  const name = `bm_test_${randomBytes(4).toString('hex')}`;
  const root = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await root.unsafe(`create database ${name}`);
  await root.end();

  const adminUrl = new URL(base);
  adminUrl.pathname = `/${name}`;
  await migrate({ adminUrl: adminUrl.toString(), appPassword });

  const appUrl = new URL(adminUrl);
  appUrl.username = 'bm_app';
  appUrl.password = appPassword;

  return {
    adminUrl: adminUrl.toString(),
    appUrl: appUrl.toString(),
    drop: async () => {
      const r = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await r.unsafe(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}
