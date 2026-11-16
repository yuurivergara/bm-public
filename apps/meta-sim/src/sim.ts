import { randomUUID } from 'node:crypto';
import { appSecretProof, signMetaPayload } from '@bm/meta-client';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * meta-sim — simulador da Graph API para dev, CI e staging.
 *
 * Guarda objetos (portfolio, WABA, número) com os campos nativos da Meta, vindos das fixtures,
 * e responde como a Graph API: versão no caminho, Bearer + appsecret_proof obrigatórios,
 * filtro por `fields`, objeto de erro padrão. Erros podem ser injetados e webhooks assinados
 * podem ser emitidos para a plataforma. Rotas de controle ficam sob /_sim.
 */

export type MetaObject = Record<string, unknown> & { id: string };
type Kind = 'business' | 'waba' | 'phone_number' | 'template';

interface StoredObject {
  kind: Kind;
  data: MetaObject;
  parentId?: string;
}

interface TokenInfo {
  /** IDs de objetos que o token alcança (portfolio/WABA; números herdam da WABA). */
  assets: Set<string>;
  scopes: string[];
  appId: string;
  type: 'SYSTEM_USER' | 'USER' | 'APP';
  valid: boolean;
}

export interface InjectedError {
  method?: string;
  /** Trecho do caminho (sem versão), ex.: "/phone_numbers". */
  pathIncludes?: string;
  status: number;
  error: {
    message: string;
    type?: string;
    code: number;
    error_subcode?: number;
    error_data?: unknown;
  };
  /** Quantas vezes aplicar (padrão 1). */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  at: string;
}

export interface MetaSimOptions {
  appSecret: string;
  graphVersion: string;
  appId?: string;
  /** Destino dos webhooks emitidos (ex.: https://api/webhooks/meta). */
  webhookUrl?: string;
  logger?: boolean;
}

export interface FixtureInput {
  token?: string;
  scopes?: string[];
  business: MetaObject;
  wabas?: (MetaObject & { phone_numbers?: MetaObject[] })[];
}

const graphError = (
  reply: FastifyReply,
  status: number,
  error: {
    message: string;
    type?: string;
    code: number;
    error_subcode?: number;
    error_data?: unknown;
  },
) =>
  reply.status(status).send({
    error: { type: 'OAuthException', ...error, fbtrace_id: `SIM${randomUUID().slice(0, 12)}` },
  });

