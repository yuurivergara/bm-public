import { createHmac } from 'node:crypto';
import { MetaApiError, MetaNetworkError } from './errors';

export interface GraphHttpOptions {
  /** Ex.: https://graph.facebook.com (produção) ou a URL do meta-sim. */
  baseUrl: string;
  /** Ex.: v24.0 — ver docs/10-meta-referencia.md. */
  graphVersion: string;
  appSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface GraphResponse<T> {
  data: T;
  httpStatus: number;
  traceId: string | null;
}

/** `appsecret_proof` = HMAC-SHA256(access_token, app_secret) em hexadecimal. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * Transporte da Graph API. O token vai só no header Authorization (nunca na URL, que pode
 * acabar em logs) e toda chamada leva `appsecret_proof`.
 */
export class GraphHttp {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GraphHttpOptions) {
    if (!/^v\d+\.\d+$/.test(opts.graphVersion)) {
      throw new Error(`graphVersion inválida: ${opts.graphVersion}`);
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get graphVersion() {
    return this.opts.graphVersion;
  }

  async request<T = unknown>(
    accessToken: string,
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      /** App Secret do app dono do token (app próprio do cliente); padrão: o da plataforma. */
      appSecret?: string;
    } = {},
  ): Promise<GraphResponse<T>> {
    const url = new URL(`${this.baseUrl}/${this.opts.graphVersion}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set(
      'appsecret_proof',
      appSecretProof(accessToken, init.appSecret ?? this.opts.appSecret),
    );

    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout =
        err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MetaNetworkError(
        timeout
          ? `Timeout após ${this.timeoutMs} ms em ${method} ${url.pathname}`
          : `Falha de rede em ${method} ${url.pathname}`,
        timeout,
        timeout && method !== 'GET',
      );
    }

    const traceId = res.headers.get('x-fb-trace-id');
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const errObj = (parsed as { error?: Record<string, unknown> } | null)?.error;
    if (!res.ok || errObj) {
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      throw new MetaApiError({
        message: str(errObj?.message) ?? `HTTP ${res.status} em ${method} ${url.pathname}`,
        code: num(errObj?.code),
        subcode: num(errObj?.error_subcode),
        type: str(errObj?.type),
        httpStatus: res.status,
        fbtraceId: str(errObj?.fbtrace_id) ?? traceId,
        errorData: errObj?.error_data,
        isTransient: errObj?.is_transient === true,
      });
    }

    return { data: parsed as T, httpStatus: res.status, traceId };
  }
}
