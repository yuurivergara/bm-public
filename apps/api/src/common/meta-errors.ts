import { classifyMetaError, MetaApiError } from '@bm/meta-client';
import { HttpStatus } from '@nestjs/common';
import { toAppError } from '../assets/assets.service';
import { AppError } from './http';

/**
 * Erros da Meta em operações de ESCRITA (registro de número, templates). Diferente da leitura
 * de ativos, aqui `100` quase sempre é parâmetro inválido, e a mensagem/`details` da Meta ajudam
 * o operador (não contêm segredos). Classificação: catálogo §6 (`classifyMetaError`).
 */
export function metaWriteError(err: unknown): AppError {
  if (!(err instanceof MetaApiError) || err.code === 190) return toAppError(err);
  const info = classifyMetaError(err);
  const details = {
    metaCode: err.code,
    metaSubcode: err.subcode,
    metaDetails: err.details,
    fbtraceId: err.fbtraceId,
    action: info.action,
  };
  // §11.2: nome repetido no mesmo idioma
  if (err.code === 100 && err.subcode === 2388024) {
    return new AppError(
      HttpStatus.CONFLICT,
      'template_exists',
      'Já existe um template com esse nome neste idioma na WABA',
      details,
    );
  }
  if (err.code === 100) {
    return new AppError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'meta_invalid_request',
      `A Meta recusou os parâmetros: ${err.message}`,
      details,
    );
  }
  if (err.code === 10 || (err.code !== null && err.code >= 200 && err.code < 300)) {
    return toAppError(err);
  }
  if (info.retryable) {
    return new AppError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'meta_retry_later',
      `${info.description}. Tente novamente mais tarde.`,
      details,
    );
  }
  return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'meta_rejected', info.description, details);
}
