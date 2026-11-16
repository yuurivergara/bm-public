import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ authRateLimit: 3 });
});
afterAll(async () => {
  await h?.close();
});

describe('rate limit de login', () => {
  it('responde 429 com código estável após o limite por IP', async () => {
    const attempt = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@b.com', password: 'x' },
      });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('rate_limited');
  });
});