export class MetaSimState {
  readonly objects = new Map<string, StoredObject>();
  readonly tokens = new Map<string, TokenInfo>();
  readonly subscribedApps = new Map<string, Set<string>>();
  readonly errors: InjectedError[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Último código de verificação "enviado" por número (o que chegaria por SMS/voz). */
  readonly verificationCodes = new Map<string, string>();
  /** Tentativas de register/deregister por número (limite: 10 em 72 h, §10.4). */
  readonly registrationAttempts = new Map<string, number[]>();

  reset() {
    this.verificationCodes.clear();
    this.registrationAttempts.clear();
    this.objects.clear();
    this.tokens.clear();
    this.subscribedApps.clear();
    this.errors.length = 0;
    this.requests.length = 0;
  }

  /** Cria portfolio, WABAs e números; devolve o token com acesso a eles. */
  addFixture(input: FixtureInput, appId: string): { token: string } {
    const token = input.token ?? `EAASIM${randomUUID().replace(/-/g, '')}`;
    const assets = new Set<string>([input.business.id]);
    this.objects.set(input.business.id, { kind: 'business', data: input.business });
    for (const w of input.wabas ?? []) {
      const { phone_numbers: phones = [], ...waba } = w;
      this.objects.set(waba.id, {
        kind: 'waba',
        data: waba as MetaObject,
        parentId: input.business.id,
      });
      assets.add(waba.id);
      for (const p of phones) {
        this.objects.set(p.id, { kind: 'phone_number', data: p, parentId: waba.id });
      }
    }
    const existing = this.tokens.get(token);
    this.tokens.set(token, {
      assets: new Set([...(existing?.assets ?? []), ...assets]),
      scopes: input.scopes ?? ['whatsapp_business_management', 'whatsapp_business_messaging'],
      appId,
      type: 'SYSTEM_USER',
      valid: true,
    });
    return { token };
  }

  canAccess(token: TokenInfo, id: string): boolean {
    if (token.assets.has(id)) return true;
    const obj = this.objects.get(id);
    return !!obj?.parentId && this.canAccess(token, obj.parentId);
  }

  takeError(method: string, path: string): InjectedError | undefined {
    const idx = this.errors.findIndex(
      (e) =>
        (!e.method || e.method === method) && (!e.pathIncludes || path.includes(e.pathIncludes)),
    );
    if (idx < 0) return undefined;
    const e = this.errors[idx] as InjectedError;
    e.times = (e.times ?? 1) - 1;
    if (e.times <= 0) this.errors.splice(idx, 1);
    return e;
  }
}

const randomMetaId = () =>
  String(100_000_000_000_000 + Math.floor(Math.random() * 899_999_999_999_999));
const REG_WINDOW_MS = 72 * 3600 * 1000;

function pickFields(obj: MetaObject, fields: unknown): MetaObject {
  if (typeof fields !== 'string' || !fields.trim()) return obj;
  const out: MetaObject = { id: obj.id };
  for (const f of fields.split(',').map((s) => s.trim())) {
    // suporta "campo{sub}" de forma simples: devolve o campo inteiro
    const name = f.replace(/\{.*$/, '');
    if (name in obj) out[name] = obj[name];
  }
  return out;
}

export function createMetaSim(opts: MetaSimOptions) {
  const appId = opts.appId ?? '1000000000000001';
  const state = new MetaSimState();
  const app: FastifyInstance = Fastify({ logger: opts.logger ?? false });

  const v = opts.graphVersion;

  /** Autenticação no estilo Graph: Bearer + appsecret_proof. */
  function auth(req: FastifyRequest, reply: FastifyReply): TokenInfo | undefined {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const q = req.query as Record<string, string | undefined>;
    const info = token ? state.tokens.get(token) : undefined;
    if (!token || !info?.valid) {
      graphError(reply, 401, {
        message: 'Invalid OAuth access token - Cannot parse access token',
        code: 190,
      });
      return undefined;
    }
    if (q.appsecret_proof !== appSecretProof(token, opts.appSecret)) {
      graphError(reply, 400, {
        message: 'Invalid appsecret_proof provided in the API argument',
        code: 100,
      });
      return undefined;
    }
    return info;
  }

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/_sim') || path === '/healthz') return;
    if (!path.startsWith(`/${v}/`)) {
      return graphError(reply, 400, { message: `Unknown API version (sim: ${v})`, code: 2635 });
    }
    const rel = path.slice(v.length + 1);
    state.requests.push({
      method: req.method,
      path: rel,
      query: { ...(req.query as object), appsecret_proof: undefined },
      body: req.body,
      at: new Date().toISOString(),
    });
    const injected = state.takeError(req.method, rel);
    if (injected) return graphError(reply, injected.status, injected.error);
  });

