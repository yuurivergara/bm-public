import { signMetaPayload } from '@bm/meta-client';
import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../webhooks/webhook-processor.service';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

let sim: MetaSim;
let h: Harness;
let cookie: string;
let processor: WebhookProcessor;
let tenantId: string;
const IDS = { biz: '506914307656634', waba: '102290129340398', pn: '106540352242922' };

/** Envia um webhook assinado como a Meta (envelope oficial, docs/10-meta-referencia.md §2.4). */
async function deliver(field: string, value: unknown, entryId = IDS.waba) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: entryId, time: 1739321024, changes: [{ value, field }] }],
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
}

async function assets() {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${tenantId}/assets`,
    headers: { cookie },
  });
  return res.json();
}

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl });
  cookie = await h.login(await h.createUser('owner'));
  processor = h.app.get(WebhookProcessor);
  const { token } = sim.state.addFixture(
    {
      business: {
        id: IDS.biz,
        name: 'Lucky Shrub',
        verification_status: 'verified',
        whatsapp_business_manager_messaging_limit: 'TIER_250',
      },
      wabas: [
        {
          id: IDS.waba,
          name: 'Lucky Shrub',
          currency: 'USD',
          account_review_status: 'PENDING',
          phone_numbers: [
            {
              id: IDS.pn,
              display_phone_number: '15550783881',
              verified_name: 'Lucky Shrub',
              quality_rating: 'GREEN',
              status: 'CONNECTED',
            },
          ],
        },
      ],
    },
    sim.appId,
  );
  const t = await h.app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie },
    payload: { name: 'Lucky' },
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

describe('processamento de webhooks de ativos (ponta a ponta)', () => {
  it('business_capability_update atualiza o limite do portfolio (formato numérico do exemplo oficial)', async () => {
    await deliver('business_capability_update', {
      max_daily_conversations_per_business: 2000,
      max_phone_numbers_per_waba: 25,
    });
    expect(await processor.drain()).toMatchObject({ processed: 1 });
    const p = (await assets()).portfolios[0];
    expect(p).toMatchObject({ messagingLimitTier: 'TIER_2K', messagingLimitValue: 2000 });
  });

  it('account_update ACCOUNT_RESTRICTION restringe a WABA; DISABLED_UPDATE REINSTATE reativa', async () => {
    await deliver('account_update', {
      event: 'ACCOUNT_RESTRICTION',
      restriction_info: [
        { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1641330498 },
      ],
    });
    await processor.drain();
    let w = (await assets()).portfolios[0].wabas[0];
    expect(w.status).toBe('restricted');
    expect(w.restrictionInfo[0].restriction_type).toBe('RESTRICTED_BIZ_INITIATED_MESSAGING');

    await deliver('account_update', {
      event: 'DISABLED_UPDATE',
      ban_info: { waba_ban_state: 'REINSTATE', waba_ban_date: 'April 17, 2025' },
    });
    await processor.drain();
    w = (await assets()).portfolios[0].wabas[0];
    expect(w.status).toBe('active');
  });

  it('account_review_update grava a decisão', async () => {
    await deliver('account_review_update', { decision: 'APPROVED' });
    await processor.drain();
    expect((await assets()).portfolios[0].wabas[0].accountReviewStatus).toBe('APPROVED');
  });

  it('phone_number_name_update aprovado atualiza nome e status do nome', async () => {
    await deliver('phone_number_name_update', {
      display_phone_number: '15550783881',
      decision: 'APPROVED',
      requested_verified_name: 'Lucky Shrub Garden',
      rejection_reason: null,
    });
    await processor.drain();
    const phone = (await assets()).portfolios[0].wabas[0].phoneNumbers[0];
    expect(phone).toMatchObject({ nameStatus: 'APPROVED', verifiedName: 'Lucky Shrub Garden' });
  });

  it('phone_number_quality_update registra o sinal e o limite legado', async () => {
    await deliver('phone_number_quality_update', {
      display_phone_number: '15550783881',
      event: 'THROUGHPUT_UPGRADE',
      current_limit: 'TIER_UNLIMITED',
    });
    await processor.drain();
    const phone = (await assets()).portfolios[0].wabas[0].phoneNumbers[0];
    expect(phone.messagingLimitTier).toBe('TIER_UNLIMITED');
    const rows = await h.admin<{ status: string }[]>`
      select status from account_health where entity_type = 'phone_number' and source = 'webhook'`;
    expect(rows.map((r) => r.status)).toContain('THROUGHPUT_UPGRADE');
  });

  it('duplicata (reentrega da Meta) é ignorada', async () => {
    const value = { decision: 'REJECTED' };
    await deliver('account_review_update', value);
    await processor.drain();
    await deliver('account_review_update', value);
    expect(await processor.drain()).toMatchObject({ processed: 0, ignored: 1 });
  });

  it('WABA desconhecida e campo sem handler são ignorados, não falham', async () => {
    await deliver('account_update', { event: 'ACCOUNT_DELETED' }, '999999999999999');
    await deliver('security', { phone_number: '15550783881', event: 'PIN_CHANGED' });
    expect(await processor.drain()).toMatchObject({ ignored: 2, failed: 0 });
    const rows = await h.admin<{ error: string }[]>`
      select error from webhook_events where status = 'ignored' order by id desc limit 2`;
    expect(rows.map((r) => r.error).join('|')).toMatch(/sem handler para o campo security/);
  });

  it('falha no handler → retry com backoff e, depois de esgotar, dead', async () => {
    // força erro: payload que quebra a gravação (restriction_info gigante não quebra; usamos SQL inválido via status)
    await h.admin`
      insert into webhook_events (source, object, field, entry_id, dedupe_key, payload)
      values ('meta', 'whatsapp_business_account', 'account_review_update', ${IDS.waba}, 'k-fail',
              ${h.admin.json({ entryId: IDS.waba, field: 'account_review_update', value: { decision: 'X'.repeat(10) } })})`;
    // simula falha transitória: revoga UPDATE do papel da app só durante o teste
    await h.admin`revoke update on whatsapp_accounts from bm_app`;
    try {
      const r1 = await processor.drain();
      expect(r1.failed).toBe(1);
      const [row] = await h.admin<{ status: string; attempts: number; next_attempt_at: Date }[]>`
        select status, attempts, next_attempt_at from webhook_events where dedupe_key = 'k-fail'`;
      expect(row).toMatchObject({ status: 'failed', attempts: 1 });
      expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      // pula para a última tentativa
      await h.admin`update webhook_events set attempts = 7, next_attempt_at = now() where dedupe_key = 'k-fail'`;
      expect((await processor.drain()).dead).toBe(1);
    } finally {
      await h.admin`grant update on whatsapp_accounts to bm_app`;
    }
  });
});
