import { GraphHttp, MetaApiError, verifyMetaSignature } from '@bm/meta-client';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMetaSim, type MetaSim } from './sim';

const SECRET = 'segredo-do-app-sim';
const VERSION = 'v99.0';
let sim: MetaSim;
let base: string;
let token: string;

const http = (appSecret = SECRET) =>
  new GraphHttp({ baseUrl: base, graphVersion: VERSION, appSecret, timeoutMs: 2000 });

beforeAll(async () => {
  sim = createMetaSim({ appSecret: SECRET, graphVersion: VERSION });
  base = await sim.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await sim.app.close();
});
beforeEach(() => {
  sim.state.reset();
  ({ token } = sim.state.addFixture(
    {
      business: { id: 'BIZ1', name: 'Loja', verification_status: 'verified' },
      wabas: [
        {
          id: 'WABA1',
          name: 'Loja WABA',
          currency: 'BRL',
          phone_numbers: [
            { id: 'PN1', display_phone_number: '+55 11 90000-0001', quality_rating: 'GREEN' },
          ],
        },
      ],
    },
    sim.appId,
  ));
});

describe('meta-sim — Graph API', () => {
  it('lê objetos filtrando por fields', async () => {
    const res = await http().request(token, 'GET', '/WABA1', {
      query: { fields: 'name,currency' },
    });
    expect(res.data).toEqual({ id: 'WABA1', name: 'Loja WABA', currency: 'BRL' });
  });

  it('lista números da WABA', async () => {
    const res = await http().request<{ data: { id: string }[] }>(
      token,
      'GET',
      '/WABA1/phone_numbers',
    );
    expect(res.data.data.map((p) => p.id)).toEqual(['PN1']);
  });

  it('assina e lista subscribed_apps', async () => {
    await http().request(token, 'POST', '/WABA1/subscribed_apps');
    const res = await http().request<{ data: unknown[] }>(token, 'GET', '/WABA1/subscribed_apps');
    expect(res.data.data).toHaveLength(1);
  });

  it('exige appsecret_proof válido (code 100) e token válido (code 190)', async () => {
    const e1 = (await http('outro')
      .request(token, 'GET', '/WABA1')
      .catch((e) => e)) as MetaApiError;
    expect(e1).toBeInstanceOf(MetaApiError);
    expect(e1.code).toBe(100);
    const e2 = (await http()
      .request('desconhecido', 'GET', '/WABA1')
      .catch((e) => e)) as MetaApiError;
    expect(e2.code).toBe(190);
  });

  it('nega objeto fora do alcance do token', async () => {
    const other = sim.state.addFixture(
      { business: { id: 'BIZ2' }, wabas: [{ id: 'WABA2' }] },
      sim.appId,
    );
    const e = (await http()
      .request(token, 'GET', '/WABA2')
      .catch((x) => x)) as MetaApiError;
    expect(e.code).toBe(100);
    expect((await http().request(other.token, 'GET', '/WABA2')).data).toMatchObject({
      id: 'WABA2',
    });
  });

  it('aplica erro injetado uma vez', async () => {
    sim.state.errors.push({
      pathIncludes: '/phone_numbers',
      status: 400,
      error: { message: 'Rate limit', code: 80008 },
    });
    const e = (await http()
      .request(token, 'GET', '/WABA1/phone_numbers')
      .catch((x) => x)) as MetaApiError;
    expect(e.code).toBe(80008);
    await expect(http().request(token, 'GET', '/WABA1/phone_numbers')).resolves.toBeTruthy();
  });

  it('rejeita versão diferente da configurada', async () => {
    const wrong = new GraphHttp({ baseUrl: base, graphVersion: 'v1.0', appSecret: SECRET });
    const e = (await wrong.request(token, 'GET', '/WABA1').catch((x) => x)) as MetaApiError;
    expect(e).toBeInstanceOf(MetaApiError);
  });

  it('nunca grava o appsecret_proof no log de requisições', async () => {
    await http().request(token, 'GET', '/WABA1');
    expect(JSON.stringify(sim.state.requests)).not.toContain('appsecret_proof":"');
  });
});

describe('meta-sim — operação', () => {
  it('expõe /healthz sem exigir versão nem token', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe('meta-sim — webhooks', () => {
  it('emite webhook assinado com o app secret sobre o corpo bruto', async () => {
    const receiver = Fastify();
    let valid: boolean | undefined;
    let received: unknown;
    receiver.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    receiver.post('/hook', async (req) => {
      const raw = req.body as Buffer;
      valid = verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string, SECRET);
      received = JSON.parse(raw.toString());
      return 'ok';
    });
    const url = await receiver.listen({ host: '127.0.0.1', port: 0 });
    try {
      const r = await sim.emitWebhook(`${url}/hook`, {
        entryId: 'WABA1',
        field: 'account_update',
        value: { event: 'X' },
      });
      expect(r.statuses).toEqual([200]);
      expect(valid).toBe(true);
      expect(received).toMatchObject({
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA1', changes: [{ field: 'account_update', value: { event: 'X' } }] }],
      });
    } finally {
      await receiver.close();
    }
  });
});
