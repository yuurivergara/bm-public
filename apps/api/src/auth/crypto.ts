import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';

// Parâmetros argon2id recomendados pela OWASP (19 MiB, 2 iterações).
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}

/** Hash usado para igualar o tempo de resposta quando o e-mail não existe. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return dummyHash;
}

const STEP_SECONDS = 30;
authenticator.options = { step: STEP_SECONDS, window: 1, digits: 6 };

export const TOTP_ISSUER = 'BM Platform';

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function totpUri(email: string, secret: string): string {
  return authenticator.keyuri(email, TOTP_ISSUER, secret);
}

/**
 * Verifica o código TOTP e devolve o "step" usado, ou null se inválido.
 * Quem chama deve rejeitar steps ≤ ao último usado (proteção contra replay).
 */
export function verifyTotp(code: string, secret: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(now / 1000 / STEP_SECONDS) + delta;
}
