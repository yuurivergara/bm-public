import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignEngine } from '../campaigns/campaign-engine.service';
import { isOptOutText } from '../campaigns/message-handlers';
import { analyzeTemplate, resolveParams } from '../campaigns/render';
import { ImportProcessor } from '../contacts/import-processor.service';
import { WebhookProcessor } from '../webhooks/webhook-processor.service';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

/** S5 — campanhas: envio, status por webhook, opt-out, capacidade e pausas automáticas. */
let sim: MetaSim;
let h: Harness;
let webhookUrl: string;
let owner: string;
let operator: string;
let viewer: string;
let tenantId: string;
let phoneId: string;
let templateId: string;
let engine: CampaignEngine;
let webhooks: WebhookProcessor;
const IDS = { biz: '506914307656700', waba: '102290129340700', pn: '106540352242700' };

const api = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({
    method,
    url: `/api/v1/tenants/${tenantId}${url}`,
    headers: { cookie },
    payload: payload as object,
  });

function multipart(fields: Record<string, string>, file: { name: string; content: string }) {
  const boundary = '----bmcampaigns';
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: text/csv\r\n\r\n${file.content}\r\n--${boundary}--\r\n`,
  );
  return {
    payload: Buffer.from(parts.join('')),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Importa um CSV e devolve o id da lista confirmada. */
async function importList(name: string, csv: string): Promise<string> {
  const m = multipart(
    {
      listName: name,
      originDeclaration: 'customers',
      legalBasis: 'legitimo_interesse',
      declarationAccepted: 'true',
      mapping: JSON.stringify({ phone: 'telefone', name: 'nome', attributes: { loja: 'loja' } }),
    },
    { name: 'lista.csv', content: csv },
  );
  const up = await h.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/imports`,
    headers: { cookie: operator, ...m.headers },
    payload: m.payload,
  });
  expect(up.statusCode, up.body).toBe(202);
  const proc = h.app.get(ImportProcessor);
  await proc.drain();
  await api(operator, 'POST', `/imports/${up.json().id}/confirm`, {});
  await proc.drain();
  return (await api(viewer, 'GET', `/imports/${up.json().id}`)).json().listId;
}

async function simPost(path: string, body: unknown) {
  const r = await sim.app.inject({ method: 'POST', url: path, payload: body as object });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

const sentTo = () => [...sim.state.messages.values()].map((m) => m.to).sort();
const recipients = async (campaignId: string) =>
  (await api(viewer, 'GET', `/campaigns/${campaignId}/recipients?limit=500`)).json().data as {
    phoneMasked: string;
    status: string;
    errorCode: number | null;
  }[];

const VARIABLES = {
  '1': { source: 'name', fallback: 'cliente' },
  '2': { source: 'attribute', value: 'loja' },
};

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl });
  await h.app.listen(0, '127.0.0.1');
  const apiUrl = (await h.app.getUrl()).replace('[::1]', '127.0.0.1');
  webhookUrl = `${apiUrl}/webhooks/meta`;
  owner = await h.login(await h.createUser('owner'));
  operator = await h.login(await h.createUser('operator'));
  viewer = await h.login(await h.createUser('viewer'));
  engine = h.app.get(CampaignEngine);
  webhooks = h.app.get(WebhookProcessor);
  const { token } = sim.state.addFixture(
    {
      business: { id: IDS.biz, name: 'Loja Campanhas' },
      wabas: [
        {
          id: IDS.waba,
          name: 'Loja Campanhas',
          phone_numbers: [
            {
              id: IDS.pn,
              display_phone_number: '+55 11 3000-0700',
              verified_name: 'Loja',
              status: 'CONNECTED',
            },
          ],
        },
      ],
    },
    sim.appId,
  );
  tenantId = (
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie: owner },
      payload: { name: 'Loja Campanhas' },
    })
  ).json().id;
  const c = await api(owner, 'POST', '/assets/partner-share', {
    businessId: IDS.biz,
    wabaId: IDS.waba,
    accessToken: token,
  });
  expect(c.statusCode, c.body).toBe(201);
  const waba = c.json().portfolios[0].wabas[0];
  phoneId = waba.phoneNumbers[0].id;
  const t = await api(operator, 'POST', '/templates', {
    wabaId: waba.id,
    name: 'oferta_semana',
    language: 'pt_BR',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: 'Oi {{1}}! A {{2}} preparou ofertas para você.',
        example: { body_text: [['Ana', 'Loja Centro']] },
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Parar promoções' }] },
    ],
  });
  expect(t.statusCode, t.body).toBe(201);
  templateId = t.json().id;
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

