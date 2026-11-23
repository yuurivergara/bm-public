/**
 * Apoio à importação de planilhas: leitura do cabeçalho de CSV/TXT no navegador (para escolher as
 * colunas antes do envio), palpites de coluna e montagem do mapeamento aceito pela API
 * (apps/api/src/contacts/imports.service.ts).
 */
import { slugify } from './format';

export type FileFormat = 'csv' | 'txt' | 'xlsx';

export function detectFormat(filename: string): FileFormat | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'csv' || ext === 'txt' || ext === 'xlsx' ? ext : undefined;
}

/** Mesmo critério da API: separador mais frequente na primeira linha, fora de aspas. */
export function detectDelimiter(firstLine: string): string | undefined {
  const plain = firstLine.replace(/"[^"]*"/g, '');
  let best: string | undefined;
  let bestCount = 0;
  for (const d of [';', ',', '\t', '|']) {
    const n = plain.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Divide uma linha CSV simples respeitando aspas duplas. */
export function splitCsvLine(line: string, delimiter: string | undefined): string[] {
  if (!delimiter) return [line.trim()];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export interface Preview {
  /** Nomes das colunas como a API vai enxergar ("coluna N" quando não há cabeçalho). */
  columns: string[];
  /** Primeiras linhas de dados (para o usuário reconhecer as colunas). */
  sample: string[][];
}

/** Decodifica como a API: UTF-8; se inválido, Windows-1252 (planilhas antigas). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Cabeçalho + amostra a partir do texto inicial de um CSV/TXT. */
export function previewFromText(text: string, hasHeader: boolean, sampleSize = 3): Preview {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  // a última linha pode ter sido cortada no meio da leitura parcial
  const delimiter = detectDelimiter(lines[0] ?? '');
  const rows = lines.slice(0, sampleSize + 1).map((l) => splitCsvLine(l, delimiter));
  return previewFromRows(rows, hasHeader, sampleSize);
}

export function previewFromRows(rows: string[][], hasHeader: boolean, sampleSize = 3): Preview {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const first = rows[0] ?? [];
  const columns = Array.from({ length: width }, (_, i) =>
    hasHeader ? first[i]?.trim() || `coluna ${i + 1}` : `coluna ${i + 1}`,
  );
  const sample = (hasHeader ? rows.slice(1) : rows).slice(0, sampleSize);
  return { columns, sample };
}

const PHONE_HEADER =
  /^(telefone|celular|whats\s*app|whatsapp|wpp|fone|tel|cel|phone|mobile|n[uú]mero|numero|contato)\b/i;
const NAME_HEADER = /^(nome|name|primeiro\s*nome|cliente|first\s*name)\b/i;

/** Índice (0-based) da coluna de telefone, como a API detectaria; -1 se ambíguo. */
export function guessPhoneColumn(columns: string[]): number {
  if (columns.length === 1) return 0;
  const hits = columns.map((c, i) => (PHONE_HEADER.test(c) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? (hits[0] as number) : -1;
}

export function guessNameColumn(columns: string[], phoneIndex: number): number {
  return columns.findIndex((c, i) => i !== phoneIndex && NAME_HEADER.test(c));
}

/** Nome de variável aceito pela API (^[a-z][a-z0-9_]{0,59}$) a partir do nome da coluna. */
export function attributeKey(column: string, taken: Set<string> = new Set()): string {
  let base = slugify(column, 55);
  if (!base) base = 'coluna';
  if (!/^[a-z]/.test(base)) base = `c_${base}`.slice(0, 55);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export interface ColumnChoice {
  phone: number;
  /** -1 = sem coluna de nome. */
  name: number;
  /** Colunas extras guardadas para usar nas variáveis dos modelos. */
  extras: number[];
}

/** Mapeamento enviado à API (índices 1-based, que a API aceita para qualquer formato). */
export function buildMapping(columns: string[], choice: ColumnChoice) {
  const attributes: Record<string, number> = {};
  const taken = new Set<string>();
  for (const i of choice.extras) {
    if (i === choice.phone || i === choice.name) continue;
    const key = attributeKey(columns[i] ?? `coluna ${i + 1}`, taken);
    taken.add(key);
    attributes[key] = i + 1;
  }
  return {
    phone: choice.phone + 1,
    ...(choice.name >= 0 ? { name: choice.name + 1 } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

/** Mapeamento propositalmente inválido: a API responde 422 com as colunas do arquivo (XLSX). */
export const PROBE_MAPPING = { phone: 999_999 };
