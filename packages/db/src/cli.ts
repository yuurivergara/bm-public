import { migrate } from './migrator';

async function main() {
  const [command] = process.argv.slice(2);
  if (command !== 'migrate') {
    console.error('uso: cli migrate');
    process.exit(2);
  }
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL não definida');
  const applied = await migrate({
    adminUrl,
    appPassword: process.env.DATABASE_APP_PASSWORD,
    log: (m) => console.log(m),
  });
  console.log(applied.length ? `${applied.length} migration(s) aplicada(s)` : 'banco atualizado');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
