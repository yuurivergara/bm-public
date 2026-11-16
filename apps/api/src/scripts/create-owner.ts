import 'reflect-metadata';
import { createDb, orm, users } from '@bm/db';
import { encryptSecret } from '@bm/shared';
import { generateTotpSecret, hashPassword, PASSWORD_MIN_LENGTH } from '../auth/crypto';
import { keyProviderFromConfig, loadConfig } from '../config/config';

/**
 * Cria o primeiro operador (owner). Executa uma única vez por ambiente.
 *   OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... pnpm --filter @bm/api create-owner
 * Em staging/prod, rode dentro do container da API (já tem DATABASE_URL e a chave mestra):
 *   OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... node dist/scripts/create-owner.js
 * O QR code do autenticador é exibido no primeiro login, após a senha.
 */
async function main() {
  const { OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD } = process.env;
  if (!OWNER_EMAIL || !OWNER_NAME || !OWNER_PASSWORD) {
    throw new Error('Defina OWNER_EMAIL, OWNER_NAME e OWNER_PASSWORD');
  }
  if (OWNER_PASSWORD.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }
  const config = loadConfig();
  const keys = keyProviderFromConfig(config);

  const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
  try {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(orm.eq(users.role, 'owner'))
      .limit(1);
    if (existing) throw new Error('Já existe um owner; crie novos operadores pelo painel');

    const totpSecretEnc = await encryptSecret(generateTotpSecret(), keys);
    const [user] = await db
      .insert(users)
      .values({
        email: OWNER_EMAIL.trim().toLowerCase(),
        name: OWNER_NAME.trim(),
        role: 'owner',
        passwordHash: await hashPassword(OWNER_PASSWORD),
        totpSecretEnc,
      })
      .returning({ id: users.id, email: users.email });
    console.log(`Owner criado: ${user?.email}. Faça login para configurar o autenticador (TOTP).`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