describe('regras puras', () => {
  it('analisa placeholders e recusa o que ainda não tem formato de envio validado', () => {
    const a = analyzeTemplate([{ type: 'BODY', text: 'Oi {{2}} e {{1}} e {{2}}' }], 'POSITIONAL');
    expect(a.placeholders).toEqual(['1', '2']);
    expect(
      analyzeTemplate(
        [
          { type: 'HEADER', format: 'IMAGE' },
          { type: 'BODY', text: 'x' },
        ],
        'POSITIONAL',
      ).unsupported,
    ).toMatch(/imagem/);
    const named = analyzeTemplate([{ type: 'BODY', text: 'Oi {{first_name}}' }], 'NAMED');
    expect(
      resolveParams(
        named,
        { first_name: { source: 'name' } },
        { name: ' Ana\n Maria ', attributes: {} },
      ),
    ).toEqual({ ok: true, params: [{ name: 'first_name', text: 'Ana Maria' }] });
    expect(
      resolveParams(named, { first_name: { source: 'name' } }, { name: '', attributes: {} }).ok,
    ).toBe(false);
  });

  it('opt-out por texto só com a palavra-chave inteira', () => {
    expect(isOptOutText('SAIR')).toBe(true);
    expect(isOptOutText('  Não quero!! ')).toBe(true);
    expect(isOptOutText('parece bom, quero sim')).toBe(false);
    expect(isOptOutText('quero sair da fila do pedido 123')).toBe(false);
  });
});

describe('campanhas', () => {
  let listId: string;
  let campaignId: string;

  it('valida modelo aprovado, variáveis e permissão', async () => {
    listId = await importList(
      'Clientes',
      [
        'nome,telefone,loja',
        'Ana,11 91111-0001,Loja Centro',
        ',11 91111-0002,Loja Centro', // sem nome → fallback
        'Bia,11 91111-0003,', // sem loja → variável vazia → pulado
        'Caio,11 91111-0004,Loja Sul',
        'Dani,11 91111-0005,Loja Sul',
      ].join('\n'),
    );
    const base = {
      name: 'Ofertas',
      listId,
      templateId,
      phoneNumberId: phoneId,
      variables: VARIABLES,
    };
    const pending = await api(operator, 'POST', '/campaigns', base);
    expect(pending.statusCode).toBe(422);
    expect(pending.json().code).toBe('template_not_approved');

    const metaId = (
      await h.admin<{ id: string }[]>`
      select meta_template_id as id from message_templates where id = ${templateId}`
    )[0]?.id;
    await simPost(`/_sim/templates/${metaId}/review`, { event: 'APPROVED' });
    expect((await api(operator, 'POST', '/templates/sync', {})).statusCode).toBe(200);

    const missing = await api(operator, 'POST', '/campaigns', {
      ...base,
      variables: { '1': VARIABLES['1'] },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({
      code: 'variables_missing',
      details: { missing: ['2'] },
    });
    expect((await api(viewer, 'POST', '/campaigns', base)).statusCode).toBe(403);

    const ok = await api(operator, 'POST', '/campaigns', base);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({
      status: 'draft',
      listName: 'Clientes',
      templateName: 'oferta_semana',
    });
    campaignId = ok.json().id;
    expect((await api(viewer, 'GET', `/campaigns/${campaignId}/preview`)).json().body).toBe(
      'Oi Ana! A Loja Centro preparou ofertas para você.',
    );
  });

  it('inicia sem contatos suprimidos, envia com variáveis e respeita o estado', async () => {
    await api(operator, 'POST', '/suppressions', { phone: '11 91111-0005' }); // Dani saiu
    const s = await api(operator, 'POST', `/campaigns/${campaignId}/start`, {});
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ status: 'running', audienceSize: 4 });
    expect((await api(operator, 'POST', `/campaigns/${campaignId}/start`, {})).statusCode).toBe(
      409,
    );

    await engine.drain();
    expect(sentTo()).toEqual(['5511911110001', '5511911110002', '5511911110004']);
    const params = [...sim.state.messages.values()].map((m) =>
      (m.template.parameters as { text: string }[]).map((p) => p.text).join('|'),
    );
    expect(params.sort()).toEqual(['Ana|Loja Centro', 'Caio|Loja Sul', 'cliente|Loja Centro']);
    const c = (await api(viewer, 'GET', `/campaigns/${campaignId}`)).json();
    expect(c).toMatchObject({
      status: 'completed',
      counts: { total: 4, sent: 3, skipped: 1, pending: 0 },
    });
    const rs = await recipients(campaignId);
    expect(rs.find((r) => r.status === 'skipped')).toMatchObject({ phoneMasked: '+55119****0003' });
    expect(JSON.stringify(rs)).not.toContain('911110001');
    const usage = await h.admin`select 1 from capacity_usage where tenant_id = ${tenantId}`;
    expect(usage).toHaveLength(3);
  });

  it('status por webhook: sent → delivered → read, sem regredir; falha marca o contato inválido', async () => {
    const [m1, m2, m3] = [...sim.state.messages.values()].sort((a, b) => a.to.localeCompare(b.to));
    for (const st of ['sent', 'delivered', 'read', 'delivered']) {
      await simPost(`/_sim/messages/${encodeURIComponent(m1?.wamid ?? '')}/status`, {
        status: st,
        url: webhookUrl,
      });
    }
    await simPost(`/_sim/messages/${encodeURIComponent(m2?.wamid ?? '')}/status`, {
      status: 'delivered',
      url: webhookUrl,
    });
    await simPost(`/_sim/messages/${encodeURIComponent(m3?.wamid ?? '')}/status`, {
      status: 'failed',
      errorCode: 131026,
      url: webhookUrl,
    });
    // o segundo `delivered` (depois do read) é descartado como duplicado
    expect(await webhooks.drain()).toMatchObject({ processed: 5, ignored: 1, failed: 0 });
    const c = (await api(viewer, 'GET', `/campaigns/${campaignId}`)).json();
    expect(c.counts).toMatchObject({ read: 1, delivered: 1, failed: 1, sent: 0 });
    const invalid = await h.admin`
      select 1 from contacts where tenant_id = ${tenantId} and invalid_at is not null`;
    expect(invalid).toHaveLength(1);
  });

  it('opt-out: botão, palavra-chave e preferência de marketing viram supressão permanente', async () => {
    await simPost('/_sim/inbound', {
      phoneId: IDS.pn,
      from: '5511911110001',
      button: 'Parar promoções',
      url: webhookUrl,
    });
    await simPost('/_sim/inbound', {
      phoneId: IDS.pn,
      from: '5511911110002',
      text: 'parece ótimo!',
      url: webhookUrl,
    });
    await simPost('/_sim/inbound', {
      phoneId: IDS.pn,
      from: '5511911110004',
      text: 'SAIR',
      url: webhookUrl,
    });
    await simPost('/_sim/user-preferences', {
      phoneId: IDS.pn,
      waId: '5511911110003',
      value: 'stop',
      url: webhookUrl,
    });
    await webhooks.drain();
    const rows = await h.admin<{ phone_masked: string; reason: string }[]>`
      select phone_masked, reason from suppressions where tenant_id = ${tenantId} order by phone_masked`;
    expect(rows).toEqual([
      { phone_masked: '+55119****0001', reason: 'opt_out_button' },
      { phone_masked: '+55119****0003', reason: 'marketing_opt_out' },
      { phone_masked: '+55119****0004', reason: 'opt_out_keyword' },
      { phone_masked: '+55119****0005', reason: 'manual' },
    ]);
    const list = (await api(viewer, 'GET', `/lists/${listId}`)).json();
    expect(list.size).toBe(1); // só sobrou o 0002
  });
});

