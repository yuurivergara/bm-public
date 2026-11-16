import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Assinatura dos webhooks da Meta: header `X-Hub-Signature-256: sha256=<hex>`, onde <hex> é o
 * HMAC-SHA256 do corpo BRUTO da requisição com o app secret (docs/10-meta-referencia.md).
 */
export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** Verificação em tempo constante. Header ausente/malformado → false. */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  header: string | undefined | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
