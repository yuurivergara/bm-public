import type { CampaignVariable } from '@bm/db';

/**
 * Análise de templates para envio (S5). Envio confirmado na doc oficial só para variáveis no CORPO
 * (docs/10-meta-referencia.md §12); cabeçalho com mídia/variável e botões com parâmetro ainda não
 * têm o formato de envio validado, então esses templates são recusados com motivo claro.
 */

interface Component {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string; url?: string }[];
}

export interface TemplateAnalysis {
  body: string;
  /** Placeholders do corpo em ordem: "1","2"… (posicional) ou nomes (nomeado). */
  placeholders: string[];
  named: boolean;
  /** Motivo, em português, de o template não poder ser usado em campanha ainda. */
  unsupported?: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function analyzeTemplate(
  components: unknown,
  parameterFormat: string | null | undefined,
  category?: string | null,
): TemplateAnalysis {
  const list = (Array.isArray(components) ? components : []) as Component[];
  const byType = (t: string) => list.filter((c) => String(c.type).toUpperCase() === t);
  const body = byType('BODY')[0]?.text ?? '';
  const named = String(parameterFormat ?? '').toUpperCase() === 'NAMED';
  const found = [...body.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  const unique = [...new Set(found)];
  const placeholders = named ? unique : unique.sort((a, b) => Number(a) - Number(b));

  let unsupported: string | undefined;
  const header = byType('HEADER')[0];
  if (String(category ?? '').toUpperCase() === 'AUTHENTICATION') {
    unsupported = 'Modelos de autenticação (código) não são usados em campanhas';
  } else if (header && String(header.format ?? 'TEXT').toUpperCase() !== 'TEXT') {
    unsupported = 'Cabeçalho com imagem, vídeo ou documento ainda não é suportado nas campanhas';
  } else if (header?.text && PLACEHOLDER.test(header.text)) {
    unsupported = 'Cabeçalho com variável ainda não é suportado nas campanhas';
  } else {
    for (const b of byType('BUTTONS').flatMap((c) => c.buttons ?? [])) {
      const type = String(b.type).toUpperCase();
      if (type === 'URL' && b.url && /\{\{/.test(b.url)) {
        unsupported = 'Botão de link com variável ainda não é suportado nas campanhas';
      } else if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(type)) {
        unsupported = `Botão do tipo ${type} ainda não é suportado nas campanhas`;
      }
    }
  }
  PLACEHOLDER.lastIndex = 0;
  return { body, placeholders, named, unsupported };
}

export interface ContactData {
  name: string | null;
  attributes: Record<string, unknown> | null;
}

/** A Meta recusa parâmetros com quebra de linha, tab ou mais de 4 espaços seguidos. */
function clean(v: string): string {
  return v
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 1024);
}

export function resolveValue(v: CampaignVariable | undefined, contact: ContactData): string {
  if (!v) return '';
  let raw = '';
  if (v.source === 'name') raw = contact.name ?? '';
  else if (v.source === 'attribute') {
    const a = contact.attributes?.[v.value ?? ''];
    raw = a === null || a === undefined ? '' : String(a);
  } else raw = v.value ?? '';
  const value = clean(raw);
  return value || clean(v.fallback ?? '');
}

export type ResolvedParams =
  | { ok: true; params: { name?: string; text: string }[] }
  | { ok: false; reason: string };

export function resolveParams(
  analysis: TemplateAnalysis,
  variables: Record<string, CampaignVariable>,
  contact: ContactData,
): ResolvedParams {
  const params: { name?: string; text: string }[] = [];
  for (const p of analysis.placeholders) {
    const text = resolveValue(variables[p], contact);
    if (!text) return { ok: false, reason: `variável {{${p}}} vazia para este contato` };
    params.push(analysis.named ? { name: p, text } : { text });
  }
  return { ok: true, params };
}

/** Texto final da mensagem (prévia no painel). */
export function renderBody(analysis: TemplateAnalysis, values: Record<string, string>): string {
  return analysis.body.replace(PLACEHOLDER, (_, key: string) => values[key] ?? `{{${key}}}`);
}
