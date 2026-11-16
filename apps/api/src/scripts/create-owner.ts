import 'reflect-metadata';
import { createDb, orm, users } from '@bm/db';
import { encryptSecret, LocalKeyProvider } from '@bm/shared';
import { generateTotpSecret, hashPassword, PASSWORD_MIN_LENGTH } from '../auth/crypto';

/**
 * Cria o primeiro operador (owner). Executa uma única vez por ambiente.
 *   OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... pnpm --filter @bm/api create-owner
 * O QR code do autenticador é exibido no primeiro login, após a senha.
 */
async function main() {
  const { OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD, DATABASE_URL, LOCAL_MASTER_KEY } = process.env;
  if (!OWNER_EMAIL || !OWNER_NAME || !OWNER_PASSWORD || !DATABASE_URL) {
    throw new Error('Defina OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD e DATABASE_URL');
  }
  if (OWNER_PASSWORD.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }
  if (!LOCAL_MASTER_KEY) throw new Error('LOCAL_MASTER_KEY obrigatória (KMS entra na S2)');

  const { db, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(orm.eq(users.role, 'owner'))
      .limit(1);
    if (existing) throw new Error('Já existe um owner; crie novos operadores pelo painel');

    const totpSecretEnc = await encryptSecret(
      generateTotpSecret(),
      new LocalKeyProvider(LOCAL_MASTER_KEY),
    );
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
