/** Formatação para exibição (pt-BR). */

const nf = new Intl.NumberFormat('pt-BR');
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

export const formatNumber = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));
export const formatBRL = (n: number | null | undefined) => (n == null ? '—' : brl.format(n));

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : df.format(d);
}

/** "1 contato" / "2 contatos". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Telefone E.164 legível. Brasil: +55 (11) 98765-4321. Outros países: + DDI e dígitos agrupados.
 * Telefones já mascarados pela API (+55119****4321) são mostrados com a máscara em "•".
 */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const v = value.trim();
  if (v.includes('*')) return formatMaskedPhone(v);
  const digits = v.replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const head = rest.slice(0, rest.length - 4);
    return `+55 (${ddd}) ${head}-${rest.slice(-4)}`;
  }
  if (digits.length < 8) return v;
  return `+${digits}`;
}

/** "+55119****4321" (maskPhone da API) → "+55 (11) 9••••-4321". */
export function formatMaskedPhone(masked: string): string {
  const m = /^\+55(\d{2})(\d*)(\*+)(\d{4})$/.exec(masked);
  if (!m) return masked.replace(/\*/g, '•');
  const [, ddd, visible, stars, last] = m as unknown as [string, string, string, string, string];
  return `+55 (${ddd}) ${visible}${'•'.repeat(stars.length)}-${last}`;
}

/** Só dígitos, com o + na frente (para envio à API, que normaliza de novo). */
export function cleanPhoneInput(value: string): string {
  const digits = value.replace(/\D/g, '');
  return value.trim().startsWith('+') ? `+${digits}` : digits;
}

/** Nome de template/variável a partir de um texto livre: "Promoção Natal!" → "promocao_natal". */
export function slugify(text: string, max = 60): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}
