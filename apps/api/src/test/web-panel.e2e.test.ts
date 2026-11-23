import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

/** Painel web servido pela API (WEB_DIST_DIR) com fallback do SPA. */
describe('painel web (SPA) servido pela API', () => {
  let h: Harness;
  const dir = mkdtempSync(join(tmpdir(), 'bm-web-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Painel</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    h = await createHarness({ env: { WEB_DIST_DIR: dir } });
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => h.app.inject({ method: 'GET', url });

  it('serve o index.html na raiz e nas rotas do SPA, sem cache', async () => {
    for (const url of ['/', '/clientes', '/clientes/123/contatos?x=1', '/disparos/novo']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<title>Painel</title>');
    }
  });

  it('serve assets com cache longo', async () => {
    const res = await get('/assets/app-abc123.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('API, webhooks, health e arquivos inexistentes continuam com 404 em JSON', async () => {
    for (const url of ['/api/v1/nao-existe', '/api', '/webhooks/outra', '/assets/sumiu.js']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('not_found');
    }
    expect((await get('/healthz')).statusCode).toBe(200);
    expect((await get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('sem build do painel a API não serve nada além da API', async () => {
    const other = await createHarness({ env: { WEB_DIST_DIR: join(dir, 'inexistente') } });
    try {
      const res = await other.app.inject({ method: 'GET', url: '/clientes' });
      expect(res.statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });
});
