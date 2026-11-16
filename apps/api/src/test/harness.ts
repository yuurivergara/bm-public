import { randomBytes } from 'node:crypto';
import { createDb, createTestDatabase, orm, type TestDatabase, users } from '@bm/db';
import { encryptSecret, LocalKeyProvider, type Role } from '@bm/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authenticator } from 'otplib';
import postgres from 'postgres';
import { createApp } from '../app';
import { hashPassword } from '../auth/crypto';
import type { AppConfig } from '../config/config';
import { loadConfig } from '../config/config';

export const PASSWORD = 'senha-muito-segura-123';
export const META_APP_SECRET = 'segredo-do-app-meta-de-teste';
export const META_VERIFY_TOKEN = 'token-de-verificacao-de-teste';
export const META_GRAPH_VERSION = 'v99.0';

export interface Harness {
  app: NestFastifyApplication;
  config: AppConfig;
  admin: postgres.Sql;
  createUser: (
    role: Role,
    email?: string,
  ) => Promise<{ id: string; email: string; secret: string }>;
  login: (user: { email: string; secret: string }) => Promise<string>;
  /** Linhas de log capturadas (só com captureLogs). */
  logs: () => string[];
  close: () => Promise<void>;
}

export async function createHarness(
  opts: {
    authRateLimit?: number;
    metaBaseUrl?: string;
    captureLogs?: boolean;
    /** Variáveis extras de configuração (ex.: IMPORT_MAX_BYTES). */
    env?: Record<string, string>;
  } = {},
): Promise<Harness> {
  const captured: string[] = [];
  const restore: (() => void)[] = [];
  if (opts.captureLogs) {
    // Captura logs do Fastify (stream) e do Nest/console (stdout/stderr) sem poluir a saída.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = original;
      });
    }
  }
  const tdb: TestDatabase = await createTestDatabase();
  const masterKey = randomBytes(32).toString('base64');
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: tdb.appUrl,
    LOCAL_MASTER_KEY: masterKey,
    PHONE_HASH_PEPPER: randomBytes(32).toString('base64'),
    SESSION_COOKIE_SECURE: 'false',
    AUTH_RATE_LIMIT_PER_MIN: String(opts.authRateLimit ?? 1000),
    LOG_LEVEL: opts.captureLogs ? 'trace' : ((process.env.TEST_LOG_LEVEL as 'silent') ?? 'silent'),
    META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: META_VERIFY_TOKEN,
    META_GRAPH_VERSION,
    META_GRAPH_BASE_URL: opts.metaBaseUrl ?? 'http://127.0.0.1:9',
    META_HTTP_TIMEOUT_MS: '2000',
    WEBHOOK_PROCESSOR_ENABLED: 'false',
    IMPORT_PROCESSOR_ENABLED: 'false',
    ...opts.env,
  });
  const app = await createApp(config, {
    logStream: opts.captureLogs ? { write: (line) => captured.push(line) } : undefined,
  });
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
    config,
    admin,
    createUser,
    login,
    logs: () => [...captured],
    close: async () => {
      for (const r of restore) r();
      await app.close();
      await closeDb();
      await admin.end();
      await tdb.drop();
    },
  };
}
