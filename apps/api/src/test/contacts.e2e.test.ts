import { readdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportProcessor } from '../contacts/import-processor.service';
import { createHarness, type Harness } from './harness';

/** Importação de contatos com prévia, listas e supressão (FR-CON-01…06). */
let h: Harness;
let owner: string;
let operator: string;
let viewer: string;
let A: string;
let B: string;
let processor: ImportProcessor;

const DECL = {
  listName: 'Clientes da loja',
  originDeclaration: 'customers',
  legalBasis: 'legitimo_interesse',
  declarationNotes: 'Compradores dos últimos 12 meses',
  declarationAccepted: 'true',
};

/** Monta multipart/form-data na mão: campos primeiro, arquivo por último. */
function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer }) {
  const boundary = `----bm${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(
  cookie: string,
  tenantId: string,
  fields: Record<string, string>,
  file?: { name: string; content: Buffer },
) {
  const m = multipart(fields, file);
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/imports`,
    headers: { cookie, ...m.headers },
    payload: m.payload,
  });
}

const api = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });

async function importAndPreview(
  tenantId: string,
  fields: Record<string, string>,
  file: { name: string; content: Buffer },
) {
  const r = await upload(operator, tenantId, fields, file);
  expect(r.statusCode, r.body).toBe(202);
  await processor.drain();
  const imp = (await api(viewer, 'GET', `/tenants/${tenantId}/imports/${r.json().id}`)).json();
  return { upload: r.json(), imp };
}

beforeAll(async () => {
  h = await createHarness();
  owner = await h.login(await h.createUser('owner'));
  operator = await h.login(await h.createUser('operator'));
  viewer = await h.login(await h.createUser('viewer'));
  processor = h.app.get(ImportProcessor);
  A = (await api(owner, 'POST', '/tenants', { name: 'Loja A' })).json().id;
  B = (await api(owner, 'POST', '/tenants', { name: 'Loja B' })).json().id;
  // suprimido antes da importação
  expect(
    (await api(operator, 'POST', `/tenants/${A}/suppressions`, { phone: '+55 31 98888-7777' }))
      .statusCode,
  ).toBe(200);
});
afterAll(async () => {
  await h?.close();
});

