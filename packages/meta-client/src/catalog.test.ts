import { describe, expect, it } from 'vitest';
import { CATALOGED_CODES, classifyMetaError } from './catalog';
import { MetaApiError, MetaNetworkError } from './errors';

const apiErr = (code: number | null, httpStatus = 400, isTransient = false) =>
  new MetaApiError({
    message: 'x',
    code,
    subcode: null,
    type: null,
    httpStatus,
    fbtraceId: null,
    isTransient,
  });

describe('classifyMetaError', () => {
  it.each([
    [130429, 'retry_slower', true],
    [131056, 'reschedule_recipient', true],
    [131049, 'skip_recipient', false],
    [131050, 'suppress_contact', false],
    [131048, 'pause_campaign', false],
    [131026, 'fail_recipient', false],
    [131042, 'pause_tenant', false],
    [132015, 'pause_campaign_sync_template', false],
    [190, 'reconnect', false],
    [368, 'pause_tenant', false],
    [80007, 'retry_slower', true],
  ] as const)('código %i → %s', (code, action, retryable) => {
    expect(classifyMetaError(apiErr(code))).toMatchObject({ code, action, retryable });
  });

  it('família 200–299 é permissão (reconectar)', () => {
    expect(classifyMetaError(apiErr(250, 403)).action).toBe('reconnect');
  });

  it('is_transient torna retentável mesmo código não transitório', () => {
    expect(classifyMetaError(apiErr(100, 400, true))).toMatchObject({
      action: 'retry',
      retryable: true,
    });
  });

  it('opt-out (131050) nunca vira retry', () => {
    // is_transient não deveria vir junto, mas nem assim pode reenviar
    const info = classifyMetaError(apiErr(131050, 400, false));
    expect(info.retryable).toBe(false);
  });

  it('código desconhecido: 5xx repete, 4xx não', () => {
    expect(classifyMetaError(apiErr(999999, 503)).retryable).toBe(true);
    expect(classifyMetaError(apiErr(999999, 400)).retryable).toBe(false);
  });

  it('timeout de POST é ambíguo (uncertain, sem retry); falha de rede comum repete', () => {
    expect(classifyMetaError(new MetaNetworkError('t', true, true))).toMatchObject({
      action: 'uncertain',
      retryable: false,
    });
    expect(classifyMetaError(new MetaNetworkError('t', false, false))).toMatchObject({
      action: 'retry',
      retryable: true,
    });
  });

  it('cobre os códigos acrescentados na validação (docs/10 §6.2)', () => {
    for (const c of [131050, 131064, 130497, 135000, 132015, 131057, 80007, 4, 131062]) {
      expect(CATALOGED_CODES).toContain(c);
    }
  });
});
