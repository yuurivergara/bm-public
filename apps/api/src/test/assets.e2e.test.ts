import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

let sim: MetaSim;
let h: Harness;
let ownerCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl, captureLogs: true });
  ownerCookie = await h.login(await h.createUser('owner'));
  viewerCookie = await h.login(await h.createUser('viewer'));
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

let seq = 0;
/** Cria fixture no sim com IDs únicos e devolve IDs + token. */
function fixture(opts: { quality?: string } = {}) {
  seq++;
  const n = String(seq).padStart(6, '0');
  // IDs reais da Meta são numéricos (15–17 dígitos)
  const ids = { biz: `5069143${n}01`, waba: `1022901${n}02`, pn: `1065403${n}03` };
  const { token } = sim.state.addFixture(
    {
      business: {
        id: ids.biz,
        name: `Loja ${seq}`,
        verification_status: 'verified',
        whatsapp_business_manager_messaging_limit: 'TIER_2K',
      },
      wabas: [
        {
          id: ids.waba,
          name: `WABA ${seq}`,
          currency: 'BRL',
          timezone_id: '25',
          account_review_status: 'APPROVED',
          phone_numbers: [
            {
              id: ids.pn,
              display_phone_number: `+55 11 9${String(1000_0000 + seq).slice(-8)}`,
              verified_name: `Loja ${seq}`,
              name_status: 'APPROVED',
              quality_rating: opts.quality ?? 'GREEN',
              code_verification_status: 'VERIFIED',
              status: 'CONNECTED',
              throughput: { level: 'STANDARD' },
              whatsapp_business_manager_messaging_limit: 'TIER_2K',
            },
          ],
        },
      ],
    },
    sim.appId,
  );
  return { ...ids, token };
}

