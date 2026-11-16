import { signMetaPayload } from '@bm/meta-client';
import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../webhooks/webhook-processor.service';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

let sim: MetaSim;
let h: Harness;
let processor: WebhookProcessor;
let tenantId: string;
const IDS = { biz: '506914307656635', waba: '102290129340399', pn: '106540352242923' };

async function deliver(field: string, value: unknown) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: IDS.waba, time: 1751247548, changes: [{ value, field }] }],
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
  return processor.drain();
}

async function templates() {
  return h.admin<
    {
      name: string;
      language: string;
      meta_template_id: string;
      status: string;
      category: string | null;
      previous_category: string | null;
      quality_score: string | null;
      rejection_reason: string | null;
    }[]
  >`select name, language, meta_template_id, status, category, previous_category, quality_score,
           rejection_reason
      from message_templates where tenant_id = ${tenantId} order by name`;
}

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl });
  const cookie = await h.login(await h.createUser('owner'));
  processor = h.app.get(WebhookProcessor);
  const { token } = sim.state.addFixture(
    {
      business: { id: IDS.biz, name: 'Lucky Shrub' },
      wabas: [
        {
          id: IDS.waba,
          name: 'Lucky Shrub',
          phone_numbers: [{ id: IDS.pn, display_phone_number: '15550783882', status: 'CONNECTED' }],
        },
      ],
    },
    sim.appId,
  );
  const t = await h.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Templates' },
  });
  tenantId = t.json().id;
  const c = await h.app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/assets/partner-share`,
    headers: { cookie },
    payload: { businessId: IDS.biz, wabaId: IDS.waba, accessToken: token },
  });
  expect(c.statusCode).toBe(201);
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

describe('webhooks de template (payloads oficiais §3.9–3.11)', () => {
  it('status APPROVED de template criado fora da plataforma cria o registro', async () => {
    expect(
      await deliver('message_template_status_update', {
        event: 'APPROVED',
        message_template_id: 1689556908129832,
        message_template_name: 'order_confirmation',
        message_template_language: 'en-US',
        reason: 'NONE',
        message_template_category: 'UTILITY',
      }),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(await templates()).toEqual([
      expect.objectContaining({
        name: 'order_confirmation',
        language: 'en-US',
        meta_template_id: '1689556908129832',
        status: 'APPROVED',
        category: 'UTILITY',
        rejection_reason: null,
      }),
    ]);
  });

  it('REJECTED grava o motivo; PAUSED depois atualiza o status', async () => {
    const base = {
      message_template_id: 1689556908129832,
      message_template_name: 'order_confirmation',
      message_template_language: 'en-US',
    };
    await deliver('message_template_status_update', {
      ...base,
      event: 'REJECTED',
      reason: 'PROMOTIONAL',
    });
    expect((await templates())[0]).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'PROMOTIONAL',
    });
    await deliver('message_template_status_update', { ...base, event: 'PAUSED', reason: null });
    expect((await templates())[0]).toMatchObject({ status: 'PAUSED', rejection_reason: null });
  });

  it('qualidade e reclassificação de categoria', async () => {
    await deliver('message_template_quality_update', {
      previous_quality_score: 'GREEN',
      new_quality_score: 'YELLOW',
      message_template_id: 1689556908129832,
      message_template_name: 'order_confirmation',
      message_template_language: 'en-US',
    });
    // aviso prévio (24 h antes): não muda a categoria
    await deliver('template_category_update', {
      message_template_id: 1689556908129832,
      message_template_name: 'order_confirmation',
      message_template_language: 'en-US',
      new_category: 'UTILITY',
      correct_category: 'MARKETING',
    });
    expect((await templates())[0]).toMatchObject({ quality_score: 'YELLOW', category: 'UTILITY' });
    // efetivação
    await deliver('template_category_update', {
      message_template_id: 1689556908129832,
      message_template_name: 'order_confirmation',
      message_template_language: 'en-US',
      previous_category: 'UTILITY',
      new_category: 'MARKETING',
    });
    expect((await templates())[0]).toMatchObject({
      category: 'MARKETING',
      previous_category: 'UTILITY',
    });
    const signals = await h.admin<{ status: string }[]>`
      select status from account_health where entity_type = 'template' order by id`;
    expect(signals.map((s) => s.status)).toEqual([
      'TEMPLATE_APPROVED',
      'TEMPLATE_REJECTED',
      'TEMPLATE_PAUSED',
      'TEMPLATE_QUALITY_YELLOW',
      'TEMPLATE_CATEGORY_NOTICE_MARKETING',
      'TEMPLATE_CATEGORY_UTILITY_TO_MARKETING',
    ]);
  });
});
