import { randomBytes } from 'node:crypto';
import { createDb, createTestDatabase, orm, type TestDatabase, users } from '@bm/db';
import { encryptSecret, LocalKeyProvider, type Role } from '@bm/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authenticator } from 'otplib';
import postgres from 'postgres';
import { createApp } from '../app';
import { hashPassword } from '../auth/crypto';
import { loadConfig } from '../config/config';

export const PASSWORD = 'senha-muito-segura-123';

export interface Harness {
  app: NestFastifyApplication;
  admin: postgres.Sql;
  createUser: (
    role: Role,
    email?: string,
  ) => Promise<{ id: string; email: string; secret: string }>;
  login: (user: { email: string; secret: string }) => Promise<string>;
  close: () => Promise<void>;
}

export async function createHarness(opts: { authRateLimit?: number } = {}): Promise<Harness> {
  const tdb: TestDatabase = await createTestDatabase();
  const masterKey = randomBytes(32).toString('base64');
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: tdb.appUrl,
    LOCAL_MASTER_KEY: masterKey,
    PHONE_HASH_PEPPER: randomBytes(32).toString('base64'),
    SESSION_COOKIE_SECURE: 'false',
    AUTH_RATE_LIMIT_PER_MIN: String(opts.authRateLimit ?? 1000),
    LOG_LEVEL: (process.env.TEST_LOG_LEVEL as 'silent') ?? 'silent',
  });
  const app = await createApp(config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const admin = postgres(tdb.adminUrl, { max: 2, onnotice: () => {} });
  const keys = new LocalKeyProvider(masterKey);
  const { db, close: closeDb } = createDb(tdb.appUrl, { max: 2 });
  const passwordHash = await hashPassword(PASSWORD);

  const createUser: Harness['createUser'] = async (role, email) => {
    const secret = authenticator.generateSecret(20);
    const address = email ?? `${role}-${randomBytes(3).toString('hex')}@exemplo.com`;
    const [row] = await db
      .insert(users)
      .values({
        email: address,
        name: role,
        role,
        passwordHash,
        totpSecretEnc: await encryptSecret(secret, keys),
      })
      .returning({ id: users.id });
    if (!row) throw new Error('falha ao criar usuário');
    return { id: row.id, email: address, secret };
  };

  const login: Harness['login'] = async (user) => {
    // permite logins repetidos no mesmo intervalo TOTP durante os testes
    await db.update(users).set({ totpLastUsedStep: null }).where(orm.eq(users.email, user.email));
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    if (step1.statusCode !== 200) throw new Error(`login falhou: ${step1.body}`);
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp',
      payload: {
        challengeToken: step1.json().challengeToken,
        code: authenticator.generate(user.secret),
      },
    });
    if (step2.statusCode !== 200) throw new Error(`totp falhou: ${step2.body}`);
    const cookie = step2.cookies.find((c) => c.name === 'bm_sid');
    if (!cookie) throw new Error('cookie de sessão ausente');
    return `bm_sid=${cookie.value}`;
  };

  return {
    app,
    admin,
    createUser,
    login,
    close: async () => {
      await app.close();
      await closeDb();
      await admin.end();
      await tdb.drop();
    },
  };
}
