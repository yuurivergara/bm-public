import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC preserva decorators e metadata exigidos pela injeção de dependência do NestJS.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { testTimeout: 30_000, hookTimeout: 60_000, pool: 'forks' },
});
