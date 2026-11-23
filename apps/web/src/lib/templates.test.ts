import { describe, expect, it } from 'vitest';
import {
  bindingErrors,
  buildTemplatePayload,
  extractVariables,
  positionalVariables,
  renderTemplate,
  resolveBinding,
  type TemplateDraft,
  validateTemplateDraft,
} from './templates';

const draft = (patch: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'promo_natal',
  category: 'MARKETING',
  language: 'pt_BR',
  body: 'Olá, {{1}}! Use o cupom {{2}} até domingo.',
  footer: '',
  optOutButton: 'Não quero receber',
  examples: { '1': 'Ana', '2': 'NATAL10' },
  ...patch,
});

describe('variáveis', () => {
  it('extrai na ordem, sem repetir, e ordena as posicionais', () => {
    expect(extractVariables('{{2}} e {{1}} e {{ 2 }}')).toEqual(['2', '1']);
    expect(positionalVariables('{{2}} e {{1}}')).toEqual(['1', '2']);
  });

  it('renderiza a prévia e marca variáveis sem valor', () => {
    expect(renderTemplate('Oi {{1}}, {{2}}', { '1': 'Ana' })).toBe('Oi Ana, [variável 2]');
  });
});

describe('validação do modelo (espelha a API e a Meta)', () => {
  it('rascunho completo passa', () => {
    expect(validateTemplateDraft(draft())).toEqual({});
  });

  it('nome técnico só com minúsculas, números e _', () => {
    expect(validateTemplateDraft(draft({ name: 'Promo Natal' })).name).toBeDefined();
  });

  it('marketing exige botão de descadastro reconhecível', () => {
    expect(validateTemplateDraft(draft({ optOutButton: '' })).optOutButton).toBeDefined();
    expect(validateTemplateDraft(draft({ optOutButton: 'Saiba mais' })).optOutButton).toBeDefined();
    expect(
      validateTemplateDraft(draft({ optOutButton: 'Parar mensagens' })).optOutButton,
    ).toBeUndefined();
    expect(validateTemplateDraft(draft({ category: 'UTILITY', optOutButton: '' }))).toEqual({});
  });

  it('variáveis em sequência, com exemplos e sem começar/terminar o texto', () => {
    expect(validateTemplateDraft(draft({ body: 'Oi {{1}}, veja {{3}} hoje.' })).body).toMatch(
      /sequência/,
    );
    expect(validateTemplateDraft(draft({ body: '{{1}}, temos novidades.' })).body).toMatch(
      /começam ou terminam/,
    );
    expect(validateTemplateDraft(draft({ body: 'Temos novidades, {{1}}!' })).body).toMatch(
      /começam ou terminam/,
    );
    expect(validateTemplateDraft(draft({ examples: { '1': 'Ana' } })).example_2).toBeDefined();
    expect(validateTemplateDraft(draft({ body: 'x'.repeat(1025) })).body).toMatch(/1024/);
  });

  it('monta o payload com exemplos posicionais e botão de resposta rápida', () => {
    const p = buildTemplatePayload(draft({ footer: 'Loja X' }), 'waba-1');
    expect(p).toMatchObject({
      wabaId: 'waba-1',
      name: 'promo_natal',
      parameterFormat: 'POSITIONAL',
    });
    expect(p.components).toEqual([
      {
        type: 'BODY',
        text: 'Olá, {{1}}! Use o cupom {{2}} até domingo.',
        example: { body_text: [['Ana', 'NATAL10']] },
      },
      { type: 'FOOTER', text: 'Loja X' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Não quero receber' }] },
    ]);
  });
});

describe('variáveis do disparo', () => {
  const contact = { name: 'Ana', attributes: { cidade: 'Recife' } };

  it('resolve nome, coluna da planilha e texto fixo', () => {
    expect(resolveBinding({ source: 'name' }, contact)).toBe('Ana');
    expect(resolveBinding({ source: 'attribute', value: 'cidade' }, contact)).toBe('Recife');
    expect(resolveBinding({ source: 'fixed', value: '10%' })).toBe('10%');
    expect(resolveBinding({ source: 'name' })).toBeUndefined();
  });

  it('aponta variáveis sem preenchimento', () => {
    expect(
      bindingErrors(['1', '2', '3'], {
        '1': { source: 'name' },
        '2': { source: 'fixed', value: ' ' },
      }),
    ).toEqual({ '2': 'Escreva o texto fixo.', '3': 'Escolha o que vai nesta variável.' });
  });
});
