import { createApp } from './app';
import { loadConfig } from './config/config';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
