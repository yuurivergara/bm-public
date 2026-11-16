import { signMetaPayload } from '@bm/meta-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, META_APP_SECRET, META_VERIFY_TOKEN } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const envelope = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_1',
      changes: [
        { field: 'account_update', value: { event: 'X' } },
        { field: 'phone_number_quality_update', value: { display_phone_number: '5511' } },
      ],
    },
  ],
};

function post(body: string, signature?: string) {
  return h.app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });
}

describe('GET /webhooks/meta (verificação)', () => {
  it('responde o hub.challenge em texto quando o verify token confere', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${META_VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('recusa verify token errado ou modo diferente', async () => {
    for (const qs of [
      'hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1',
      `hub.mode=unsubscribe&hub.verify_token=${META_VERIFY_TOKEN}&hub.challenge=1`,
      '',
    ]) {
      const res = await h.app.inject({ method: 'GET', url: `/webhooks/meta?${qs}` });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('POST /webhooks/meta (recebimento)', () => {
  it('rejeita sem assinatura ou com assinatura inválida, sem gravar nada', async () => {
    const body = JSON.stringify(envelope);
    expect((await post(body)).statusCode).toBe(401);
    expect((await post(body, signMetaPayload(body, 'outro-segredo-qualquer'))).statusCode).toBe(
      401,
    );
    const [{ n } = { n: -1 }] = await h.admin<
      { n: number }[]
    >`select count(*)::int as n from webhook_events`;
    expect(n).toBe(0);
  });

  it('valida a assinatura sobre o corpo BRUTO (espaços/ordem preservados)', async () => {
    const body = `{ "object": "whatsapp_business_account",  "entry": [] }`;
    const res = await post(body, signMetaPayload(body, META_APP_SECRET));
    expect(res.statusCode).toBe(200);
  });

  it('grava um evento por change, enfileirado, e responde 200', async () => {
    const body = JSON.stringify(envelope);
    const res = await post(body, signMetaPayload(body, META_APP_SECRET));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 2 });
    const rows = await h.admin<
      { field: string; entry_id: string; status: string; object: string; payload: unknown }[]
    >`select field, entry_id, status, object, payload from webhook_events order by id`;
    expect(rows.map((r) => [r.field, r.entry_id, r.status, r.object])).toEqual([
      ['account_update', 'WABA_1', 'queued', 'whatsapp_business_account'],
      ['phone_number_quality_update', 'WABA_1', 'queued', 'whatsapp_business_account'],
    ]);
    expect(rows[0]?.payload).toMatchObject({ entryId: 'WABA_1', value: { event: 'X' } });
  });

  it('JSON inválido com assinatura válida → 400', async () => {
    const body = '{"object":';
    const res = await post(body, signMetaPayload(body, META_APP_SECRET));
    expect(res.statusCode).toBe(400);
  });

  it('não sofre o rate limit global (rajadas da Meta)', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const sig = signMetaPayload(body, META_APP_SECRET);
    const results = await Promise.all(Array.from({ length: 320 }, () => post(body, sig)));
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(0);
  });
});
