import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  brazilianWaIdVariants,
  can,
  decryptSecret,
  encryptSecret,
  hashPhone,
  isValidCnpj,
  LocalKeyProvider,
  maskPhone,
  normalizePhone,
  phoneHasher,
} from './index';

describe('normalizePhone', () => {
  it.each([
    ['11987654321', '+5511987654321', false],
    ['(11) 98765-4321', '+5511987654321', false],
    ['+55 11 98765-4321', '+5511987654321', false],
    ['5511987654321', '+5511987654321', false],
    ['011987654321', '+5511987654321', false],
    ['0 21 11 98765-4321', '+5511987654321', false],
    ['1187654321', '+5511987654321', true],
    ['551187654321', '+5511987654321', true],
    ['1133334444', '+551133334444', false],
    [11987654321, '+5511987654321', false],
  ])('%s → %s', (input, e164, fixed) => {
    expect(normalizePhone(input)).toEqual({
      ok: true,
      e164,
      country: 'BR',
      fixedNinthDigit: fixed,
    });
  });

  it.each([
    ['', 'empty'],
    [null, 'empty'],
    ['abc', 'invalid_characters'],
    ['12345', 'invalid_length'],
    ['2087654321', 'invalid_number'],
    ['11887654321', 'invalid_number'],
    ['1117654321', 'invalid_number'],
  ])('rejeita %s (%s)', (input, reason) => {
    expect(normalizePhone(input as string)).toEqual({ ok: false, reason });
  });

  it('aceita internacional com DDI explícito', () => {
    expect(normalizePhone('+1 415 555 2671')).toMatchObject({ ok: true, e164: '+14155552671' });
    expect(normalizePhone('+1 000')).toEqual({ ok: false, reason: 'invalid_number' });
  });
});

describe('brazilianWaIdVariants', () => {
  it('gera variantes com e sem nono dígito', () => {
    expect(brazilianWaIdVariants('551187654321')).toEqual(['+551187654321', '+5511987654321']);
    expect(brazilianWaIdVariants('5511987654321')).toEqual(['+5511987654321', '+551187654321']);
    expect(brazilianWaIdVariants('14155552671')).toEqual(['+14155552671']);
  });
});

describe('maskPhone', () => {
  it('mascara o meio', () => expect(maskPhone('+5511987654321')).toBe('+55119****4321'));
});

describe('isValidCnpj', () => {
  it('valida CNPJ numérico', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('11111111111111')).toBe(false);
  });
  it('valida CNPJ alfanumérico (exemplo oficial da Receita)', () => {
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12ABC34501DE36')).toBe(false);
  });
});

describe('envelope encryption', () => {
  const provider = new LocalKeyProvider(randomBytes(32).toString('base64'));
  it('cifra e decifra', async () => {
    const blob = await encryptSecret('EAAG-token-secreto', provider);
    expect(blob.toString('utf8')).not.toContain('EAAG');
    await expect(decryptSecret(blob, provider)).resolves.toBe('EAAG-token-secreto');
  });
  it('detecta adulteração', async () => {
    const blob = await encryptSecret('x', provider);
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1);
    await expect(decryptSecret(blob, provider)).rejects.toThrow();
  });
  it('recusa chave mestra de tamanho errado', () => {
    expect(() => new LocalKeyProvider(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('hashPhone', () => {
  const pepper = randomBytes(32).toString('base64');
  it('é determinístico por cliente e difere entre clientes', () => {
    const a1 = hashPhone('+5511987654321', pepper, 'tenant-a');
    const a2 = hashPhone('+5511987654321', pepper, 'tenant-a');
    const b = hashPhone('+5511987654321', pepper, 'tenant-b');
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });
  it('phoneHasher (chave derivada uma vez) dá o mesmo hash', () => {
    const h = phoneHasher(pepper, 'tenant-a');
    expect(h('+5511987654321').equals(hashPhone('+5511987654321', pepper, 'tenant-a'))).toBe(true);
    expect(h('+5511987654321').equals(h('+5511987654322'))).toBe(false);
  });
});

describe('rbac', () => {
  it('aplica a matriz', () => {
    expect(can('owner', 'tenants.delete_data')).toBe(true);
    expect(can('operator', 'tenants.delete_data')).toBe(false);
    expect(can('viewer', 'tenants.write')).toBe(false);
    expect(can('viewer', 'tenants.read')).toBe(true);
  });
});
