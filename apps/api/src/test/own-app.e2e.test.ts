import { signMetaPayload } from '@bm/meta-client';
import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

/**
 * Cliente com app próprio na BM dele (ponte até o Tech Provider): o token é de outro app, então o
 * appsecret_proof e os webhooks usam o App Secret do cliente, guardado cifrado na conexão.
 */
const CLIENT_SECRET = '0123456789abcdef0123456789abcdef';
const CLIENT_APP = '2000000000000002';
const IDS = { biz: '506914307656800', waba: '102290129340800', pn: '106540352242800' };
let sim: MetaSim;
let h: Harness;
let owner: string;
let tenantId: string;
let token: string;

const connect = (extra: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/assets/partner-share`,
    headers: { cookie: owner },
    payload: {
      businessId: IDS.biz,
      wabaId: IDS.waba,
      accessToken: token,
      method: 'manual',
      ...extra,
    },
  });

const webhook = (entryId: string, secret: string) => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: entryId,
        time: 1751247548,
        changes: [{ field: 'account_review_update', value: { decision: 'APPROVED' } }],
      },
    ],
  });
  return h.app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signMetaPayload(body, secret),
    },
    payload: body,
  });
};

beforeAll(async () => {
  // o "app do cliente": a Graph (sim) confere o proof com o secret DELE
  sim = createMetaSim({
    appSecret: CLIENT_SECRET,
    graphVersion: META_GRAPH_VERSION,
    appId: CLIENT_APP,
  });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl });
  owner = await h.login(await h.createUser('owner'));
  ({ token } = sim.state.addFixture(
    {
      business: { id: IDS.biz, name: 'Cliente App Próprio' },
      wabas: [
        {
          id: IDS.waba,
          name: 'Cliente',
          phone_numbers: [
            { id: IDS.pn, display_phone_number: '+55 11 3000-0800', status: 'CONNECTED' },
          ],
        },
      ],
    },
    CLIENT_APP,
  ));
  tenantId = (
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie: owner },
      payload: { name: 'Cliente App Próprio' },
    })
  ).json().id;
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

describe('app próprio do cliente', () => {
  it('sem o App Secret do cliente a Meta recusa o proof; com ele conecta e nunca devolve o secret', async () => {
    const without = await connect({});
    expect(without.statusCode).toBeGreaterThanOrEqual(400);
    expect((await connect({ appSecret: CLIENT_SECRET })).statusCode).toBe(400); // exige o appId junto
    const ok = await connect({ appId: CLIENT_APP, appSecret: CLIENT_SECRET });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(JSON.stringify(ok.json())).not.toContain(CLIENT_SECRET);
    const [conn] = await h.admin<{ meta_app_id: string; enc: Buffer }[]>`
      select meta_app_id, app_secret_enc as enc from meta_connections where tenant_id = ${tenantId}`;
    expect(conn?.meta_app_id).toBe(CLIENT_APP);
    expect(conn?.enc.toString('utf8')).not.toContain(CLIENT_SECRET);
    const audit = await h.admin`select after from audit_logs where tenant_id = ${tenantId}`;
    expect(JSON.stringify(audit)).not.toContain(CLIENT_SECRET);
    // sincronizar usa o mesmo secret
    const sync = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/assets/sync`,
      headers: { cookie: owner },
    });
    expect(sync.json().syncErrors).toEqual([]);
  });

  it('webhook assinado com o secret do cliente é aceito só para as WABAs dele', async () => {
    expect((await webhook(IDS.waba, CLIENT_SECRET)).statusCode).toBe(200);
    expect((await webhook(IDS.waba, META_APP_SECRET)).statusCode).toBe(200); // app da plataforma
    expect((await webhook(IDS.waba, 'f'.repeat(32))).statusCode).toBe(401);
    // WABA desconhecida (ou de outro cliente) com o secret deste cliente → recusado
    expect((await webhook('102290129349999', CLIENT_SECRET)).statusCode).toBe(401);
  });
});
