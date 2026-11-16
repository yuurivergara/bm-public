import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MetaApiError, MetaNetworkError } from './errors';
import { GraphHttp } from './http';

const TOKEN = 'EAAG-token-super-secreto-1234';
const SECRET = 'app-secret';

type Call = { url: URL; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fn: fn as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function http(fetchFn: typeof fetch, timeoutMs = 1000) {
  return new GraphHttp({
    baseUrl: 'https://graph.example.test',
    graphVersion: 'v99.0',
    appSecret: SECRET,
    fetch: fetchFn,
    timeoutMs,
  });
}

describe('GraphHttp', () => {
  it('monta a URL com a versão, envia Bearer e appsecret_proof (HMAC-SHA256 hex)', async () => {
    const f = fakeFetch(() => json(200, { id: '1' }));
    const res = await http(f.fn).request(TOKEN, 'GET', '/123', { query: { fields: 'name,id' } });
    expect(res.data).toEqual({ id: '1' });
    const [call] = f.calls;
    expect(call?.url.pathname).toBe('/v99.0/123');
    expect(call?.url.searchParams.get('fields')).toBe('name,id');
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', SECRET).update(TOKEN).digest('hex'),
    );
    expect(new Headers(call?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    // o token nunca vai na query string
    expect(call?.url.toString()).not.toContain(TOKEN);
  });

  it('envia corpo JSON em POST', async () => {
    const f = fakeFetch(() => json(200, { success: true }));
    await http(f.fn).request(TOKEN, 'POST', '/123/subscribed_apps', { body: { a: 1 } });
    const [call] = f.calls;
    expect(call?.init.method).toBe('POST');
    expect(call?.init.body).toBe('{"a":1}');
    expect(new Headers(call?.init.headers).get('content-type')).toBe('application/json');
  });

  it('converte o objeto de erro da Graph API em MetaApiError', async () => {
    const f = fakeFetch(() =>
      json(
        400,
        {
          error: {
            message: 'Invalid OAuth access token',
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            error_data: { messaging_product: 'whatsapp', details: 'detalhe' },
            is_transient: false,
            fbtrace_id: 'Atrace123',
          },
        },
        { 'x-fb-trace-id': 'hdrTrace' },
      ),
    );
    const err = await http(f.fn)
      .request(TOKEN, 'GET', '/123')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    const e = err as MetaApiError;
    expect(e.code).toBe(190);
    expect(e.subcode).toBe(463);
    expect(e.type).toBe('OAuthException');
    expect(e.httpStatus).toBe(400);
    expect(e.fbtraceId).toBe('Atrace123');
    expect(e.details).toBe('detalhe');
    expect(e.isTransient).toBe(false);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(String(e.stack)).not.toContain(TOKEN);
  });

  it('erro HTTP sem corpo JSON vira MetaApiError com code null', async () => {
    const f = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const e = (await http(f.fn)
      .request(TOKEN, 'GET', '/1')
      .catch((x: unknown) => x)) as MetaApiError;
    expect(e).toBeInstanceOf(MetaApiError);
    expect(e.code).toBeNull();
    expect(e.httpStatus).toBe(502);
  });

  it('timeout vira MetaNetworkError; em POST é marcado como ambíguo', async () => {
    const slow = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const get = (await http(slow.fn, 20)
      .request(TOKEN, 'GET', '/1')
      .catch((x: unknown) => x)) as MetaNetworkError;
    expect(get).toBeInstanceOf(MetaNetworkError);
    expect(get.timeout).toBe(true);
    expect(get.ambiguous).toBe(false);
    const post = (await http(slow.fn, 20)
      .request(TOKEN, 'POST', '/1/messages', { body: {} })
      .catch((x: unknown) => x)) as MetaNetworkError;
    expect(post.ambiguous).toBe(true);
  });

  it('falha de rede vira MetaNetworkError sem vazar o token', async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const e = (await http(f.fn)
      .request(TOKEN, 'GET', '/1')
      .catch((x: unknown) => x)) as MetaNetworkError;
    expect(e).toBeInstanceOf(MetaNetworkError);
    expect(e.message).not.toContain(TOKEN);
  });

  it('expõe o x-fb-trace-id da resposta de sucesso', async () => {
    const f = fakeFetch(() => json(200, {}, { 'x-fb-trace-id': 'tr-1' }));
    const res = await http(f.fn).request(TOKEN, 'GET', '/1');
    expect(res.traceId).toBe('tr-1');
  });
});
