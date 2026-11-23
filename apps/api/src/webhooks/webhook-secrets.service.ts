import {
  type DbHandle,
  metaAssetRoutes,
  metaConnections,
  orm,
  whatsappAccounts,
  withTenant,
} from '@bm/db';
import { verifyMetaSignature } from '@bm/meta-client';
import { decryptSecret, type KeyProvider } from '@bm/shared';
import { Inject, Injectable } from '@nestjs/common';
import { DB, KEY_PROVIDER } from '../core/tokens';

const { and, eq, inArray, isNotNull } = orm;

/**
 * Webhooks de apps próprios de clientes (ponte até o Tech Provider): chegam assinados com o App
 * Secret do app DELE. Só aceita se a assinatura bater com o secret de uma conexão e **todas** as
 * WABAs do payload forem dessa conexão — um cliente não consegue injetar eventos de outro.
 */
@Injectable()
export class WebhookSecretsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  async verifyWithConnectionSecret(
    rawBody: Buffer,
    signature: string | undefined,
    body: unknown,
  ): Promise<boolean> {
    if (!signature) return false;
    const entries = (body as { entry?: { id?: unknown }[] } | undefined)?.entry;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const ids = [...new Set(entries.map((e) => String(e?.id ?? '')))];
    if (ids.some((id) => !/^\d{5,25}$/.test(id))) return false;

    const routes = await this.handle.db
      .select({ metaId: metaAssetRoutes.metaId, tenantId: metaAssetRoutes.tenantId })
      .from(metaAssetRoutes)
      .where(inArray(metaAssetRoutes.metaId, ids));
    const tenants = [...new Set(routes.map((r) => r.tenantId))];
    if (routes.length !== ids.length || tenants.length !== 1) return false;
    const tenantId = tenants[0] as string;

    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .select({
          connectionId: metaConnections.id,
          wabaId: whatsappAccounts.metaWabaId,
          secretEnc: metaConnections.appSecretEnc,
        })
        .from(whatsappAccounts)
        .innerJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
        .where(
          and(inArray(whatsappAccounts.metaWabaId, ids), isNotNull(metaConnections.appSecretEnc)),
        ),
    );
    const byConnection = new Map<string, { wabas: Set<string>; secretEnc: Buffer }>();
    for (const r of rows) {
      if (!r.secretEnc) continue;
      const c = byConnection.get(r.connectionId) ?? { wabas: new Set(), secretEnc: r.secretEnc };
      c.wabas.add(r.wabaId);
      byConnection.set(r.connectionId, c);
    }
    for (const c of byConnection.values()) {
      if (!ids.every((id) => c.wabas.has(id))) continue;
      const secret = await decryptSecret(c.secretEnc, this.keys);
      if (verifyMetaSignature(rawBody, signature, secret)) return true;
    }
    return false;
  }
}