describe('capacidade e pausas automáticas', () => {
  let listId: string;
  const ids: string[] = [];

  const newCampaign = async (name: string) => {
    const r = await api(operator, 'POST', '/campaigns', {
      name,
      listId,
      templateId,
      phoneNumberId: phoneId,
      variables: VARIABLES,
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = await api(operator, 'POST', `/campaigns/${r.json().id}/start`, {});
    expect(s.statusCode, s.body).toBe(200);
    ids.push(r.json().id);
    return r.json().id as string;
  };

  it('nunca passa do limite de 24 h × margem; quem já recebeu na janela não consome vaga', async () => {
    const rows = ['nome,telefone,loja', 'Ana,11 91111-0002,Loja'];
    for (let i = 10; i < 16; i++) rows.push(`P${i},11 92222-00${i},Loja`);
    listId = await importList('Capacidade', rows.join('\n'));
    // limite 4 × 0,9 = 3; 3 já usados (janela) → sobra 0 para números novos
    await h.admin`update business_portfolios set messaging_limit_value = 4 where tenant_id = ${tenantId}`;
    // fora do limite de pares (1 msg a cada 6 s), ainda dentro da janela de 24 h
    await h.admin`update capacity_usage set last_sent_at = now() - interval '1 minute'`;
    const before = sim.state.messages.size;
    const id = await newCampaign('Capacidade');
    await engine.drain();
    const c = (await api(viewer, 'GET', `/campaigns/${id}`)).json();
    // 0002 já estava na janela de 24 h: vai; os 6 novos esperam vaga
    expect(sim.state.messages.size - before).toBe(1);
    expect(c).toMatchObject({ status: 'running', counts: { sent: 1, pending: 6 } });
    const cap = (await api(viewer, 'GET', '/capacity')).json();
    expect(cap).toMatchObject({ limit: 3, used24h: 3, available: 0 });

    await h.admin`update business_portfolios set messaging_limit_value = 6 where tenant_id = ${tenantId}`;
    await h.admin`update campaign_dispatch set next_run_at = now() where campaign_id = ${id}`;
    await engine.drain();
    expect((await api(viewer, 'GET', '/capacity')).json()).toMatchObject({ limit: 5, used24h: 5 });
    expect((await api(viewer, 'GET', `/campaigns/${id}`)).json().counts).toMatchObject({
      sent: 3,
      pending: 4,
    });
  });

  it('limite de spam (131048) pausa a campanha com motivo; retomar continua', async () => {
    const id = ids[0] as string;
    await h.admin`update business_portfolios set messaging_limit_value = null, messaging_limit_tier = 'TIER_UNLIMITED' where tenant_id = ${tenantId}`;
    sim.state.errors.push({
      method: 'POST',
      pathIncludes: '/messages',
      status: 400,
      error: { message: 'Spam rate limit hit', code: 131048 },
    });
    await h.admin`update campaign_dispatch set next_run_at = now() where campaign_id = ${id}`;
    await engine.drain();
    const paused = (await api(viewer, 'GET', `/campaigns/${id}`)).json();
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toMatch(/spam.*131048/i);
    // o destinatário da falha voltou para a fila; os que já estavam em voo no lote terminaram
    expect(paused.counts.pending).toBeGreaterThan(0);
    const [back] = await h.admin<{ n: number }[]>`
      select count(*)::int as n from campaign_recipients
       where campaign_id = ${id} and status = 'pending' and attempts = 0`;
    expect(back?.n).toBe(paused.counts.pending);

    expect((await api(operator, 'POST', `/campaigns/${id}/resume`, {})).json().status).toBe(
      'running',
    );
    await engine.drain();
    expect((await api(viewer, 'GET', `/campaigns/${id}`)).json()).toMatchObject({
      status: 'completed',
      counts: { sent: 7, pending: 0 },
    });
  });

  it('throughput (130429) é repetido mais tarde; token inválido (190) pausa o cliente e marca a conexão', async () => {
    await h.admin`update capacity_usage set last_sent_at = now() - interval '1 minute'`;
    const id = await newCampaign('Erros');
    sim.state.errors.push({
      method: 'POST',
      pathIncludes: '/messages',
      status: 400,
      error: { message: 'Rate limit hit', code: 130429 },
    });
    await engine.tick();
    const rs = await h.admin<
      { status: string; error_code: number | null; next_attempt_at: Date | null }[]
    >`
      select status, error_code, next_attempt_at from campaign_recipients
       where campaign_id = ${id} and error_code = 130429`;
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: 'pending' });
    expect(rs[0]?.next_attempt_at?.getTime()).toBeGreaterThan(Date.now());

    sim.state.errors.push({
      method: 'POST',
      pathIncludes: '/messages',
      status: 401,
      error: { message: 'Error validating access token', code: 190 },
      times: 50,
    });
    await h.admin`update campaign_recipients set next_attempt_at = null where campaign_id = ${id}`;
    await h.admin`update capacity_usage set last_sent_at = now() - interval '1 minute'`;
    await h.admin`update campaign_dispatch set next_run_at = now() where campaign_id = ${id}`;
    await engine.drain();
    const c = (await api(viewer, 'GET', `/campaigns/${id}`)).json();
    expect(c.status).toBe('paused');
    expect(c.pauseReason).toMatch(/cliente.*190/);
    const [conn] = await h.admin<{ status: string }[]>`
      select status from meta_connections where tenant_id = ${tenantId}`;
    expect(conn?.status).toBe('broken');
    expect((await api(operator, 'POST', `/campaigns/${id}/resume`, {})).statusCode).toBe(200);
    await engine.drain(); // conexão quebrada → pausa de novo antes de chamar a Meta
    expect((await api(viewer, 'GET', `/campaigns/${id}`)).json().pauseReason).toMatch(/reconecte/);
    sim.state.errors.length = 0;
  });

  it('cancelar marca pendentes como cancelados; outro cliente não vê nada', async () => {
    const id = ids[ids.length - 1] as string;
    const r = await api(operator, 'POST', `/campaigns/${id}/cancel`, {});
    expect(r.json()).toMatchObject({ status: 'cancelled', counts: { pending: 0 } });
    expect(r.json().counts.cancelled).toBeGreaterThan(0);
    expect((await api(operator, 'POST', `/campaigns/${id}/resume`, {})).statusCode).toBe(409);

    const other = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: { cookie: owner },
        payload: { name: 'Outro' },
      })
    ).json().id;
    const get = await h.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${other}/campaigns/${id}`,
      headers: { cookie: viewer },
    });
    expect(get.statusCode).toBe(404);
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${other}/campaigns`,
      headers: { cookie: viewer },
    });
    expect(list.json().data).toHaveLength(0);
  });
});
