import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  buildUrl,
  errorFromBody,
  errorMessage,
  fieldErrors,
  onSessionExpired,
} from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('erros da API', () => {
  it('usa a mensagem do corpo { code, message, details, traceId }', () => {
    const e = errorFromBody(422, {
      code: 'meta_token_invalid',
      message: 'Token da Meta inválido, expirado ou revogado',
      traceId: 't-1',
    });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('meta_token_invalid');
    expect(e.message).toBe('Token da Meta inválido, expirado ou revogado');
    expect(e.traceId).toBe('t-1');
  });

  it('troca mensagens genéricas em inglês e corpos vazios por texto em português', () => {
    expect(errorFromBody(404, { code: 'not_found', message: 'Cannot GET /api/v1/x' }).message).toBe(
      'Não encontrado.',
    );
    expect(errorFromBody(403, { message: 'Forbidden resource' }).message).toContain('permissão');
    expect(errorFromBody(502, undefined).message).toContain('Meta');
    expect(errorFromBody(500, 'html').message).toContain('servidor');
  });

  it('401 fora do login vira "sessão expirou", mas mantém o erro de senha', () => {
    expect(
      errorFromBody(401, { code: 'unauthenticated', message: 'Sessão inválida' }).message,
    ).toBe('Sua sessão expirou. Entre novamente.');
    expect(
      errorFromBody(401, { code: 'invalid_credentials', message: 'E-mail ou senha inválidos' })
        .message,
    ).toBe('E-mail ou senha inválidos');
  });

  it('extrai erros por campo nos dois formatos de validação', () => {
    const zodIssues = errorFromBody(400, {
      code: 'validation_error',
      message: 'Dados inválidos',
      details: [
        { path: 'cnpj', message: 'CNPJ inválido' },
        { path: 'cnpj', message: 'segunda' },
      ],
    });
    expect(fieldErrors(zodIssues)).toEqual({ cnpj: 'CNPJ inválido' });
    const flattened = errorFromBody(400, {
      code: 'validation_error',
      message: 'Dados inválidos',
      details: { formErrors: [], fieldErrors: { listName: ['Obrigatório'] } },
    });
    expect(fieldErrors(flattened)).toEqual({ listName: 'Obrigatório' });
    expect(fieldErrors(new Error('x'))).toEqual({});
  });

  it('erro de rede tem mensagem amigável', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toContain('Sem conexão');
  });
});

describe('request', () => {
  it('monta a URL com query sem valores vazios', () => {
    expect(buildUrl('/tenants', { q: 'ana', cursor: undefined, limit: 25, status: '' })).toBe(
      '/api/v1/tenants?q=ana&limit=25',
    );
  });

  it('envia JSON e devolve o corpo', async () => {
    const fetchMock = vi.fn(async () => json(200, { id: '1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/tenants', { name: 'A' })).resolves.toEqual({ id: '1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/tenants');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"A"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('204 devolve undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api.del('/x')).resolves.toBeUndefined();
  });

  it('401 em rota autenticada avisa a sessão expirada; no login não', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { code: 'unauthenticated', message: 'x' })),
    );
    await expect(api.get('/tenants')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(api.post('/auth/login', {})).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
    off();
  });
});
