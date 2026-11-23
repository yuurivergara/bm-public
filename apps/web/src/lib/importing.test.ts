import { describe, expect, it } from 'vitest';
import { daysNeeded, progressPct } from './campaigns';
import {
  attributeKey,
  buildMapping,
  decodeText,
  guessNameColumn,
  guessPhoneColumn,
  previewFromText,
  splitCsvLine,
} from './importing';

describe('leitura do cabeçalho da planilha', () => {
  it('detecta separador e respeita aspas', () => {
    const p = previewFromText('﻿Nome;Celular;"Cidade; UF"\nAna;11987654321;"Recife; PE"\n', true);
    expect(p.columns).toEqual(['Nome', 'Celular', 'Cidade; UF']);
    expect(p.sample).toEqual([['Ana', '11987654321', 'Recife; PE']]);
    expect(splitCsvLine('a,"b ""c""",d', ',')).toEqual(['a', 'b "c"', 'd']);
  });

  it('sem cabeçalho as colunas viram "coluna N" (como na API)', () => {
    const p = previewFromText('11987654321\n21987654321\n', false);
    expect(p.columns).toEqual(['coluna 1']);
    expect(p.sample).toHaveLength(2);
  });

  it('decodifica Windows-1252 quando não é UTF-8', () => {
    const latin1 = new Uint8Array([0x4a, 0x6f, 0xe3, 0x6f]); // "João" em latin1
    expect(decodeText(latin1)).toBe('João');
  });

  it('palpites de telefone e nome', () => {
    expect(guessPhoneColumn(['Nome', 'WhatsApp', 'Cidade'])).toBe(1);
    expect(guessPhoneColumn(['Telefone', 'Celular'])).toBe(-1); // ambíguo: o usuário escolhe
    expect(guessPhoneColumn(['qualquer'])).toBe(0);
    expect(guessNameColumn(['Celular', 'Nome completo'], 0)).toBe(1);
  });

  it('gera o mapeamento 1-based com chaves de variável válidas', () => {
    const cols = ['Nome', 'Celular', 'Cidade', 'Cidade', '2ª via'];
    expect(buildMapping(cols, { phone: 1, name: 0, extras: [2, 3, 4] })).toEqual({
      phone: 2,
      name: 1,
      attributes: { cidade: 3, cidade_2: 4, c_2_via: 5 },
    });
    expect(buildMapping(cols, { phone: 1, name: -1, extras: [] })).toEqual({ phone: 2 });
    expect(attributeKey('')).toBe('coluna');
  });
});

describe('disparos', () => {
  const counts = {
    total: 200,
    pending: 50,
    sent: 50,
    delivered: 60,
    read: 20,
    failed: 10,
    skipped: 10,
    uncertain: 0,
  };

  it('progresso = processados / total', () => {
    expect(progressPct(counts)).toBe(75);
    expect(progressPct({ ...counts, total: 0, pending: 0 })).toBe(0);
  });

  it('dias necessários conforme capacidade', () => {
    expect(daysNeeded(500, 1000, 1000)).toBe(1);
    expect(daysNeeded(2500, 500, 1000)).toBe(3);
    expect(daysNeeded(10, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
