/**
 * Cliente HTTP do painel. A API responde erros como { code, message, details, traceId }; aqui eles
 * viram ApiError com a mensagem já pronta para mostrar ao usuário (em português).
 */

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Mensagens amigáveis para erros sem corpo JSON (proxy, rede, servidor fora do ar). */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'Algum dado não está certo. Confira o formulário.',
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Você não tem permissão para fazer isso.',
  404: 'Não encontrado.',
  409: 'Essa ação conflita com o estado atual. Atualize a página e tente de novo.',
  413: 'Arquivo grande demais.',
  429: 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.',
  502: 'O servidor da Meta não respondeu direito. Tente de novo em instantes.',
  503: 'O sistema está indisponível no momento. Tente de novo em instantes.',
  504: 'O servidor demorou demais para responder. Tente de novo.',
};

/** Converte uma resposta de erro (qualquer formato) em ApiError. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return errorFromBody(res.status, body);
}

export function errorFromBody(status: number, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : `http_${status}`;
  const generic =
    STATUS_MESSAGES[status] ??
    (status >= 500 ? 'Erro inesperado no servidor. Tente de novo.' : 'Não foi possível concluir.');
  let message = typeof b.message === 'string' && b.message.trim() ? b.message : generic;
  // Mensagens genéricas do Nest em inglês ("Not Found", "Forbidden resource") → português.
  if (/^(not found|forbidden|unauthorized|cannot \w+ )/i.test(message)) message = generic;
  if (code === 'unauthenticated' || status === 401) {
    if (!/senha|código|login/i.test(message)) message = STATUS_MESSAGES[401] as string;
  }
  return new ApiError(
    status,
    code,
    message,
    b.details,
    typeof b.traceId === 'string' ? b.traceId : undefined,
  );
}

/** Erros de validação do zod (400 validation_error) por campo: { "contactEmail": "..." }. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'validation_error') return {};
  const out: Record<string, string> = {};
  const d = err.details;
  if (Array.isArray(d)) {
    for (const item of d) {
      const it = item as { path?: unknown; message?: unknown };
      if (typeof it.path === 'string' && typeof it.message === 'string' && !(it.path in out)) {
        out[it.path] = it.message;
      }
    }
  } else if (d && typeof d === 'object' && 'fieldErrors' in d) {
    // formato do zod .flatten() (upload de contatos)
    const fe = (d as { fieldErrors: Record<string, string[] | undefined> }).fieldErrors;
    for (const [k, v] of Object.entries(fe)) if (v?.[0]) out[k] = v[0];
  }
  return out;
}

/** Texto para mostrar ao usuário a partir de qualquer erro. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) {
    return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Algo deu errado. Tente de novo.';
}

export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;
export const isUnauthenticated = (err: unknown) => err instanceof ApiError && err.status === 401;

type Listener = () => void;
const expiredListeners = new Set<Listener>();
/** Avisado quando uma chamada autenticada recebe 401 (sessão expirada ou revogada). */
export function onSessionExpired(fn: Listener): () => void {
  expiredListeners.add(fn);
  return () => expiredListeners.delete(fn);
}

export interface RequestOptions {
  body?: unknown;
  /** FormData vai como multipart (sem Content-Type manual). */
  form?: FormData;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

export async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401 && !path.startsWith('/auth/')) {
      for (const fn of expiredListeners) fn();
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, { form }),
};
