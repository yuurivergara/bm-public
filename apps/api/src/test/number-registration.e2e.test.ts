import { signMetaPayload } from '@bm/meta-client';
import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../webhooks/webhook-processor.service';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

/**
 * Registro de número do estoque (FR-NUM-03, docs/10-meta-referencia.md §10):
 * atribuir → adicionar à WABA → pedir código → verificar → registrar → liberar (quarentena).
 */
let sim: MetaSim;
let h: Harness;
let owner: string;
let operator: string;
let providerId: string;

const api = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });

let seq = 0;
/** Cliente com WABA conectada (sem número) no simulador. */
async function tenantWithWaba(withPhone = false) {
  seq++;
  const n = String(seq).padStart(4, '0');
  const ids = { biz: `50691430${n}001`, waba: `10229012${n}002`, pn: `10654035${n}003` };
  const { token } = sim.state.addFixture(
    {
      business: { id: ids.biz, name: `Loja ${seq}` },
      wabas: [
        {
          id: ids.waba,
          name: `Loja ${seq}`,
          phone_numbers: withPhone
            ? [{ id: ids.pn, display_phone_number: `+55 21 9${n}-0000`, status: 'CONNECTED' }]
            : [],
        },
      ],
    },
    sim.appId,
  );
  const t = await api(owner, 'POST', '/tenants', { name: `Cliente ${seq}` });
  const tenantId = t.json().id as string;
  const c = await api(owner, 'POST', `/tenants/${tenantId}/assets/partner-share`, {
    businessId: ids.biz,
    wabaId: ids.waba,
    accessToken: token,
  });
  expect(c.statusCode).toBe(201);
  return { tenantId, wabaId: c.json().portfolios[0].wabas[0].id as string, metaWabaId: ids.waba };
}

