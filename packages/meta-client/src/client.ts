import { GraphHttp, type GraphHttpOptions } from './http';

/**
 * Cliente tipado da Graph API para ativos do WhatsApp Business.
 * Endpoints e campos conforme docs/10-meta-referencia.md (documentação oficial vigente).
 * Campos desconhecidos são preservados (index signature) e gravados em `meta_raw`.
 */

/** Campos pedidos em cada recurso (centralizados para ajuste quando a Meta mudar). */
export const FIELDS = {
  // §4.4 — o limite de mensagens é do portfolio
  business: ['id', 'name', 'verification_status', 'whatsapp_business_manager_messaging_limit'],
  // §4.1 — status/currency aparecem no guia oficial (exemplo verbatim), não na lista da referência
  waba: [
    'id',
    'name',
    'currency',
    'status',
    'timezone_id',
    'account_review_status',
    'business_verification_status',
  ],
  // §4.2/§4.3/§4.6 — `messaging_limit_tier` está depreciado; usar whatsapp_business_manager_messaging_limit
  phoneNumber: [
    'id',
    'display_phone_number',
    'verified_name',
    'name_status',
    'quality_rating',
    'code_verification_status',
    'status',
    'throughput',
    'whatsapp_business_manager_messaging_limit',
  ],
} as const;

/** Tiers de limite de mensagens (§4.6) → número de usuários únicos/24 h; null = ilimitado/sem tier. */
export function messagingLimitValue(tier: string | undefined | null): number | null {
  switch (tier) {
    case 'TIER_50':
      return 50;
    case 'TIER_250':
      return 250;
    case 'TIER_1K':
      return 1000;
    case 'TIER_2K':
      return 2000;
    case 'TIER_10K':
      return 10_000;
    case 'TIER_100K':
      return 100_000;
    default:
      return null;
  }
}

type Open = Record<string, unknown>;

export interface MetaBusiness extends Open {
  id: string;
  name?: string;
  verification_status?: string;
  whatsapp_business_manager_messaging_limit?: string;
}

export interface MetaWaba extends Open {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  account_review_status?: string;
  status?: string;
}

export interface MetaPhoneNumber extends Open {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  quality_rating?: string;
  code_verification_status?: string;
  /** ⚠️ formato da resposta não documentado (§4.3); lido de forma defensiva. */
  throughput?: { level?: string } | string;
  status?: string;
  whatsapp_business_manager_messaging_limit?: string;
}

export interface MetaDebugToken {
  app_id?: string;
  type?: string;
  is_valid?: boolean;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
  expires_at?: number;
}

interface Page<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** E.164 a partir do display_phone_number da Meta (já vem com DDI; só remove a formatação). */
export function displayToE164(display: string | undefined): string | null {
  const digits = (display ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export class MetaClient {
  readonly http: GraphHttp;

  constructor(opts: GraphHttpOptions & { appId?: string }) {
    this.http = new GraphHttp(opts);
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  private readonly appId?: string;
  private readonly appSecret: string;

  /** Operações com o token de um cliente/system user (nunca logado). */
  withToken(accessToken: string): MetaAssetsApi {
    return new MetaAssetsApi(this.http, accessToken);
  }

  /**
   * Inspeciona um token (escopos, validade, alvos). Usa o app access token (`app_id|app_secret`);
   * exige META_APP_ID configurado.
   */
  async debugToken(inputToken: string): Promise<MetaDebugToken> {
    if (!this.appId) throw new Error('META_APP_ID não configurado');
    const appToken = `${this.appId}|${this.appSecret}`;
    const res = await this.http.request<{ data: MetaDebugToken }>(appToken, 'GET', '/debug_token', {
      query: { input_token: inputToken },
    });
    return res.data.data;
  }
}

export class MetaAssetsApi {
  constructor(
    private readonly http: GraphHttp,
    private readonly token: string,
  ) {}

  async getBusiness(businessId: string): Promise<MetaBusiness> {
    return (
      await this.http.request<MetaBusiness>(
        this.token,
        'GET',
        `/${encodeURIComponent(businessId)}`,
        {
          query: { fields: FIELDS.business.join(',') },
        },
      )
    ).data;
  }

  async getWaba(wabaId: string): Promise<MetaWaba> {
    return (
      await this.http.request<MetaWaba>(this.token, 'GET', `/${encodeURIComponent(wabaId)}`, {
        query: { fields: FIELDS.waba.join(',') },
      })
    ).data;
  }

  async getPhoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber> {
    return (
      await this.http.request<MetaPhoneNumber>(
        this.token,
        'GET',
        `/${encodeURIComponent(phoneNumberId)}`,
        { query: { fields: FIELDS.phoneNumber.join(',') } },
      )
    ).data;
  }

  /** Lista todos os números da WABA (segue a paginação por cursor, até 20 páginas). */
  async listPhoneNumbers(wabaId: string): Promise<MetaPhoneNumber[]> {
    const out: MetaPhoneNumber[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.http.request<Page<MetaPhoneNumber>>(
        this.token,
        'GET',
        `/${encodeURIComponent(wabaId)}/phone_numbers`,
        { query: { fields: FIELDS.phoneNumber.join(','), limit: 100, after } },
      );
      out.push(...(res.data.data ?? []));
      after = res.data.paging?.cursors?.after;
      if (!res.data.paging?.next || !after) break;
    }
    return out;
  }

  /** Inscreve o app nos webhooks da WABA. */
  async subscribeApp(wabaId: string): Promise<boolean> {
    const res = await this.http.request<{ success?: boolean }>(
      this.token,
      'POST',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    );
    return res.data.success === true;
  }

  async listSubscribedApps(wabaId: string): Promise<unknown[]> {
    const res = await this.http.request<Page<unknown>>(
      this.token,
      'GET',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    );
    return res.data.data ?? [];
  }
}
