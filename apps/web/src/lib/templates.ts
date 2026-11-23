/**
 * Modelos de mensagem (templates): variáveis {{1}}, {{2}}…, validação local que espelha a API
 * (apps/api/src/templates) e as regras oficiais da Meta (docs/10-meta-referencia.md §11.2), e a
 * prévia da mensagem com os valores preenchidos.
 */
import type { Template, TemplateComponent, VariableBinding } from './types';

/** Mesmo padrão da API (templates.service.ts): rótulo de descadastro aceito no botão. */
export const OPT_OUT_LABEL = /sair|parar|pare|stop|cancelar|descadastr|n[ãa]o quero|unsubscribe/i;
export const DEFAULT_OPT_OUT_TEXT = 'Não quero receber';

export const BODY_MAX = 1024;
export const FOOTER_MAX = 60;
export const BUTTON_MAX = 25;
export const NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Variáveis na ordem em que aparecem, sem repetir: "Oi {{1}}, {{2}} e {{1}}" → ["1","2"]. */
export function extractVariables(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const v = m[1] as string;
    if (!seen.includes(v)) seen.push(v);
  }
  return seen;
}

/** Variáveis posicionais ordenadas numericamente ("1","2",…). */
export function positionalVariables(text: string): string[] {
  return extractVariables(text)
    .filter((v) => /^\d+$/.test(v))
    .sort((a, b) => Number(a) - Number(b));
}

export interface TemplateDraft {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  body: string;
  footer: string;
  /** Rótulo do botão de descadastro (resposta rápida). Vazio = sem botão (só utilidade). */
  optOutButton: string;
  examples: Record<string, string>;
}

export type DraftErrors = Partial<Record<keyof TemplateDraft | `example_${string}`, string>>;

export function validateTemplateDraft(d: TemplateDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name) e.name = 'Dê um nome ao modelo.';
  else if (!NAME_PATTERN.test(d.name))
    e.name = 'Use só letras minúsculas, números e _ (sem espaço).';

  const body = d.body.trim();
  if (!body) e.body = 'Escreva o texto da mensagem.';
  else if (d.body.length > BODY_MAX) e.body = `Máximo de ${BODY_MAX} caracteres.`;
  else {
    const vars = extractVariables(body);
    const bad = vars.find((v) => !/^\d+$/.test(v));
    const nums = vars.filter((v) => /^\d+$/.test(v)).map(Number);
    const sorted = [...nums].sort((a, b) => a - b);
    if (bad) e.body = `Variável inválida: {{${bad}}}. Use {{1}}, {{2}}, …`;
    else if (sorted.some((n, i) => n !== i + 1)) {
      e.body = 'As variáveis precisam ser em sequência: {{1}}, {{2}}, {{3}}…';
    } else if (/^\{\{[^}]+\}\}/.test(body) || /\{\{[^}]+\}\}[.!?…\s]*$/.test(body)) {
      e.body = 'A Meta reprova mensagens que começam ou terminam com uma variável. Adicione texto.';
    }
    for (const v of sorted) {
      if (!d.examples[String(v)]?.trim()) {
        e[`example_${v}`] = 'Dê um exemplo (a Meta exige para revisar).';
      }
    }
  }
  if (d.footer.length > FOOTER_MAX) e.footer = `Máximo de ${FOOTER_MAX} caracteres.`;

  const btn = d.optOutButton.trim();
  if (btn.length > BUTTON_MAX) e.optOutButton = `Máximo de ${BUTTON_MAX} caracteres.`;
  else if (d.category === 'MARKETING' && !btn) {
    e.optOutButton = 'Modelos de marketing precisam do botão de descadastro.';
  } else if (d.category === 'MARKETING' && !OPT_OUT_LABEL.test(btn)) {
    e.optOutButton =
      'O texto do botão precisa deixar claro o descadastro (ex.: “Não quero receber”).';
  }
  return e;
}

/** Corpo da requisição POST /tenants/:id/templates. */
export function buildTemplatePayload(d: TemplateDraft, wabaId: string) {
  const vars = positionalVariables(d.body);
  const components: TemplateComponent[] = [
    {
      type: 'BODY',
      text: d.body.trim(),
      ...(vars.length
        ? { example: { body_text: [vars.map((v) => (d.examples[v] ?? '').trim())] } }
        : {}),
    },
  ];
  if (d.footer.trim()) components.push({ type: 'FOOTER', text: d.footer.trim() });
  if (d.optOutButton.trim()) {
    components.push({
      type: 'BUTTONS',
      buttons: [{ type: 'QUICK_REPLY', text: d.optOutButton.trim() }],
    });
  }
  return {
    wabaId,
    name: d.name,
    language: d.language,
    category: d.category,
    parameterFormat: 'POSITIONAL' as const,
    components,
  };
}

const comp = (t: Pick<Template, 'components'>, type: string) =>
  t.components.find((c) => String(c.type).toUpperCase() === type);

export const templateBody = (t: Pick<Template, 'components'>) => comp(t, 'BODY')?.text ?? '';
export const templateFooter = (t: Pick<Template, 'components'>) => comp(t, 'FOOTER')?.text ?? '';
export const templateHeader = (t: Pick<Template, 'components'>) => {
  const h = comp(t, 'HEADER');
  return h && (h.format ?? 'TEXT').toUpperCase() === 'TEXT' ? (h.text ?? '') : '';
};
export const templateButtons = (t: Pick<Template, 'components'>) =>
  (comp(t, 'BUTTONS')?.buttons ?? []).map((b) => b.text);

/** Substitui {{n}} pelos valores; variável sem valor fica visível como [variável n]. */
export function renderTemplate(text: string, values: Record<string, string | undefined>): string {
  return text.replace(VAR_RE, (_m, v: string) => {
    const val = values[v];
    return val?.trim() ? val : `[variável ${v}]`;
  });
}

export interface SampleContact {
  name: string | null;
  attributes: Record<string, string>;
}

/** Valor que um contato daria para cada variável, conforme a escolha do usuário. */
export function resolveBinding(binding: VariableBinding | undefined, contact?: SampleContact) {
  if (!binding) return undefined;
  if (binding.source === 'fixed') return binding.value ?? '';
  if (!contact) return undefined;
  if (binding.source === 'name') return contact.name ?? '';
  return binding.value ? (contact.attributes[binding.value] ?? '') : '';
}

/** Problemas no preenchimento das variáveis de um disparo (vazio = pode seguir). */
export function bindingErrors(vars: string[], bindings: Record<string, VariableBinding>) {
  const errors: Record<string, string> = {};
  for (const v of vars) {
    const b = bindings[v];
    if (!b) errors[v] = 'Escolha o que vai nesta variável.';
    else if (b.source === 'fixed' && !b.value?.trim()) errors[v] = 'Escreva o texto fixo.';
    else if (b.source === 'attribute' && !b.value) errors[v] = 'Escolha a coluna da planilha.';
  }
  return errors;
}
