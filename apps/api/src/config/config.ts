import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type KeyProvider, LocalKeyProvider } from '@bm/shared';
import { z } from 'zod';

const base64Key = (bytes: number) =>
  z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length >= bytes, `deve ter ${bytes}+ bytes em base64`);

const schema = z.object({
  APP_ENV: z.enum(['dev', 'test', 'staging', 'prod']).default('dev'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /** Chave mestra só para dev/test (proibida em staging/prod). */
  LOCAL_MASTER_KEY: base64Key(32).optional(),
  /**
   * Chave mestra de staging/prod na VPS (D-16, sem KMS no MVP). Fica fora do banco da aplicação
   * (variável de ambiente no Coolify + cópia no cofre de senhas do operador).
   */
  MASTER_KEY: base64Key(32).optional(),
  /** Identificador gravado em cada blob cifrado; troque (ex.: master-v2) ao rotacionar a chave. */
  MASTER_KEY_ID: z.string().min(1).max(64).default('master-v1'),
  KMS_KEY_ID: z.string().optional(),
  PHONE_HASH_PEPPER: base64Key(32),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- Meta (docs/10-meta-referencia.md) ---
  /** URL base da Graph API; em dev/CI/staging aponta para o meta-sim. */
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'formato vNN.N')
    .default('v27.0'), // vigente em 2026-11 (docs/10-meta-referencia.md §1)
  META_APP_ID: z.string().regex(/^\d+$/).optional(),
  /** Assina appsecret_proof e valida X-Hub-Signature-256. Obrigatório em staging/prod. */
  META_APP_SECRET: z.string().min(16).optional(),
  /** Token do desafio de verificação do webhook (hub.verify_token). Obrigatório em staging/prod. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).optional(),
  META_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Liga o processador de webhooks em segundo plano neste processo. */
  WEBHOOK_PROCESSOR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WEBHOOK_PROCESSOR_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  /** Pasta dos arquivos de importação enquanto são analisados (apagados depois). */
  IMPORT_DIR: z.string().default(join(tmpdir(), 'bm-imports')),
  /** Tamanho máximo do arquivo de contatos (1M linhas de CSV cabem com folga em 200 MB). */
  IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(1_000_000),
  /** Liga o processador de importações em segundo plano neste processo. */
  IMPORT_PROCESSOR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  IMPORT_PROCESSOR_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  /** Quarentena de número liberado antes do reuso (FR-NUM-05). */
  NUMBER_QUARANTINE_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  /**
   * Build do painel web (apps/web/dist). A API serve o SPA na mesma origem (o cookie de sessão é
   * SameSite=strict). Se a pasta não tiver index.html, o painel simplesmente não é servido.
   * Padrão: apps/web/dist relativo a este arquivo (src/ ou dist/); a imagem Docker define /app/web.
   */
  WEB_DIST_DIR: z.string().default(resolve(__dirname, '../../../web/dist')),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Variável definida mas vazia (comum em compose: FOO=${FOO:-}) = ausente.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.LOCAL_MASTER_KEY && !cfg.MASTER_KEY && !cfg.KMS_KEY_ID) {
    throw new Error(
      'Configuração inválida: defina MASTER_KEY ou KMS_KEY_ID (staging/prod) ou LOCAL_MASTER_KEY (dev)',
    );
  }
  if ((cfg.APP_ENV === 'staging' || cfg.APP_ENV === 'prod') && cfg.LOCAL_MASTER_KEY) {
    throw new Error(
      'LOCAL_MASTER_KEY não é permitida em staging/prod; use MASTER_KEY ou KMS_KEY_ID',
    );
  }
  if (cfg.LOCAL_MASTER_KEY && cfg.MASTER_KEY) {
    throw new Error('Defina apenas uma chave mestra: MASTER_KEY ou LOCAL_MASTER_KEY');
  }
  if ((cfg.APP_ENV === 'staging' || cfg.APP_ENV === 'prod') && !cfg.SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SECURE deve ser true em staging/prod');
  }
  if (
    (cfg.APP_ENV === 'staging' || cfg.APP_ENV === 'prod') &&
    (!cfg.META_APP_SECRET || !cfg.META_WEBHOOK_VERIFY_TOKEN)
  ) {
    throw new Error('META_APP_SECRET e META_WEBHOOK_VERIFY_TOKEN são obrigatórios em staging/prod');
  }
  return cfg;
}

/** Escolhe o KeyProvider do envelope encryption conforme a configuração. */
export function keyProviderFromConfig(cfg: AppConfig): KeyProvider {
  if (cfg.MASTER_KEY) return new LocalKeyProvider(cfg.MASTER_KEY, cfg.MASTER_KEY_ID);
  if (cfg.LOCAL_MASTER_KEY) return new LocalKeyProvider(cfg.LOCAL_MASTER_KEY);
  throw new Error('KMS KeyProvider ainda não implementado; use MASTER_KEY (D-16)');
}
