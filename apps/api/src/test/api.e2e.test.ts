import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PASSWORD } from './harness';

let h: Harness;
let owner: { id: string; email: string; secret: string };
let ownerCookie: string;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.createUser('owner');
  ownerCookie = await h.login(owner);
});
afterAll(async () => {
  await h?.close();
});

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: unknown,
) => h.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object });

describe('health', () => {
  it('liveness e readiness públicos', async () => {
    expect((await req('GET', '/healthz')).json()).toEqual({ status: 'ok' });
    expect((await req('GET', '/readyz')).json()).toEqual({ status: 'ready' });
  });
});

describe('autenticação', () => {
  it('rotas exigem sessão', async () => {
    const res = await req('GET', '/api/v1/tenants');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('senha errada e e-mail inexistente retornam o mesmo erro', async () => {
    const wrong = await req('POST', '/api/v1/auth/login', undefined, {
      email: owner.email,
      password: 'x',
    });
    const unknown = await req('POST', '/api/v1/auth/login', undefined, {
      email: 'nao@existe.com',
      password: 'x',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().code).toBe(unknown.json().code);
  });

  it('primeiro login devolve URI do autenticador; depois de configurado, não', async () => {
    const fresh = await h.createUser('operator');
    const first = await req('POST', '/api/v1/auth/login', undefined, {
      email: fresh.email,
      password: PASSWORD,
    });
    expect(first.json().totpEnrolled).toBe(false);
    expect(first.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    await h.login(fresh);
    const second = await req('POST', '/api/v1/auth/login', undefined, {
      email: fresh.email,
      password: PASSWORD,
    });
    expect(second.json()).toMatchObject({ totpEnrolled: true });
    expect(second.json().otpauthUri).toBeUndefined();
  });

  it('código TOTP errado é rejeitado e o mesmo código não pode ser reutilizado', async () => {
    const user = await h.createUser('viewer');
    const s1 = await req('POST', '/api/v1/auth/login', undefined, {
      email: user.email,
      password: PASSWORD,
    });
    const bad = await req('POST', '/api/v1/auth/totp', undefined, {
      challengeToken: s1.json().challengeToken,
      code: '000000',
    });
    expect(bad.statusCode).toBe(401);

    const code = authenticator.generate(user.secret);
    const ok = await req('POST', '/api/v1/auth/totp', undefined, {
      challengeToken: s1.json().challengeToken,
      code,
    });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'bm_sid');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

    const s2 = await req('POST', '/api/v1/auth/login', undefined, {
      email: user.email,
      password: PASSWORD,
    });
    const replay = await req('POST', '/api/v1/auth/totp', undefined, {
      challengeToken: s2.json().challengeToken,
      code,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('desafio não pode ser usado duas vezes', async () => {
    const user = await h.createUser('viewer');
    const s1 = await req('POST', '/api/v1/auth/login', undefined, {
      email: user.email,
      password: PASSWORD,
    });
    const challengeToken = s1.json().challengeToken;
    await req('POST', '/api/v1/auth/totp', undefined, {
      challengeToken,
      code: authenticator.generate(user.secret),
    });
    await h.admin`update users set totp_last_used_step = null where id = ${user.id}`;
    const again = await req('POST', '/api/v1/auth/totp', undefined, {
      challengeToken,
      code: authenticator.generate(user.secret),
    });
    expect(again.json().code).toBe('challenge_invalid');
  });

  it('bloqueia a conta após 5 senhas erradas', async () => {
    const user = await h.createUser('operator');
    for (let i = 0; i < 5; i++) {
      await req('POST', '/api/v1/auth/login', undefined, { email: user.email, password: 'errada' });
    }
    const res = await req('POST', '/api/v1/auth/login', undefined, {
      email: user.email,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('account_locked');
  });

  it('me, sessões e logout', async () => {
    const user = await h.createUser('operator');
    const cookie = await h.login(user);
    const me = await req('GET', '/api/v1/auth/me', cookie);
    expect(me.json().user.email).toBe(user.email);
    expect(me.json().permissions).toContain('tenants.write');
    expect(me.json().permissions).not.toContain('tenants.delete_data');

    const sessions = await req('GET', '/api/v1/auth/sessions', cookie);
    expect(sessions.json().data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    expect((await req('POST', '/api/v1/auth/logout', cookie)).statusCode).toBe(204);
    expect((await req('GET', '/api/v1/auth/me', cookie)).statusCode).toBe(401);
  });

  it('operador desativado perde as sessões', async () => {
    const user = await h.createUser('operator');
    const cookie = await h.login(user);
    const res = await req('PATCH', `/api/v1/users/${user.id}`, ownerCookie, { status: 'disabled' });
    expect(res.statusCode).toBe(200);
    expect((await req('GET', '/api/v1/auth/me', cookie)).statusCode).toBe(401);
  });

  it('sessão expirada por inatividade é recusada', async () => {
    const user = await h.createUser('viewer');
    const cookie = await h.login(user);
    await h.admin`update user_sessions set idle_expires_at = now() - interval '1 second' where user_id = ${user.id}`;
    expect((await req('GET', '/api/v1/auth/me', cookie)).statusCode).toBe(401);
  });
});

describe('permissões (RBAC)', () => {
  it('viewer lê mas não escreve; operator não altera configurações nem gerencia usuários', async () => {
    const viewer = await h.createUser('viewer');
    const operator = await h.createUser('operator');
    const vc = await h.login(viewer);
    const oc = await h.login(operator);

    expect((await req('GET', '/api/v1/tenants', vc)).statusCode).toBe(200);
    expect((await req('POST', '/api/v1/tenants', vc, { name: 'X' })).statusCode).toBe(403);

    const created = await req('POST', '/api/v1/tenants', oc, { name: 'Loja do Operador' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(
      (await req('PUT', `/api/v1/tenants/${id}/settings`, oc, { capacitySafetyPct: 80 }))
        .statusCode,
    ).toBe(403);
    expect((await req('GET', '/api/v1/users', oc)).statusCode).toBe(403);
  });
});

describe('clientes', () => {
  it('cria cliente com configurações padrão e registra auditoria', async () => {
    const res = await req('POST', '/api/v1/tenants', ownerCookie, {
      name: 'Loja Exemplo',
      cnpj: '11.222.333/0001-81',
      contactPhone: '(11) 8765-4321',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'Loja Exemplo',
      cnpj: '11222333000181',
      contactPhone: '+5511987654321',
      status: 'onboarding',
      settings: { capacitySafetyPct: 90, maxMsgsPerContact24h: 1 },
    });

    const audit =
      await h.admin`select action, user_id from audit_logs where entity_id = ${body.id}`;
    expect(audit).toEqual([{ action: 'tenant.create', user_id: owner.id }]);
  });

  it('valida CNPJ, telefone e campos desconhecidos', async () => {
    const bad = await req('POST', '/api/v1/tenants', ownerCookie, {
      name: 'X',
      cnpj: '11.222.333/0001-82',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('validation_error');
    expect(
      (await req('POST', '/api/v1/tenants', ownerCookie, { name: 'X', contactPhone: '123' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await req('POST', '/api/v1/tenants', ownerCookie, { name: 'X', foo: 1 })).statusCode,
    ).toBe(400);
  });

  it('aceita CNPJ alfanumérico e recusa duplicado', async () => {
    const a = await req('POST', '/api/v1/tenants', ownerCookie, {
      name: 'Alfa',
      cnpj: '12.ABC.345/01DE-35',
    });
    expect(a.statusCode).toBe(201);
    const dup = await req('POST', '/api/v1/tenants', ownerCookie, {
      name: 'Alfa 2',
      cnpj: '12ABC34501DE35',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('cnpj_taken');
  });

  it('atualiza, muda status com transições válidas e altera configurações', async () => {
    const { id } = (
      await req('POST', '/api/v1/tenants', ownerCookie, { name: 'Loja Status' })
    ).json();

    const upd = await req('PATCH', `/api/v1/tenants/${id}`, ownerCookie, {
      notes: 'cliente piloto',
    });
    expect(upd.json().notes).toBe('cliente piloto');

    expect(
      (await req('POST', `/api/v1/tenants/${id}/status`, ownerCookie, { status: 'active' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await req('POST', `/api/v1/tenants/${id}/status`, ownerCookie, { status: 'active' }))
        .statusCode,
    ).toBe(409);

    const settings = await req('PUT', `/api/v1/tenants/${id}/settings`, ownerCookie, {
      monthlyCostCapUsd: 1500,
      capacitySafetyPct: 85,
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ monthlyCostCapUsd: '1500.00', capacitySafetyPct: 85 });

    const detail = await req('GET', `/api/v1/tenants/${id}`, ownerCookie);
    expect(detail.json().settings.capacitySafetyPct).toBe(85);

    const actions =
      await h.admin`select action from audit_logs where tenant_id = ${id} order by id`;
    expect(actions.map((a) => a.action)).toEqual([
      'tenant.create',
      'tenant.update',
      'tenant.status.active',
      'tenant.settings.update',
    ]);
  });

  it('lista com busca e paginação por cursor', async () => {
    for (const n of ['Pag A', 'Pag B', 'Pag C']) {
      await req('POST', '/api/v1/tenants', ownerCookie, { name: n });
    }
    const p1 = (await req('GET', '/api/v1/tenants?q=Pag&limit=2', ownerCookie)).json();
    expect(p1.data.map((t: { name: string }) => t.name)).toEqual(['Pag C', 'Pag B']);
    const p2 = (
      await req('GET', `/api/v1/tenants?q=Pag&limit=2&cursor=${p1.nextCursor}`, ownerCookie)
    ).json();
    expect(p2.data.map((t: { name: string }) => t.name)).toEqual(['Pag A']);
    expect(p2.nextCursor).toBeNull();
  });

  it('404 para cliente inexistente e 400 para id inválido', async () => {
    expect(
      (await req('GET', '/api/v1/tenants/00000000-0000-4000-8000-000000000000', ownerCookie))
        .statusCode,
    ).toBe(404);
    expect((await req('GET', '/api/v1/tenants/abc', ownerCookie)).statusCode).toBe(400);
  });
});

describe('auditoria', () => {
  it('não armazena segredos', async () => {
    const res = await req('POST', '/api/v1/users', ownerCookie, {
      email: 'novo@exemplo.com',
      name: 'Novo',
      role: 'operator',
      password: 'outra-senha-segura-456',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('passwordHash');
    const [row] =
      await h.admin`select after::text as after from audit_logs where action = 'user.create'`;
    expect(row?.after).not.toMatch(/password|totp_secret|outra-senha/i);
  });
});