  // ---------------------------------------------------------------- Graph API
  app.get(`/${v}/debug_token`, async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const input = (req.query as Record<string, string>).input_token;
    const info = input ? state.tokens.get(input) : undefined;
    return {
      data: info
        ? {
            app_id: info.appId,
            type: info.type,
            is_valid: info.valid,
            scopes: info.scopes,
            granular_scopes: info.scopes.map((scope) => ({ scope, target_ids: [...info.assets] })),
            expires_at: 0,
          }
        : { is_valid: false },
    };
  });

  app.get<{ Params: { id: string } }>(`/${v}/:id/phone_numbers`, async (req, reply) => {
    const token = auth(req, reply);
    if (!token) return reply;
    const waba = state.objects.get(req.params.id);
    if (waba?.kind !== 'waba' || !state.canAccess(token, waba.data.id)) {
      return notFound(reply, req.params.id);
    }
    const data = [...state.objects.values()]
      .filter((o) => o.kind === 'phone_number' && o.parentId === waba.data.id)
      .map((o) => pickFields(o.data, (req.query as Record<string, string>).fields));
    return { data, paging: { cursors: { before: 'B', after: 'A' } } };
  });

  app.get<{ Params: { id: string } }>(`/${v}/:id/subscribed_apps`, async (req, reply) => {
    const token = auth(req, reply);
    if (!token) return reply;
    const waba = state.objects.get(req.params.id);
    if (waba?.kind !== 'waba' || !state.canAccess(token, waba.data.id)) {
      return notFound(reply, req.params.id);
    }
    const apps = [...(state.subscribedApps.get(waba.data.id) ?? [])];
    return {
      data: apps.map((id) => ({ whatsapp_business_api_data: { id, name: 'BM Platform (sim)' } })),
    };
  });

  app.post<{ Params: { id: string } }>(`/${v}/:id/subscribed_apps`, async (req, reply) => {
    const token = auth(req, reply);
    if (!token) return reply;
    const waba = state.objects.get(req.params.id);
    if (waba?.kind !== 'waba' || !state.canAccess(token, waba.data.id)) {
      return notFound(reply, req.params.id);
    }
    const set = state.subscribedApps.get(waba.data.id) ?? new Set<string>();
    set.add(token.appId);
    state.subscribedApps.set(waba.data.id, set);
    return { success: true };
  });

  // ---------------------------------------------------------------- registro de número (§10)
  type Q = Record<string, string | undefined>;
  type B = Record<string, unknown> | undefined;
  const invalidParam = (reply: FastifyReply, message: string) =>
    graphError(reply, 400, { message: `(#100) ${message}`, code: 100 });

  function ownedPhone(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const token = auth(req, reply);
    if (!token) return undefined;
    const obj = state.objects.get(req.params.id);
    if (obj?.kind !== 'phone_number' || !state.canAccess(token, obj.data.id)) {
      notFound(reply, req.params.id);
      return undefined;
    }
    return obj;
  }

  function registrationLimited(phoneId: string): boolean {
    const now = Date.now();
    const recent = (state.registrationAttempts.get(phoneId) ?? []).filter(
      (t) => now - t < REG_WINDOW_MS,
    );
    recent.push(now);
    state.registrationAttempts.set(phoneId, recent);
    return recent.length > 10;
  }

  app.post<{ Params: { id: string } }>(`/${v}/:id/phone_numbers`, async (req, reply) => {
    const token = auth(req, reply);
    if (!token) return reply;
    const waba = state.objects.get(req.params.id);
    if (waba?.kind !== 'waba' || !state.canAccess(token, waba.data.id)) {
      return notFound(reply, req.params.id);
    }
    const body = (req.body ?? {}) as B & {
      cc?: string;
      phone_number?: string;
      verified_name?: string;
    };
    if (!body.cc || !body.phone_number || !body.verified_name) {
      return invalidParam(reply, 'cc, phone_number e verified_name são obrigatórios');
    }
    const digits = `${body.cc}${String(body.phone_number).replace(/\D/g, '')}`;
    // ⚠️ a doc não define a recriação; o sim devolve o mesmo id (idempotente)
    const existing = [...state.objects.values()].find(
      (o) =>
        o.kind === 'phone_number' &&
        o.parentId === waba.data.id &&
        String(o.data.display_phone_number).replace(/\D/g, '') === digits,
    );
    if (existing) return { id: existing.data.id };
    const id = randomMetaId();
    state.objects.set(id, {
      kind: 'phone_number',
      parentId: waba.data.id,
      data: {
        id,
        display_phone_number: `+${digits}`,
        verified_name: body.verified_name,
        name_status: 'PENDING_REVIEW',
        code_verification_status: 'NOT_VERIFIED',
        quality_rating: 'UNKNOWN',
        status: 'PENDING',
      },
    });
    return { id };
  });

  app.post<{ Params: { id: string } }>(`/${v}/:id/request_code`, async (req, reply) => {
    const phone = ownedPhone(req, reply);
    if (!phone) return reply;
    const q = { ...(req.query as Q), ...((req.body as Q) ?? {}) };
    if (!q.code_method || !['SMS', 'VOICE'].includes(q.code_method) || !q.language) {
      return invalidParam(reply, 'code_method (SMS|VOICE) e language são obrigatórios');
    }
    if (phone.data.code_verification_status === 'VERIFIED') {
      return graphError(reply, 400, { message: 'Phone number is already verified', code: 136024 });
    }
    state.verificationCodes.set(
      phone.data.id,
      String(Math.floor(100_000 + Math.random() * 900_000)),
    );
    return { success: true };
  });

  app.post<{ Params: { id: string } }>(`/${v}/:id/verify_code`, async (req, reply) => {
    const phone = ownedPhone(req, reply);
    if (!phone) return reply;
    const q = { ...(req.query as Q), ...((req.body as Q) ?? {}) };
    const expected = state.verificationCodes.get(phone.data.id);
    if (!q.code || !expected || q.code !== expected) {
      return invalidParam(reply, 'The verification code is invalid or has expired');
    }
    state.verificationCodes.delete(phone.data.id);
    phone.data.code_verification_status = 'VERIFIED';
    return { success: true, id: phone.data.id };
  });

  app.post<{ Params: { id: string } }>(`/${v}/:id/register`, async (req, reply) => {
    const phone = ownedPhone(req, reply);
    if (!phone) return reply;
    const body = (req.body ?? {}) as { messaging_product?: string; pin?: string };
    if (body.messaging_product !== 'whatsapp' || !/^\d{6}$/.test(body.pin ?? '')) {
      return invalidParam(reply, 'messaging_product=whatsapp e pin de 6 dígitos são obrigatórios');
    }
    if (registrationLimited(phone.data.id)) {
      return graphError(reply, 400, {
        message:
          'Registration or Deregistration failed because there were too many attempts for this phone number in a short period of time',
        code: 133016,
      });
    }
    if (phone.data.code_verification_status !== 'VERIFIED') {
      return graphError(reply, 400, {
        message: 'Phone number needs to be verified before registering.',
        code: 133006,
      });
    }
    if (phone.data.two_step_pin && phone.data.two_step_pin !== body.pin) {
      return graphError(reply, 400, {
        message: 'Two-step verification PIN incorrect.',
        code: 133005,
      });
    }
    phone.data.two_step_pin = body.pin;
    phone.data.status = 'CONNECTED';
    return { success: true };
  });

  app.post<{ Params: { id: string } }>(`/${v}/:id/deregister`, async (req, reply) => {
    const phone = ownedPhone(req, reply);
    if (!phone) return reply;
    if (registrationLimited(phone.data.id)) {
      return graphError(reply, 400, { message: 'Too many attempts', code: 133016 });
    }
    phone.data.status = 'DISCONNECTED';
    return { success: true };
  });

  // ---------------------------------------------------------------- templates (§11)
  function ownedWaba(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const token = auth(req, reply);
    if (!token) return undefined;
    const waba = state.objects.get(req.params.id);
    if (waba?.kind !== 'waba' || !state.canAccess(token, waba.data.id)) {
      notFound(reply, req.params.id);
      return undefined;
    }
    return waba;
  }
  const templatesOf = (wabaId: string) =>
    [...state.objects.values()].filter((o) => o.kind === 'template' && o.parentId === wabaId);

  app.post<{ Params: { id: string } }>(`/${v}/:id/message_templates`, async (req, reply) => {
    const waba = ownedWaba(req, reply);
    if (!waba) return reply;
    const b = (req.body ?? {}) as {
      name?: string;
      language?: string;
      category?: string;
      parameter_format?: string;
      components?: unknown[];
    };
    if (!b.name || !/^[a-z0-9_]{1,512}$/.test(b.name))
      return invalidParam(reply, 'Invalid parameter: name');
    if (!b.language || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(b.language)) {
      return invalidParam(reply, 'Invalid parameter: language');
    }
    const category = String(b.category ?? '').toUpperCase();
    if (!['AUTHENTICATION', 'MARKETING', 'UTILITY'].includes(category)) {
      return invalidParam(reply, 'Invalid parameter: category');
    }
    if (!Array.isArray(b.components) || b.components.length === 0) {
      return invalidParam(reply, 'Invalid parameter: components');
    }
    if (
      templatesOf(waba.data.id).some(
        (t) => t.data.name === b.name && t.data.language === b.language,
      )
    ) {
      return graphError(reply, 400, {
        message: 'Content in This Language Already Exists',
        code: 100,
        error_subcode: 2388024,
      });
    }
    const id = randomMetaId();
    const upper = (c: unknown) => {
      const comp = { ...(c as Record<string, unknown>) };
      if (typeof comp.type === 'string') comp.type = comp.type.toUpperCase();
      if (typeof comp.format === 'string') comp.format = comp.format.toUpperCase();
      return comp;
    };
    state.objects.set(id, {
      kind: 'template',
      parentId: waba.data.id,
      data: {
        id,
        name: b.name,
        language: b.language,
        category,
        status: 'PENDING',
        parameter_format: String(b.parameter_format ?? 'POSITIONAL').toUpperCase(),
        components: b.components.map(upper),
        quality_score: { score: 'UNKNOWN', date: Math.floor(Date.now() / 1000) },
      },
    });
    return { id, status: 'PENDING', category };
  });

  app.get<{ Params: { id: string } }>(`/${v}/:id/message_templates`, async (req, reply) => {
    const waba = ownedWaba(req, reply);
    if (!waba) return reply;
    const q = req.query as Q;
    const data = templatesOf(waba.data.id)
      .filter((t) => !q.status || String(t.data.status).toUpperCase() === q.status.toUpperCase())
      .filter((t) => !q.name || t.data.name === q.name)
      .map((t) => pickFields(t.data, q.fields));
    return { data, paging: { cursors: { before: 'B', after: 'A' } } };
  });

  app.delete<{ Params: { id: string } }>(`/${v}/:id/message_templates`, async (req, reply) => {
    const waba = ownedWaba(req, reply);
    if (!waba) return reply;
    const q = req.query as Q;
    if (!q.name) return invalidParam(reply, 'name é obrigatório');
    const targets = templatesOf(waba.data.id).filter(
      (t) => t.data.name === q.name && (!q.hsm_id || t.data.id === q.hsm_id),
    );
    if (!targets.length) return notFound(reply, q.hsm_id ?? q.name);
    for (const t of targets) state.objects.delete(t.data.id);
    return { success: true };
  });

  app.get<{ Params: { id: string } }>(`/${v}/:id`, async (req, reply) => {
    const token = auth(req, reply);
    if (!token) return reply;
    const obj = state.objects.get(req.params.id);
    if (!obj || !state.canAccess(token, obj.data.id)) return notFound(reply, req.params.id);
    return pickFields(obj.data, (req.query as Record<string, string>).fields);
  });

  function notFound(reply: FastifyReply, id: string) {
    return graphError(reply, 400, {
      message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      type: 'GraphMethodException',
      code: 100,
      error_subcode: 33,
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  // ---------------------------------------------------------------- controle (/_sim)
  app.post('/_sim/reset', async () => {
    state.reset();
    return { ok: true };
  });

  app.post<{ Body: FixtureInput }>('/_sim/fixtures', async (req) =>
    state.addFixture(req.body, appId),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/_sim/objects/:id',
    async (req, reply) => {
      const obj = state.objects.get(req.params.id);
      if (!obj) return reply.status(404).send({ error: 'not found' });
      Object.assign(obj.data, req.body);
      return obj.data;
    },
  );

  app.post<{ Body: { token: string; valid: boolean } }>(
    '/_sim/tokens/validity',
    async (req, reply) => {
      const info = state.tokens.get(req.body.token);
      if (!info) return reply.status(404).send({ error: 'not found' });
      info.valid = req.body.valid;
      return { ok: true };
    },
  );

  app.post<{ Body: InjectedError }>('/_sim/errors', async (req) => {
    state.errors.push(req.body);
    return { queued: state.errors.length };
  });

  app.get('/_sim/requests', async () => state.requests);

  /** Código que o provedor de números receberia por SMS/voz (para testes). */
  app.get<{ Params: { id: string } }>('/_sim/verification-codes/:id', async (req, reply) => {
    const code = state.verificationCodes.get(req.params.id);
    if (!code) return reply.status(404).send({ error: 'sem código pendente' });
    return { code, sms: `WhatsApp code ${code.slice(0, 3)}-${code.slice(3)}` };
  });

  /**
   * Simula a revisão de um template: muda o status e, se houver URL, emite o webhook
   * message_template_status_update (payload como §3.9).
   */
  app.post<{
    Params: { id: string };
    Body: { event: string; reason?: string | null; category?: string; url?: string };
  }>('/_sim/templates/:id/review', async (req, reply) => {
    const t = state.objects.get(req.params.id);
    if (t?.kind !== 'template' || !t.parentId)
      return reply.status(404).send({ error: 'not found' });
    t.data.status = req.body.event;
    if (req.body.category) t.data.category = req.body.category;
    if (req.body.event === 'REJECTED') t.data.rejected_reason = req.body.reason ?? 'NONE';
    const url = req.body.url ?? opts.webhookUrl;
    const webhook = url
      ? await emitWebhook(url, {
          entryId: t.parentId,
          field: 'message_template_status_update',
          value: {
            event: req.body.event,
            message_template_id: Number(t.data.id),
            message_template_name: t.data.name,
            message_template_language: t.data.language,
            reason: req.body.event === 'REJECTED' ? (req.body.reason ?? 'NONE') : 'NONE',
            message_template_category: t.data.category,
          },
        })
      : null;
    return { template: t.data, webhook };
  });

  /** Emite um webhook assinado com o app secret (como a Meta faz). */
  app.post<{
    Body: {
      object?: string;
      entryId: string;
      field: string;
      value: unknown;
      url?: string;
      times?: number;
    };
  }>('/_sim/webhooks', async (req, reply) => {
    const url = req.body.url ?? opts.webhookUrl;
    if (!url) return reply.status(400).send({ error: 'webhookUrl não configurada' });
    const result = await emitWebhook(url, req.body);
    return result;
  });

  async function emitWebhook(
    url: string,
    input: { object?: string; entryId: string; field: string; value: unknown; times?: number },
  ) {
    const body = JSON.stringify({
      object: input.object ?? 'whatsapp_business_account',
      entry: [
        {
          id: input.entryId,
          time: Math.floor(Date.now() / 1000),
          changes: [{ field: input.field, value: input.value }],
        },
      ],
    });
    const statuses: number[] = [];
    for (let i = 0; i < (input.times ?? 1); i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signMetaPayload(body, opts.appSecret),
        },
        body,
      });
      statuses.push(res.status);
    }
    return { statuses };
  }

  return { app, state, appId, emitWebhook };
}

export type MetaSim = ReturnType<typeof createMetaSim>;
