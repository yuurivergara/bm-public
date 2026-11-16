import { createMetaSim, type MetaSim } from '@bm/meta-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, META_APP_SECRET, META_GRAPH_VERSION } from './harness';

/** Templates por cliente (FR-TPL-03/05, docs/10-meta-referencia.md §11). */
let sim: MetaSim;
let h: Harness;
let owner: string;
let operator: string;
let viewer: string;
let tenantId: string;
let wabaId: string;
const IDS = { biz: '506914307650001', waba: '102290129350002' };

const api = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({
    method,
    url: `/api/v1/tenants/${tenantId}${url}`,
    headers: { cookie },
    payload: payload as object,
  });

const utility = {
  name: 'order_confirmation',
  category: 'UTILITY',
  parameterFormat: 'NAMED',
  components: [
    {
      type: 'body',
      text: 'Obrigado, {{first_name}}! Seu pedido é o {{order_number}}.',
      example: {
        body_text_named_params: [
          { param_name: 'first_name', example: 'Pablo' },
          { param_name: 'order_number', example: '860198-230332' },
        ],
      },
    },
  ],
};

const marketing = (buttons: { type: string; text: string; url?: string }[]) => ({
  name: 'promo_novembro',
  category: 'MARKETING',
  components: [
    { type: 'BODY', text: 'Ofertas de novembro, {{1}}!', example: { body_text: [['Ana']] } },
    { type: 'BUTTONS', buttons },
  ],
});

beforeAll(async () => {
  sim = createMetaSim({ appSecret: META_APP_SECRET, graphVersion: META_GRAPH_VERSION });
  const simUrl = await sim.app.listen({ host: '127.0.0.1', port: 0 });
  h = await createHarness({ metaBaseUrl: simUrl });
  owner = await h.login(await h.createUser('owner'));
  operator = await h.login(await h.createUser('operator'));
  viewer = await h.login(await h.createUser('viewer'));
  const { token } = sim.state.addFixture(
    { business: { id: IDS.biz, name: 'Loja' }, wabas: [{ id: IDS.waba, name: 'Loja' }] },
    sim.appId,
  );
  tenantId = (
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { cookie: owner },
      payload: { name: 'Loja Templates' },
    })
  ).json().id;
  const c = await api(owner, 'POST', '/assets/partner-share', {
    businessId: IDS.biz,
    wabaId: IDS.waba,
    accessToken: token,
  });
  wabaId = c.json().portfolios[0].wabas[0].id;
});
afterAll(async () => {
  await h?.close();
  await sim?.app.close();
});