async function newTenant(name = 'Cliente') {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie: ownerCookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const connect = (tenantId: string, body: unknown, cookie = ownerCookie) =>
  h.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/assets/partner-share`,
    headers: { cookie },
    payload: body as object,
  });

beforeEach(() => {
  sim.state.requests.length = 0;
});

describe('cadastro de ativos por parceria/manual', () => {
  it('valida na Meta, inscreve webhooks e grava portfolio, WABA, número e conexão cifrada', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    const res = await connect(tenantId, {
      businessId: f.biz,
      wabaId: f.waba,
      accessToken: f.token,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.portfolios).toHaveLength(1);
    expect(body.portfolios[0]).toMatchObject({
      metaBusinessId: f.biz,
      verificationStatus: 'verified',
      messagingLimitTier: 'TIER_2K',
      messagingLimitValue: 2000,
    });
    const waba = body.portfolios[0].wabas[0];
    expect(waba).toMatchObject({ metaWabaId: f.waba, currency: 'BRL', webhooksSubscribed: true });
    expect(waba.phoneNumbers[0]).toMatchObject({
      metaPhoneNumberId: f.pn,
      qualityRating: 'GREEN',
      status: 'connected',
      throughputLevel: 'STANDARD',
      messagingLimitTier: 'TIER_2K',
    });
    expect(waba.phoneNumbers[0].phoneE164).toMatch(/^\+5511\d{9}$/);
    expect(body.connections[0]).toMatchObject({ status: 'active', tokenLast4: f.token.slice(-4) });

    // inscreveu o app nos webhooks
    expect(
      sim.state.requests.some((r) => r.method === 'POST' && r.path.endsWith('/subscribed_apps')),
    ).toBe(true);
    // nada de token na resposta, no banco em claro, na auditoria ou nos logs
    expect(res.body).not.toContain(f.token);
    const [conn] = await h.admin<{ access_token_enc: Buffer }[]>`
      select access_token_enc from meta_connections where tenant_id = ${tenantId}`;
    expect(conn?.access_token_enc.toString('latin1')).not.toContain(f.token);
    const audit = await h.admin<{ action: string; after: unknown }[]>`
      select action, after from audit_logs where tenant_id = ${tenantId}`;
    expect(audit.map((a) => a.action)).toContain('assets.connect');
    expect(JSON.stringify(audit)).not.toContain(f.token);
    expect(h.logs().join('\n')).not.toContain(f.token);

    // rotas de webhook registradas
    const routes = await h.admin<{ meta_id: string }[]>`
      select meta_id from meta_asset_routes where tenant_id = ${tenantId} order by meta_id`;
    expect(routes.map((r) => r.meta_id).sort()).toEqual([f.biz, f.pn, f.waba].sort());
  });

  it('é idempotente para o mesmo cliente', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    const body = { businessId: f.biz, wabaId: f.waba, accessToken: f.token };
    expect((await connect(tenantId, body)).statusCode).toBe(201);
    expect((await connect(tenantId, body)).statusCode).toBe(201);
    const [{ n } = { n: -1 }] = await h.admin<{ n: number }[]>`
      select count(*)::int as n from phone_numbers where tenant_id = ${tenantId}`;
    expect(n).toBe(1);
    const [{ c } = { c: -1 }] = await h.admin<{ c: number }[]>`
      select count(*)::int as c from meta_connections where tenant_id = ${tenantId}`;
    expect(c).toBe(1);
  });

  it('recusa WABA já vinculada a outro cliente (409)', async () => {
    const f = fixture();
    const a = await newTenant('A');
    const b = await newTenant('B');
    const body = { businessId: f.biz, wabaId: f.waba, accessToken: f.token };
    expect((await connect(a, body)).statusCode).toBe(201);
    const res = await connect(b, body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('asset_owned_by_other_tenant');
  });

  it('token inválido → 422 meta_token_invalid, nada gravado', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    const res = await connect(tenantId, {
      businessId: f.biz,
      wabaId: f.waba,
      accessToken: 'EAAinvalidoQueNaoExisteNoSim123456',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('meta_token_invalid');
    const [{ n } = { n: -1 }] = await h.admin<{ n: number }[]>`
      select count(*)::int as n from whatsapp_accounts where tenant_id = ${tenantId}`;
    expect(n).toBe(0);
  });

  it('WABA fora do alcance do token → 422 meta_asset_not_accessible', async () => {
    const f = fixture();
    const g = fixture();
    const tenantId = await newTenant();
    const res = await connect(tenantId, {
      businessId: f.biz,
      wabaId: g.waba,
      accessToken: f.token,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('meta_asset_not_accessible');
  });

  it('viewer lê, mas não cadastra', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    const body = { businessId: f.biz, wabaId: f.waba, accessToken: f.token };
    expect((await connect(tenantId, body, viewerCookie)).statusCode).toBe(403);
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/assets`,
      headers: { cookie: viewerCookie },
    });
    expect(list.statusCode).toBe(200);
  });

  it('valida a entrada (IDs numéricos/strings curtas e token obrigatório)', async () => {
    const tenantId = await newTenant();
    const res = await connect(tenantId, { businessId: '', wabaId: 'x', accessToken: '' });
    expect(res.statusCode).toBe(400);
  });
});

describe('sincronização de limites/qualidade', () => {
  it('atualiza qualidade do número e registra o sinal de saúde', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    await connect(tenantId, { businessId: f.biz, wabaId: f.waba, accessToken: f.token });
    const obj = sim.state.objects.get(f.pn);
    if (obj) obj.data.quality_rating = 'YELLOW';
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/assets/sync`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const phone = res.json().portfolios[0].wabas[0].phoneNumbers[0];
    expect(phone.qualityRating).toBe('YELLOW');
    const health = await h.admin<{ quality_rating: string; source: string }[]>`
      select quality_rating, source from account_health
      where tenant_id = ${tenantId} and entity_type = 'phone_number' order by id`;
    expect(health.map((x) => x.quality_rating)).toEqual(['GREEN', 'YELLOW']);
  });

  it('token revogado marca a conexão como broken', async () => {
    const f = fixture();
    const tenantId = await newTenant();
    await connect(tenantId, { businessId: f.biz, wabaId: f.waba, accessToken: f.token });
    const info = sim.state.tokens.get(f.token);
    if (info) info.valid = false;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/assets/sync`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connections[0].status).toBe('broken');
    expect(res.json().syncErrors[0]).toMatchObject({ code: 'meta_token_invalid' });
  });
});
