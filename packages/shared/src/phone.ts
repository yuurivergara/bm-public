import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export type PhoneNormalization =
  | { ok: true; e164: string; country: string; fixedNinthDigit: boolean }
  | { ok: false; reason: PhoneRejectReason };

export type PhoneRejectReason =
  | 'empty'
  | 'invalid_characters'
  | 'invalid_length'
  | 'invalid_number';

const BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Normaliza um telefone vindo de planilha/TXT para E.164.
 *
 * Regras brasileiras (listas antigas são comuns):
 * - aceita com ou sem DDI 55, com ou sem zero/código de operadora à esquerda;
 * - DDD válido obrigatório;
 * - celular com 8 dígitos começando em 6–9 recebe o nono dígito ("9");
 * - fixo (8 dígitos começando em 2–5) é aceito (pode ser número da API, mas raramente é destinatário).
 *
 * Números de outros países exigem DDI explícito ("+" ou 00) e são validados via libphonenumber.
 */
export function normalizePhone(raw: string | number | null | undefined): PhoneNormalization {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const input = String(raw).trim();
  if (input === '') return { ok: false, reason: 'empty' };
  if (/[^\d\s()+\-./]/.test(input)) return { ok: false, reason: 'invalid_characters' };

  const explicitInternational = input.startsWith('+') || input.startsWith('00');
  let digits = input.replace(/\D/g, '');
  if (input.startsWith('00')) digits = digits.slice(2);

  if (explicitInternational && !digits.startsWith('55')) {
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    if (!parsed?.isValid()) return { ok: false, reason: 'invalid_number' };
    return {
      ok: true,
      e164: parsed.number,
      country: parsed.country ?? 'ZZ',
      fixedNinthDigit: false,
    };
  }

  return normalizeBrazilian(digits);
}

function normalizeBrazilian(input: string): PhoneNormalization {
  let digits = input;
  // DDI 55 presente (12 ou 13 dígitos após remover)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  // prefixo de discagem nacional "0" e código de operadora ("0 XX DDD ...")
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
    if (digits.length === 12 || digits.length === 13) digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return { ok: false, reason: 'invalid_length' };

  const ddd = Number(digits.slice(0, 2));
  if (!BR_DDD.has(ddd)) return { ok: false, reason: 'invalid_number' };
  let subscriber = digits.slice(2);
  let fixedNinthDigit = false;

  if (subscriber.length === 8) {
    const first = subscriber.charAt(0);
    if ('6789'.includes(first)) {
      subscriber = `9${subscriber}`;
      fixedNinthDigit = true;
    } else if (!'2345'.includes(first)) {
      return { ok: false, reason: 'invalid_number' };
    }
  } else if (!subscriber.startsWith('9')) {
    return { ok: false, reason: 'invalid_number' };
  }

  return { ok: true, e164: `+55${ddd}${subscriber}`, country: 'BR', fixedNinthDigit };
}

/**
 * IDs do WhatsApp (wa_id) de celulares brasileiros antigos podem vir sem o nono dígito.
 * Retorna as variantes E.164 possíveis para casar mensagens recebidas com contatos.
 */
export function brazilianWaIdVariants(waId: string): string[] {
  const digits = waId.replace(/\D/g, '');
  const e164 = `+${digits}`;
  if (!digits.startsWith('55')) return [e164];
  const national = digits.slice(2);
  if (national.length === 10 && '6789'.includes(national.charAt(2))) {
    return [e164, `+55${national.slice(0, 2)}9${national.slice(2)}`];
  }
  if (national.length === 11 && national.charAt(2) === '9') {
    return [e164, `+55${national.slice(0, 2)}${national.slice(3)}`];
  }
  return [e164];
}

/** Mascara um telefone para logs: +5511987654321 → +55119****4321 */
export function maskPhone(e164: string): string {
  if (e164.length <= 8) return '****';
  return `${e164.slice(0, 6)}****${e164.slice(-4)}`;
}