describe('importação de contatos', () => {
  let importId: string;
  let listId: string;

  it('CSV latin1 com ";": detecta a coluna do telefone, normaliza e monta a prévia', async () => {
    const csv = [
      'Nome;Celular;Cidade',
      'João;(11) 8765-4321;São Paulo', // sem nono dígito → +5511987654321
      'Maria;+55 11 98765-4321;Santos', // duplicado do anterior
      'Zé;123;Rio', // inválido
      '',
      'Ana;21 99999-0000;Niterói',
      'Loja;11 3333-4444;SP', // fixo: válido
      'Opt-out;31988887777;BH', // suprimido
    ].join('\r\n');
    const { upload: up, imp } = await importAndPreview(
      A,
      { ...DECL, mapping: JSON.stringify({ name: 'Nome', attributes: { cidade: 'Cidade' } }) },
      { name: 'clientes.csv', content: Buffer.from(csv, 'latin1') },
    );
    expect(up).toMatchObject({ status: 'uploaded', columns: ['Nome', 'Celular', 'Cidade'] });
    expect(up.mapping).toMatchObject({ phone: 2, name: 'Nome', hasHeader: true });
    importId = up.id;
    expect(imp).toMatchObject({
      status: 'preview',
      rowCount: 6,
      validCount: 3,
      invalidCount: 1,
      duplicateCount: 1,
      suppressedCount: 1,
      existingCount: 0,
      errorSample: [{ row: 3, reason: 'quantidade de dígitos inválida' }],
      originDeclaration: 'customers',
      legalBasis: 'legitimo_interesse',
    });
    expect(imp.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    // arquivo apagado depois da análise
    expect(await readdir(h.config.IMPORT_DIR).catch(() => [])).not.toContain(importId);
  });

  it('declaração de origem é obrigatória; formato e mapeamento são validados', async () => {
    const file = { name: 'x.csv', content: Buffer.from('telefone\n11987654321\n') };
    const { declarationAccepted: _d, ...semAceite } = DECL;
    const r1 = await upload(operator, A, semAceite, file);
    expect(r1.statusCode).toBe(400);
    expect(JSON.stringify(r1.json())).toContain('declarar a origem');
    expect(
      (await upload(operator, A, { ...DECL, legalBasis: 'porque sim' }, file)).statusCode,
    ).toBe(400);
    expect(
      (await upload(operator, A, DECL, { name: 'x.pdf', content: Buffer.from('%PDF') })).json()
        .code,
    ).toBe('unsupported_format');
    const r2 = await upload(operator, A, DECL, {
      name: 'x.csv',
      content: Buffer.from('a,b,c\n11987654321,2,3\n'),
    });
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({
      code: 'mapping_required',
      details: { columns: ['a', 'b', 'c'] },
    });
    expect((await upload(viewer, A, DECL, file)).statusCode).toBe(403);
    expect((await upload(operator, A, DECL)).json().code).toBe('file_required');
  });

  it('confirma: suprimido depois da prévia também fica de fora; consentimento registrado', async () => {
    // Ana pede para sair entre a prévia e a confirmação
    await api(operator, 'POST', `/tenants/${A}/suppressions`, {
      phone: '21999990000',
      reason: 'complaint',
    });
    const c = await api(operator, 'POST', `/tenants/${A}/imports/${importId}/confirm`, {});
    expect(c.statusCode).toBe(202);
    expect(c.json().status).toBe('confirming');
    await processor.drain();
    const imp = (await api(viewer, 'GET', `/tenants/${A}/imports/${importId}`)).json();
    expect(imp).toMatchObject({ status: 'confirmed', suppressedCount: 2 });
    listId = imp.listId;
    const list = (await api(viewer, 'GET', `/tenants/${A}/lists/${listId}`)).json();
    expect(list).toMatchObject({ name: 'Clientes da loja', size: 2, importId });
    const members = (await api(viewer, 'GET', `/tenants/${A}/lists/${listId}/members`)).json();
    expect(members.data.map((m: { phoneMasked: string }) => m.phoneMasked).sort()).toEqual([
      '+55113****4444',
      '+55119****4321',
    ]);
    expect(members.data.find((m: { name: string }) => m.name === 'João')).toMatchObject({
      attributes: { cidade: 'São Paulo' },
    });
    expect(JSON.stringify(members)).not.toContain('987654321');

    const consent = await h.admin<{ basis: string; source: string; n: number }[]>`
      select basis, source, count(*)::int as n from consent_records where import_id = ${importId}
       group by basis, source`;
    expect(consent).toEqual([{ basis: 'legitimo_interesse', source: 'import_declaration', n: 2 }]);
    const left = await h.admin`select 1 from contact_import_rows where import_id = ${importId}`;
    expect(left).toHaveLength(0);
    // nenhum membro de lista suprimido
    const bad = await h.admin`
      select 1 from contact_list_members m join contacts c on c.id = m.contact_id
        join suppressions s on s.tenant_id = c.tenant_id and s.phone_hash = c.phone_hash`;
    expect(bad).toHaveLength(0);
    expect(
      (await api(operator, 'POST', `/tenants/${A}/imports/${importId}/confirm`, {})).statusCode,
    ).toBe(409);
  });

  it('XLSX com telefone numérico e texto; reimportação atualiza contatos sem duplicar', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Planilha1');
    ws.addRow(['WhatsApp', 'Primeiro nome', 'Pedido']);
    ws.addRow([5511987654321, 'João Silva', 'A-100']); // já é contato (veio do CSV)
    ws.addRow(['(48) 99123-4567', 'Bia', 'B-200']);
    ws.addRow([{ richText: [{ text: '48 9' }, { text: '9123-0000' }] }, 'Caio', 'C-300']);
    const content = Buffer.from(await wb.xlsx.writeBuffer());
    const { imp } = await importAndPreview(
      A,
      {
        ...DECL,
        listName: 'Pedidos novembro',
        mapping: JSON.stringify({ name: 'Primeiro nome', attributes: { pedido: 'Pedido' } }),
      },
      { name: 'pedidos.xlsx', content },
    );
    expect(imp).toMatchObject({ status: 'preview', rowCount: 3, validCount: 3, existingCount: 1 });
    await api(operator, 'POST', `/tenants/${A}/imports/${imp.id}/confirm`, {
      listName: 'Pedidos 11/2026',
    });
    await processor.drain();
    const done = (await api(viewer, 'GET', `/tenants/${A}/imports/${imp.id}`)).json();
    const list = (await api(viewer, 'GET', `/tenants/${A}/lists/${done.listId}`)).json();
    expect(list).toMatchObject({ name: 'Pedidos 11/2026', size: 3 });
    const [joao] = await h.admin<{ name: string; attributes: Record<string, string>; n: number }[]>`
      select name, attributes, (select count(*)::int from contacts where tenant_id = ${A}) as n
        from contacts where tenant_id = ${A} and phone_e164 = '+5511987654321'`;
    expect(joao).toMatchObject({
      name: 'João Silva',
      attributes: { cidade: 'São Paulo', pedido: 'A-100' },
      n: 4,
    });
  });

  it('TXT de uma coluna, sem cabeçalho', async () => {
    const { imp } = await importAndPreview(
      A,
      { ...DECL, listName: 'TXT' },
      {
        name: 'numeros.txt',
        content: Buffer.from('11912340001\n11912340002\n\n11912340001\nabc\n'),
      },
    );
    expect(imp).toMatchObject({ rowCount: 4, validCount: 2, duplicateCount: 1, invalidCount: 1 });
    expect(imp.mapping).toMatchObject({ hasHeader: false, phone: 1 });
  });

  it('cancelar descarta a prévia; outro cliente não enxerga nada de A', async () => {
    const { imp } = await importAndPreview(
      A,
      { ...DECL, listName: 'Cancelar' },
      { name: 'c.csv', content: Buffer.from('telefone\n11912349999\n') },
    );
    expect((await api(viewer, 'DELETE', `/tenants/${A}/imports/${imp.id}`)).statusCode).toBe(403);
    const del = await api(operator, 'DELETE', `/tenants/${A}/imports/${imp.id}`);
    expect(del.json().status).toBe('cancelled');
    expect(
      await h.admin`select 1 from contact_import_rows where import_id = ${imp.id}`,
    ).toHaveLength(0);
    expect(
      (await api(operator, 'POST', `/tenants/${A}/imports/${imp.id}/confirm`, {})).statusCode,
    ).toBe(409);

    expect((await api(viewer, 'GET', `/tenants/${B}/imports/${importId}`)).statusCode).toBe(404);
    expect((await api(viewer, 'GET', `/tenants/${B}/lists/${listId}`)).statusCode).toBe(404);
    expect((await api(viewer, 'GET', `/tenants/${B}/lists`)).json().data).toHaveLength(0);
    // o mesmo telefone suprimido em A não é suprimido em B (hash por cliente)
    const { imp: impB } = await importAndPreview(B, DECL, {
      name: 'b.csv',
      content: Buffer.from('telefone\n31988887777\n'),
    });
    expect(impB).toMatchObject({ validCount: 1, suppressedCount: 0 });
  });

  it('supressão manual tira o contato das listas existentes; é idempotente e auditada mascarada', async () => {
    const before = (await api(viewer, 'GET', `/tenants/${A}/lists/${listId}`)).json().size;
    const s = await api(operator, 'POST', `/tenants/${A}/suppressions`, { phone: '11 98765-4321' });
    expect(s.json()).toMatchObject({
      created: true,
      removedFromLists: 2,
      phoneMasked: '+55119****4321',
    });
    expect((await api(viewer, 'GET', `/tenants/${A}/lists/${listId}`)).json().size).toBe(
      before - 1,
    );
    const again = await api(operator, 'POST', `/tenants/${A}/suppressions`, {
      phone: '+5511987654321',
    });
    expect(again.json()).toMatchObject({ created: false, removedFromLists: 0 });
    const list = (await api(viewer, 'GET', `/tenants/${A}/suppressions`)).json();
    expect(list.total).toBe(3);
    expect(
      (await api(viewer, 'POST', `/tenants/${A}/suppressions`, { phone: '11999999999' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await api(operator, 'POST', `/tenants/${A}/suppressions`, { phone: '123' })).statusCode,
    ).toBe(400);
    const audit = await h.admin`select after from audit_logs where tenant_id = ${A}`;
    expect(JSON.stringify(audit)).not.toMatch(/987654321|988887777|999990000/);
  });
});

describe('limites do upload', () => {
  let small: Harness;
  beforeAll(async () => {
    small = await createHarness({ env: { IMPORT_MAX_BYTES: '1000', IMPORT_MAX_ROWS: '3' } });
  });
  afterAll(async () => {
    await small?.close();
  });

  it('arquivo grande demais → 413; linhas demais → falha na análise', async () => {
    const op = await small.login(await small.createUser('operator'));
    const ow = await small.login(await small.createUser('owner'));
    const t = (
      await small.app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: { cookie: ow },
        payload: { name: 'L' },
      })
    ).json().id;
    const send = (content: Buffer) => {
      const m = multipart(DECL, { name: 'g.csv', content });
      return small.app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${t}/imports`,
        headers: { cookie: op, ...m.headers },
        payload: m.payload,
      });
    };
    const big = await send(Buffer.from(`telefone\n${'11987654321\n'.repeat(200)}`));
    expect(big.statusCode).toBe(413);
    expect(await small.admin`select 1 from contact_imports`).toHaveLength(0);

    const r = await send(
      Buffer.from('telefone\n11900000001\n11900000002\n11900000003\n11900000004\n'),
    );
    expect(r.statusCode).toBe(202);
    await small.app.get(ImportProcessor).drain();
    const imp = await small.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${t}/imports/${r.json().id}`,
      headers: { cookie: op },
    });
    expect(imp.json()).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('mais de 3 linhas'),
    });
  });
});
