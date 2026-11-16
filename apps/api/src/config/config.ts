import { z } from 'zod';

const base64Key = (bytes: number) =>
  z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length >= bytes, `deve ter ${bytes}+ bytes em base64`);

const schema = z.object({
  APP_ENV: z.enum(['dev', 'test', 'staging', 'prod']).default('dev'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  LOCAL_MASTER_KEY: base64Key(32).optional(),
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
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.LOCAL_MASTER_KEY && !cfg.KMS_KEY_ID) {
    throw new Error(
      'Configuração inválida: defina KMS_KEY_ID (staging/prod) ou LOCAL_MASTER_KEY (dev)',
    );
  }
  if ((cfg.APP_ENV === 'staging' || cfg.APP_ENV === 'prod') && cfg.LOCAL_MASTER_KEY) {
    throw new Error('LOCAL_MASTER_KEY não é permitida em staging/prod; use KMS_KEY_ID');
  }
  if ((cfg.APP_ENV === 'staging' || cfg.APP_ENV === 'prod') && !cfg.SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SECURE deve ser true em staging/prod');
  }
  return cfg;
}
