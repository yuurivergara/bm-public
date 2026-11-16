import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@bm/shared';
import { describe, expect, it } from 'vitest';
import { keyProviderFromConfig, loadConfig } from './config';

const key = () => randomBytes(32).toString('base64');
const base = () => ({
  DATABASE_URL: 'postgres://bm_app:x@localhost:5432/bm',
  PHONE_HASH_PEPPER: key(),
  META_APP_SECRET: 'segredo-do-app-de-teste',
  META_WEBHOOK_VERIFY_TOKEN: 'token-de-verificacao-teste',
});

describe('loadConfig — chave mestra (D-16)', () => {
  it('aceita MASTER_KEY em staging/prod (VPS, sem KMS)', () => {
    for (const APP_ENV of ['staging', 'prod']) {
      const cfg = loadConfig({ ...base(), APP_ENV, MASTER_KEY: key() });
      expect(cfg.MASTER_KEY).toBeDefined();
      expect(cfg.MASTER_KEY_ID).toBe('master-v1');
    }
  });

  it('continua proibindo LOCAL_MASTER_KEY em staging/prod', () => {
    expect(() =>
      loadConfig({ ...base(), APP_ENV: 'prod', MASTER_KEY: key(), LOCAL_MASTER_KEY: key() }),
    ).toThrow(/LOCAL_MASTER_KEY não é permitida/);
  });

  it('exige alguma chave', () => {
    expect(() => loadConfig({ ...base(), APP_ENV: 'staging' })).toThrow(/MASTER_KEY/);
  });

  it('rejeita MASTER_KEY curta', () => {
    expect(() =>
      loadConfig({
        ...base(),
        APP_ENV: 'prod',
        MASTER_KEY: randomBytes(16).toString('base64'),
      }),
    ).toThrow(/MASTER_KEY/);
  });

  it('rejeita MASTER_KEY e LOCAL_MASTER_KEY juntas em dev (ambiguidade)', () => {
    expect(() => loadConfig({ ...base(), MASTER_KEY: key(), LOCAL_MASTER_KEY: key() })).toThrow(
      /apenas uma/,
    );
  });
});

describe('keyProviderFromConfig', () => {
  it('usa MASTER_KEY com o keyId configurado e cifra/decifra', async () => {
    const cfg = loadConfig({
      ...base(),
      APP_ENV: 'prod',
      MASTER_KEY: key(),
      MASTER_KEY_ID: 'vps-v2',
    });
    const provider = keyProviderFromConfig(cfg);
    expect(provider.keyId).toBe('vps-v2');
    const blob = await encryptSecret('segredo', provider);
    expect(await decryptSecret(blob, provider)).toBe('segredo');
  });

  it('usa LOCAL_MASTER_KEY em dev com keyId local', () => {
    const cfg = loadConfig({ ...base(), LOCAL_MASTER_KEY: key() });
    expect(keyProviderFromConfig(cfg).keyId).toBe('local-v1');
  });

  it('falha explicitamente quando só há KMS (ainda não implementado)', () => {
    const cfg = loadConfig({ ...base(), APP_ENV: 'prod', KMS_KEY_ID: 'arn:aws:kms:x' });
    expect(() => keyProviderFromConfig(cfg)).toThrow(/KMS/);
  });
});

describe('loadConfig — Meta', () => {
  it('exige app secret e verify token em staging/prod', () => {
    const { META_APP_SECRET: _a, META_WEBHOOK_VERIFY_TOKEN: _b, ...rest } = base();
    expect(() => loadConfig({ ...rest, APP_ENV: 'staging', MASTER_KEY: key() })).toThrow(
      /META_APP_SECRET/,
    );
    expect(() => loadConfig({ ...rest, LOCAL_MASTER_KEY: key() })).not.toThrow();
  });

  it('valida o formato da versão da Graph API', () => {
    expect(() =>
      loadConfig({ ...base(), LOCAL_MASTER_KEY: key(), META_GRAPH_VERSION: '24' }),
    ).toThrow(/META_GRAPH_VERSION/);
  });
});

describe('loadConfig — variáveis vazias', () => {
  it('trata string vazia como ausente (compose com VAR="")', () => {
    const cfg = loadConfig({ ...base(), LOCAL_MASTER_KEY: key(), META_APP_ID: '', KMS_KEY_ID: '' });
    expect(cfg.META_APP_ID).toBeUndefined();
    expect(cfg.KMS_KEY_ID).toBeUndefined();
  });
});
