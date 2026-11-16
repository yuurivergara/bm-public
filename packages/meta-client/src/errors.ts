/** Erro retornado pela Graph API (objeto `error` da resposta). Nunca contém o access token. */
export class MetaApiError extends Error {
  override readonly name = 'MetaApiError';
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly httpStatus: number;
  readonly fbtraceId: string | null;
  /** `error.error_data` (ex.: `details` em erros da Cloud API). */
  readonly errorData: unknown;
  /** `error_data.details`: junto com `code`, é a base recomendada para a lógica (§6.1). */
  readonly details: string | null;
  /** `is_transient`: a Meta indica que pode ser repetido. */
  readonly isTransient: boolean;

  constructor(init: {
    message: string;
    code: number | null;
    subcode: number | null;
    type: string | null;
    httpStatus: number;
    fbtraceId: string | null;
    errorData?: unknown;
    isTransient?: boolean;
  }) {
    super(init.message);
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.httpStatus = init.httpStatus;
    this.fbtraceId = init.fbtraceId;
    this.errorData = init.errorData;
    const d = (init.errorData as { details?: unknown } | undefined)?.details;
    this.details = typeof d === 'string' ? d : null;
    this.isTransient = init.isTransient === true;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      subcode: this.subcode,
      type: this.type,
      httpStatus: this.httpStatus,
      fbtraceId: this.fbtraceId,
      details: this.details,
      isTransient: this.isTransient,
    };
  }
}

/**
 * Falha de rede/timeout. `ambiguous` = não sabemos se a Meta processou o pedido (POST que
 * expirou): não reenviar automaticamente (docs/02-arquitetura.md §6.2).
 */
export class MetaNetworkError extends Error {
  override readonly name = 'MetaNetworkError';
  constructor(
    message: string,
    readonly timeout: boolean,
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}
