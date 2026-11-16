import { readFileSync } from 'node:fs';
import { createMetaSim, type FixtureInput } from './sim';

/**
 * Servidor do meta-sim.
 *   SIM_APP_SECRET, SIM_GRAPH_VERSION (obrigatórios), SIM_APP_ID, SIM_WEBHOOK_URL,
 *   SIM_FIXTURES_FILE (JSON: FixtureInput | FixtureInput[]), PORT (padrão 4010),
 *   SIM_DEMO_TOKEN (cria um portfolio/WABA/número de demonstração acessíveis por esse token).
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
  if (process.env.SIM_DEMO_TOKEN) {
    // IDs e número dos exemplos oficiais (docs/10-meta-referencia.md).
    sim.state.addFixture(
      {
        token: process.env.SIM_DEMO_TOKEN,
        business: {
          id: '506914307656634',
          name: 'Lucky Shrub (sim)',
          verification_status: 'verified',
          whatsapp_business_manager_messaging_limit: 'TIER_250',
        },
        wabas: [
          {
            id: '102290129340398',
            name: 'Lucky Shrub',
            currency: 'BRL',
            status: 'ACTIVE',
            timezone_id: '25',
            account_review_status: 'APPROVED',
            phone_numbers: [
              {
                id: '106540352242922',
                display_phone_number: '15550783881',
                verified_name: 'Lucky Shrub',
                name_status: 'APPROVED',
                quality_rating: 'GREEN',
                code_verification_status: 'VERIFIED',
                status: 'CONNECTED',
                whatsapp_business_manager_messaging_limit: 'TIER_250',
              },
            ],
          },
        ],
      },
      sim.appId,
    );
  }
  await sim.app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4010) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
