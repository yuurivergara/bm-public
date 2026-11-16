import { readFileSync } from 'node:fs';
import { createMetaSim, type FixtureInput } from './sim';

/**
 * Servidor do meta-sim.
 *   SIM_APP_SECRET, SIM_GRAPH_VERSION (obrigatórios), SIM_APP_ID, SIM_WEBHOOK_URL,
 *   SIM_FIXTURES_FILE (JSON: FixtureInput | FixtureInput[]), PORT (padrão 4010).
 * Rotas de controle em /_sim — não exponha o simulador publicamente.
 */
async function main() {
  const { SIM_APP_SECRET, SIM_GRAPH_VERSION, SIM_APP_ID, SIM_WEBHOOK_URL, SIM_FIXTURES_FILE } =
    process.env;
  if (!SIM_APP_SECRET || !SIM_GRAPH_VERSION) {
    throw new Error('Defina SIM_APP_SECRET e SIM_GRAPH_VERSION');
  }
  const sim = createMetaSim({
    appSecret: SIM_APP_SECRET,
    graphVersion: SIM_GRAPH_VERSION,
    appId: SIM_APP_ID,
    webhookUrl: SIM_WEBHOOK_URL,
    logger: true,
  });
  if (SIM_FIXTURES_FILE) {
    const raw = JSON.parse(readFileSync(SIM_FIXTURES_FILE, 'utf8')) as
      | FixtureInput
      | FixtureInput[];
    for (const f of Array.isArray(raw) ? raw : [raw]) sim.state.addFixture(f, sim.appId);
  }
  sim.app.get('/healthz', async () => ({ status: 'ok' }));
  await sim.app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4010) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