async function addInventory(phone: string) {
  const r = await api(owner, 'POST', '/number-inventory', {
    providerId,
    phone,
    monthlyCostBrl: 25,
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl, captureLogs: true });
  owner = await h.login(await h.createUser('owner'));
  operator = await h.login(await h.createUser('operator'));
  providerId = (await api(owner, 'POST', '/number-providers', { name: 'Manual' })).json().id;
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

describe('registro de número do estoque', () => {
  let A: Awaited<ReturnType<typeof tenantWithWaba>>;
  let inventoryId: string;
  let phoneId: string;
  let metaPhoneId: string;

  it('atribui e adiciona à WABA (passo 1); repetir é idempotente', async () => {
    A = await tenantWithWaba();
    inventoryId = await addInventory('+5511987654321');
    const r = await api(operator, 'POST', `/tenants/${A.tenantId}/number/assign`, {
      wabaId: A.wabaId,
      verifiedName: 'Loja Um',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.assignment).toMatchObject({
      inventoryId,
      phoneE164: '+5511987654321',
      inventoryStatus: 'verifying',
    });
    expect(body.phoneNumber).toMatchObject({
      registrationStatus: 'added',
      status: 'pending',
      verifiedName: 'Loja Um',
    });
    phoneId = body.phoneNumber.id;
    metaPhoneId = body.phoneNumber.metaPhoneNumberId;

    const call = sim.state.requests.find(
      (q) => q.method === 'POST' && q.path === `/${A.metaWabaId}/phone_numbers`,
    );
    expect(call?.body).toEqual({ cc: '55', phone_number: '11987654321', verified_name: 'Loja Um' });

    const again = await api(operator, 'POST', `/tenants/${A.tenantId}/number/assign`, {
      wabaId: A.wabaId,
      verifiedName: 'Loja Um',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().phoneNumber.id).toBe(phoneId);
    const [{ n } = { n: -1 }] = await h.admin<{ n: number }[]>`
      select count(*)::int as n from number_assignments where tenant_id = ${A.tenantId}`;
    expect(n).toBe(1);
    const [route] = await h.admin<{ tenant_id: string }[]>`
      select tenant_id from meta_asset_routes where meta_id = ${metaPhoneId}`;
    expect(route?.tenant_id).toBe(A.tenantId);
  });

  it('D-13: o mesmo número não vai para outro cliente; cliente com número de parceria não recebe outro', async () => {
    const B = await tenantWithWaba();
    const r = await api(operator, 'POST', `/tenants/${B.tenantId}/number/assign`, {
      wabaId: B.wabaId,
      inventoryId,
      verifiedName: 'Loja B',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('number_unavailable');

    const C = await tenantWithWaba(true);
    await addInventory('+5511900001111');
    const r2 = await api(operator, 'POST', `/tenants/${C.tenantId}/number/assign`, {
      wabaId: C.wabaId,
      verifiedName: 'Loja C',
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe('tenant_has_number');
  });

  it('passos fora de ordem → 409; código errado → 422 com o erro registrado', async () => {
    const early = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/register`,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('invalid_registration_step');

    const req = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/verification/request`,
      {
        method: 'VOICE',
      },
    );
    expect(req.statusCode).toBe(200);
    expect(req.json().phoneNumber.registrationStatus).toBe('code_requested');
    const rc = sim.state.requests.find((q) => q.path === `/${metaPhoneId}/request_code`);
    expect(rc?.query).toMatchObject({ code_method: 'VOICE', language: 'pt_BR' });

    const wrong = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/verification/verify`,
      {
        code: '000000',
      },
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe('meta_invalid_request');
    const status = await api(operator, 'GET', `/tenants/${A.tenantId}/number`);
    expect(status.json().phoneNumber.registrationError).toMatch(/invalid or has expired/);
  });

  it('verifica e registra; PIN gerado fica só cifrado; número e estoque ficam ativos', async () => {
    const code = sim.state.verificationCodes.get(metaPhoneId) as string;
    const ok = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/verification/verify`,
      {
        code,
      },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().phoneNumber).toMatchObject({
      registrationStatus: 'code_verified',
      registrationError: null,
    });

    const reg = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/register`,
    );
    expect(reg.statusCode).toBe(200);
    expect(reg.json().phoneNumber.registrationStatus).toBe('registered');
    expect(reg.json().assignment.inventoryStatus).toBe('active');

    const pin = sim.state.objects.get(metaPhoneId)?.data.two_step_pin as string;
    expect(pin).toMatch(/^\d{6}$/);
    expect(sim.state.objects.get(metaPhoneId)?.data.status).toBe('CONNECTED');
    const [row] = await h.admin<{ pin: Buffer; key: string }[]>`
      select two_step_pin_enc as pin, pin_key_id as key from phone_numbers where id = ${phoneId}`;
    expect(row?.pin.toString('utf8')).not.toContain(pin);
    expect(row?.key).toBeTruthy();
    const audit = await h.admin`select after from audit_logs where tenant_id = ${A.tenantId}`;
    expect(JSON.stringify(audit)).not.toContain(pin);
    expect(h.logs()).not.toContain(pin);
    expect(JSON.stringify(reg.json())).not.toContain(pin);
  });

  it('nome aprovado depois do registro pede re-registro; register de novo limpa o aviso', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: A.metaWabaId,
          changes: [
            {
              field: 'phone_number_name_update',
              value: {
                display_phone_number: '5511987654321',
                decision: 'APPROVED',
                requested_verified_name: 'Loja Um Oficial',
                rejection_reason: null,
              },
            },
          ],
        },
      ],
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signMetaPayload(body, META_APP_SECRET),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(await h.app.get(WebhookProcessor).drain()).toMatchObject({ processed: 1 });
    let st = (await api(operator, 'GET', `/tenants/${A.tenantId}/number`)).json().phoneNumber;
    expect(st).toMatchObject({
      verifiedName: 'Loja Um Oficial',
      registrationError: expect.stringMatching(/re-registre/),
    });
    const again = await api(
      operator,
      'POST',
      `/tenants/${A.tenantId}/phone-numbers/${phoneId}/register`,
    );
    expect(again.statusCode).toBe(200);
    st = again.json().phoneNumber;
    expect(st).toMatchObject({ registrationStatus: 'registered', registrationError: null });
  });

  it('número já verificado na Meta (136024) pula direto para o registro', async () => {
    const D = await tenantWithWaba();
    await addInventory('+5511922223333');
    const a = await api(operator, 'POST', `/tenants/${D.tenantId}/number/assign`, {
      wabaId: D.wabaId,
      verifiedName: 'Loja D',
    });
    const pid = a.json().phoneNumber.id;
    sim.state.errors.push({
      pathIncludes: '/request_code',
      status: 400,
      error: { message: 'Phone number is already verified', code: 136024 },
    });
    const r = await api(
      operator,
      'POST',
      `/tenants/${D.tenantId}/phone-numbers/${pid}/verification/request`,
      {},
    );
    expect(r.statusCode).toBe(200);
    expect(r.json().phoneNumber.registrationStatus).toBe('code_verified');
  });

  it('libera: desregistra, quarentena de 90 dias; só volta ao estoque depois dela', async () => {
    expect(
      (
        await api(operator, 'POST', `/tenants/${A.tenantId}/number/release`, {
          reason: 'saída do cliente',
        })
      ).statusCode,
    ).toBe(403);
    const rel = await api(owner, 'POST', `/tenants/${A.tenantId}/number/release`, {
      reason: 'saída do cliente',
    });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().deregisterError).toBeNull();
    const days = (new Date(rel.json().quarantineUntil).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(sim.state.objects.get(metaPhoneId)?.data.status).toBe('DISCONNECTED');

    const inv = await api(owner, 'GET', '/number-inventory?status=quarantine');
    expect(inv.json().data.map((i: { id: string }) => i.id)).toContain(inventoryId);
    expect(
      (await api(operator, 'GET', `/tenants/${A.tenantId}/number`)).json().assignment,
    ).toBeNull();

    const E = await tenantWithWaba();
    const blocked = await api(operator, 'POST', `/tenants/${E.tenantId}/number/assign`, {
      wabaId: E.wabaId,
      inventoryId,
      verifiedName: 'Loja E',
    });
    expect(blocked.json().code).toBe('number_unavailable');

    await h.admin`update number_inventory set quarantine_until = now() - interval '1 minute' where id = ${inventoryId}`;
    const reuse = await api(operator, 'POST', `/tenants/${E.tenantId}/number/assign`, {
      wabaId: E.wabaId,
      inventoryId,
      verifiedName: 'Loja E',
    });
    expect(reuse.statusCode).toBe(200);
    expect(reuse.json().assignment.inventoryStatus).toBe('verifying');
  });
});