describe('templates por cliente', () => {
  let templateId: string;
  let metaTemplateId: string;

  it('cria UTILITY com parâmetros nomeados: submete à Meta e grava PENDING', async () => {
    const r = await api(operator, 'POST', '/templates', { wabaId, ...utility });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: 'order_confirmation',
      language: 'pt_BR',
      status: 'PENDING',
      category: 'UTILITY',
      submittedCategory: 'UTILITY',
      parameterFormat: 'NAMED',
    });
    templateId = r.json().id;
    metaTemplateId = r.json().metaTemplateId;
    expect(metaTemplateId).toMatch(/^\d+$/);
    const sent = sim.state.requests.find(
      (q) => q.method === 'POST' && q.path === `/${IDS.waba}/message_templates`,
    );
    expect(sent?.body).toMatchObject({
      name: 'order_confirmation',
      language: 'pt_BR',
      category: 'UTILITY',
      parameter_format: 'NAMED',
      components: [{ type: 'BODY' }],
    });
  });

  it('nome repetido no mesmo idioma → 409 (2388024); outro idioma pode', async () => {
    const dup = await api(operator, 'POST', '/templates', { wabaId, ...utility });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({
      code: 'template_exists',
      details: { metaSubcode: 2388024 },
    });
    const en = await api(operator, 'POST', '/templates', { wabaId, ...utility, language: 'en_US' });
    expect(en.statusCode).toBe(201);
  });

  it('valida regras oficiais antes de chamar a Meta', async () => {
    const before = sim.state.requests.length;
    const bad = [
      { ...utility, name: 'Order Confirmation' },
      { ...utility, components: [{ type: 'BODY', text: 'x'.repeat(1025) }] },
      { ...utility, components: [{ type: 'FOOTER', text: 'só rodapé' }] },
      marketing([{ type: 'QUICK_REPLY', text: 'Um rótulo grande demais para botão' }]),
    ];
    for (const body of bad) {
      expect((await api(operator, 'POST', '/templates', { wabaId, ...body })).statusCode).toBe(400);
    }
    expect(sim.state.requests.length).toBe(before);
  });

  it('marketing exige botão de descadastro (FR-TPL-05)', async () => {
    const sem = await api(operator, 'POST', '/templates', {
      wabaId,
      ...marketing([{ type: 'URL', text: 'Ver ofertas', url: 'https://loja.example/ofertas' }]),
    });
    expect(sem.statusCode).toBe(422);
    expect(sem.json().code).toBe('optout_button_required');
    const com = await api(operator, 'POST', '/templates', {
      wabaId,
      ...marketing([{ type: 'QUICK_REPLY', text: 'Não quero receber' }]),
    });
    expect(com.statusCode).toBe(201);
    expect(com.json().category).toBe('MARKETING');
  });

  it('sync traz aprovação, qualidade (objeto) e marca como DELETED o que sumiu da Meta', async () => {
    const review = await sim.app.inject({
      method: 'POST',
      url: `/_sim/templates/${metaTemplateId}/review`,
      payload: { event: 'APPROVED' },
    });
    expect(review.statusCode).toBe(200);
    const obj = sim.state.objects.get(metaTemplateId);
    if (obj) obj.data.quality_score = { score: 'GREEN', date: 1758754645 };
    // template apagado direto no WhatsApp Manager
    const promo = [...sim.state.objects.values()].find((o) => o.data.name === 'promo_novembro');
    if (promo) sim.state.objects.delete(promo.data.id);

    const r = await api(operator, 'POST', '/templates/sync');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ synced: 2, syncErrors: [] });
    const byKey = Object.fromEntries(
      r.json().data.map((t: { name: string; language: string }) => [`${t.name}:${t.language}`, t]),
    );
    expect(byKey['order_confirmation:pt_BR']).toMatchObject({
      status: 'APPROVED',
      qualityScore: 'GREEN',
    });
    expect(byKey['order_confirmation:en_US']).toMatchObject({ status: 'PENDING' });
    expect(byKey['promo_novembro:pt_BR']).toMatchObject({ status: 'DELETED' });
  });

  it('viewer só lê; apagar é do owner e apaga só aquele idioma na Meta', async () => {
    expect((await api(viewer, 'GET', '/templates')).json().data).toHaveLength(3);
    expect((await api(viewer, 'POST', '/templates', { wabaId, ...utility })).statusCode).toBe(403);
    expect((await api(operator, 'DELETE', `/templates/${templateId}`)).statusCode).toBe(403);
    const del = await api(owner, 'DELETE', `/templates/${templateId}`);
    expect(del.statusCode).toBe(200);
    const call = sim.state.requests.find(
      (q) => q.method === 'DELETE' && q.path === `/${IDS.waba}/message_templates`,
    );
    expect(call?.query).toMatchObject({ hsm_id: metaTemplateId, name: 'order_confirmation' });
    expect(sim.state.objects.has(metaTemplateId)).toBe(false);
    const left = (await api(viewer, 'GET', '/templates')).json().data;
    expect(left.map((t: { language: string; name: string }) => `${t.name}:${t.language}`)).toEqual([
      'order_confirmation:en_US',
      'promo_novembro:pt_BR',
    ]);
  });
});
