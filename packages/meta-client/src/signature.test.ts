import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signMetaPayload, verifyMetaSignature } from './signature';

describe('assinatura de webhook', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

  it('assina como sha256=<hex do HMAC do corpo bruto>', () => {
    expect(signMetaPayload(body, 's3cr3t')).toBe(
      `sha256=${createHmac('sha256', 's3cr3t').update(body).digest('hex')}`,
    );
  });

  it('aceita a assinatura correta e rejeita corpo/segredo/formato diferentes', () => {
    const sig = signMetaPayload(body, 's3cr3t');
    expect(verifyMetaSignature(body, sig, 's3cr3t')).toBe(true);
    expect(verifyMetaSignature(Buffer.from(`${body} `), sig, 's3cr3t')).toBe(false);
    expect(verifyMetaSignature(body, sig, 'outro')).toBe(false);
    expect(verifyMetaSignature(body, sig.replace('sha256=', 'sha1='), 's3cr3t')).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abc', 's3cr3t')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cr3t')).toBe(false);
  });
});
