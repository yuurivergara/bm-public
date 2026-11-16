import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ImportMapping } from '@bm/db';
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';

/**
 * Leitura dos arquivos de contatos (FR-CON-01) em streaming: CSV, TXT (um telefone por linha ou
 * delimitado) e XLSX (primeira planilha). Nada é carregado inteiro na memória.
 */

export type ImportFormat = 'csv' | 'txt' | 'xlsx';

export function detectFormat(filename: string): ImportFormat | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'csv' || ext === 'txt' || ext === 'xlsx' ? ext : undefined;
}

/** Planilhas brasileiras antigas costumam vir em Windows-1252: UTF-8 inválido → latin1. */
export async function detectEncoding(path: string): Promise<'utf8' | 'latin1'> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead), {
        stream: true,
      });
      return 'utf8';
    } catch {
      return 'latin1';
    }
  } finally {
    await fh.close();
  }
}

/** Separador mais frequente da primeira linha (fora de aspas); sem nenhum → arquivo de uma coluna. */
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

async function firstLine(path: string, encoding: BufferEncoding): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString(encoding).replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  } finally {
    await fh.close();
  }
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    // telefone digitado como número: sem notação científica nem casas decimais
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellToString(v.result as ExcelJS.CellValue);
  }
  return String(v);
}

export interface ReadOptions {
  format: ImportFormat;
  delimiter?: string;
  encoding?: 'utf8' | 'latin1';
}

/** Linhas do arquivo como arrays de texto (inclui o cabeçalho, se houver). */
export async function* readRows(path: string, opts: ReadOptions): AsyncGenerator<string[]> {
  if (opts.format === 'xlsx') {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      worksheets: 'emit',
      entries: 'emit',
    });
    for await (const sheet of reader) {
      for await (const row of sheet) {
        const values = row.values as ExcelJS.CellValue[]; // índice 0 vazio (1-based)
        const out: string[] = [];
        for (let i = 1; i < values.length; i++) out.push(cellToString(values[i]).trim());
        yield out;
      }
      return; // só a primeira planilha
    }
    return;
  }
  const encoding = opts.encoding ?? (await detectEncoding(path));
  const delimiter = opts.delimiter ?? detectDelimiter(await firstLine(path, encoding));
  const parser = createReadStream(path, { encoding }).pipe(
    parse({
      delimiter: delimiter ?? '\u0000', // sem separador: a linha inteira é a única coluna
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );
  for await (const record of parser) yield record as string[];
}

/** Cabeçalho (ou nomes "coluna 1…n") e até `sample` linhas de dados. */
export async function readHeader(
  path: string,
  opts: ReadOptions & { hasHeader: boolean },
  sample = 3,
): Promise<{ columns: string[]; sample: string[][] }> {
  const rows: string[][] = [];
  for await (const r of readRows(path, opts)) {
    rows.push(r);
    if (rows.length > sample) break;
  }
  const first = rows[0] ?? [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  const columns = opts.hasHeader
    ? Array.from({ length: width }, (_, i) => first[i]?.trim() || `coluna ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `coluna ${i + 1}`);
  return { columns, sample: opts.hasHeader ? rows.slice(1) : rows.slice(0, sample) };
}

const PHONE_HEADER =
  /^(telefone|celular|whats\s*app|whatsapp|wpp|fone|tel|cel|phone|mobile|n[uú]mero|numero|contato)\b/i;

export interface ResolvedMapping {
  phone: number;
  name?: number;
  attributes: [string, number][];
}

export class MappingError extends Error {
  constructor(
    message: string,
    readonly columns: string[],
  ) {
    super(message);
  }
}

/** Converte o mapeamento (nomes de coluna ou índices 1-based) em índices; detecta o telefone. */
export function resolveMapping(
  columns: string[],
  mapping: Partial<Pick<ImportMapping, 'phone' | 'name' | 'attributes'>>,
): ResolvedMapping {
  const find = (ref: string | number, what: string): number => {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const i = Number(ref) - 1;
      if (i >= 0 && i < columns.length) return i;
    } else {
      const i = columns.findIndex((c) => c.toLowerCase() === String(ref).trim().toLowerCase());
      if (i >= 0) return i;
    }
    throw new MappingError(`Coluna de ${what} não encontrada: "${ref}"`, columns);
  };
  let phone: number;
  if (mapping.phone !== undefined) {
    phone = find(mapping.phone, 'telefone');
  } else if (columns.length === 1) {
    phone = 0;
  } else {
    const hits = columns.map((c, i) => (PHONE_HEADER.test(c) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) {
      throw new MappingError('Informe qual coluna tem o telefone (mapping.phone)', columns);
    }
    phone = hits[0] as number;
  }
  const name = mapping.name !== undefined ? find(mapping.name, 'nome') : undefined;
  const attributes = Object.entries(mapping.attributes ?? {}).map(
    ([k, ref]) => [k, find(ref, `"${k}"`)] as [string, number],
  );
  return { phone, name, attributes };
}
