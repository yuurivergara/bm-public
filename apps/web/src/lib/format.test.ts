import { describe, expect, it } from 'vitest';
import { cleanPhoneInput, formatMaskedPhone, formatPhone, plural, slugify } from './format';

describe('telefones', () => {
  it('formata E.164 brasileiro (celular e fixo)', () => {
    expect(formatPhone('+5511987654321')).toBe('+55 (11) 98765-4321');
    expect(formatPhone('+551133334444')).toBe('+55 (11) 3333-4444');
  });

  it('mostra a máscara da API com pontos, sem revelar dígitos', () => {
    // maskPhone da API: 6 primeiros caracteres + **** + 4 últimos
    expect(formatMaskedPhone('+55119****4321')).toBe('+55 (11) 9••••-4321');
    expect(formatPhone('+55119****4321')).toBe('+55 (11) 9••••-4321');
    expect(formatMaskedPhone('+1555****1234')).toBe('+1555••••1234');
    expect(formatMaskedPhone('****')).toBe('••••');
  });

  it('outros países e vazios', () => {
    expect(formatPhone('+14155552671')).toBe('+14155552671');
    expect(formatPhone(null)).toBe('—');
  });

  it('limpa a digitação mantendo o +', () => {
    expect(cleanPhoneInput('(11) 98765-4321')).toBe('11987654321');
    expect(cleanPhoneInput(' +55 11 98765 4321')).toBe('+5511987654321');
  });
});

describe('textos', () => {
  it('plural', () => {
    expect(plural(1, 'contato')).toBe('1 contato');
    expect(plural(1500, 'contato')).toBe('1.500 contatos');
  });

  it('slugify gera nomes técnicos válidos', () => {
    expect(slugify('Promoção de Natal!')).toBe('promocao_de_natal');
    expect(slugify('  Cidade / UF ')).toBe('cidade_uf');
  });
});
