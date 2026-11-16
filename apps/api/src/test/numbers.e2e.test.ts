import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
let owner: string;
let operator: string;
let viewer: string;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.login(await h.createUser('owner'));
  operator = await h.login(await h.createUser('operator'));
  viewer = await h.login(await h.createUser('viewer'));
});
afterAll(async () => {
  await h?.close();
});

const req = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });

describe('estoque de números (FR-NUM-01/02)', () => {
  let providerId: string;

  it('owner cadastra provedor; nome duplicado → 409; operador não cadastra', async () => {
    const res = await req(owner, 'POST', '/number-providers', { name: 'Provedor Manual' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Provedor Manual', apiKind: 'manual' });
    providerId = res.json().id;
    expect(
      (await req(owner, 'POST', '/number-providers', { name: 'Provedor Manual' })).statusCode,
    ).toBe(409);
    expect((await req(operator, 'POST', '/number-providers', { name: 'Outro' })).statusCode).toBe(
      403,
    );
  });

  it('cadastra número só em E.164 exato (sem "corrigir" nono dígito)', async () => {
    const ok = await req(owner, 'POST', '/number-inventory', {
      providerId,
      phone: '+5511912345678',
      monthlyCostBrl: 29.9,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      phoneE164: '+5511912345678',
      status: 'available',
      monthlyCostBrl: 29.9,
    });

    for (const phone of ['11912345678', '+551112345678x', '+55 11 1234-5678', '+551191234567']) {
      const bad = await req(owner, 'POST', '/number-inventory', {
        providerId,
        phone,
        monthlyCostBrl: 1,
      });
      expect(bad.statusCode, phone).toBe(400);
    }
    // fixo em E.164 exato é aceito (número virtual pode ser fixo)
    expect(
      (
        await req(owner, 'POST', '/number-inventory', {
          providerId,
          phone: '+551133334444',
          monthlyCostBrl: 1,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await req(owner, 'POST', '/number-inventory', {
          providerId,
          phone: '+5511912345678',
          monthlyCostBrl: 1,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('viewer lista o estoque com filtro; não cadastra', async () => {
    const list = await req(viewer, 'GET', '/number-inventory?status=available');
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);
    expect((await req(viewer, 'GET', '/number-inventory?status=active')).json().data).toHaveLength(
      0,
    );
    expect(
      (
        await req(viewer, 'POST', '/number-inventory', {
          providerId,
          phone: '+5511900000001',
          monthlyCostBrl: 1,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('cadastro do estoque é auditado com o telefone mascarado', async () => {
    const rows = await h.admin<{ after: Record<string, unknown> }[]>`
      select after from audit_logs where action = 'number_inventory.create' order by id`;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('912345678');
  });
});
