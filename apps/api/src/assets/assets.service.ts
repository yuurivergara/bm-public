import {
  accountHealth,
  businessPortfolios,
  type DbHandle,
  metaAssetRoutes,
  metaConnections,
  orm,
  type PhoneStatus,
  phoneNumbers,
  type Tx,
  tenants,
  whatsappAccounts,
  withTenant,
} from '@bm/db';
import {
  displayToE164,
  MetaApiError,
  type MetaBusiness,
  MetaClient,
  MetaNetworkError,
  type MetaPhoneNumber,
  type MetaWaba,
  messagingLimitValue,
} from '@bm/meta-client';
import { decryptSecret, encryptSecret, type KeyProvider } from '@bm/shared';
import { HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { AuditService } from '../core/audit.service';
import { DB, KEY_PROVIDER, META_CLIENT } from '../core/tokens';

const { and, eq, inArray, ne } = orm;

export interface ConnectInput {
  businessId: string;
  wabaId: string;
  accessToken: string;
  method: 'partner_share' | 'manual';
  subscribeWebhooks: boolean;
}

interface FetchedAssets {
  business: MetaBusiness;
  waba: MetaWaba;
  phones: MetaPhoneNumber[];
  subscribed: boolean;
}

export interface SyncError {
  wabaId: string;
  code: string;
  message: string;
}

/** Status do número na Meta → status interno (docs/10-meta-referencia.md). */
export function mapPhoneStatus(metaStatus: string | undefined): PhoneStatus {
  switch ((metaStatus ?? '').toUpperCase()) {
    case 'CONNECTED':
      return 'connected';
    case 'FLAGGED':
      return 'flagged';
    case 'RESTRICTED':
    case 'RATE_LIMITED':
      return 'restricted';
    case 'DISCONNECTED':
    case 'DELETED':
    case 'BANNED':
    case 'MIGRATED':
      return 'disconnected';
    default:
      return 'pending';
  }
}

/** Traduz erros da Meta para erros da plataforma (sem vazar token). */
export function toAppError(err: unknown): AppError {
  if (err instanceof MetaApiError) {
    const details = { metaCode: err.code, metaSubcode: err.subcode, fbtraceId: err.fbtraceId };
    if (err.code === 190) {
      return new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'meta_token_invalid',
        'Token da Meta inválido, expirado ou revogado',
        details,
      );
    }
    if (
      err.code === 100 ||
      err.code === 10 ||
      (err.code !== null && err.code >= 200 && err.code < 300)
    ) {
      return new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'meta_asset_not_accessible',
        'O token não tem acesso a esse ativo (ID incorreto ou sem permissão)',
        details,
      );
    }
    return new AppError(
      HttpStatus.BAD_GATEWAY,
      'meta_error',
      `Erro da Meta: ${err.message}`,
      details,
    );
  }
  if (err instanceof MetaNetworkError) {
    return new AppError(
      HttpStatus.GATEWAY_TIMEOUT,
      'meta_unavailable',
      'Meta indisponível: tente novamente',
    );
  }
  throw err;
}

const last4 = (token: string) => token.slice(-4);

@Injectable()
export class AssetsService {
  private readonly logger = new Logger('AssetsService');

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(META_CLIENT) private readonly meta: MetaClient,
    private readonly audit: AuditService,
  ) {}

  /** Visão dos ativos do cliente (nunca inclui tokens). */
  async list(tenantId: string) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, (tx) => this.view(tx));
  }

  /**
   * Cadastro por parceria/manual: valida o acesso na Meta com o token informado, inscreve o app
   * nos webhooks da WABA e grava tudo numa transação (com auditoria). Idempotente por cliente.
   */
  async connect(tenantId: string, input: ConnectInput, ctx: RequestContext) {
    const tenant = await this.requireTenant(tenantId);
    if (tenant.status === 'offboarded') {
      throw new AppError(HttpStatus.CONFLICT, 'tenant_offboarded', 'Cliente desligado');
    }
    await this.assertNotOwnedByOther(tenantId, [input.businessId, input.wabaId]);

    let fetched: FetchedAssets;
    try {
      fetched = await this.fetchAssets(
        input.accessToken,
        input.businessId,
        input.wabaId,
        input.subscribeWebhooks,
      );
    } catch (err) {
      throw toAppError(err);
    }
    await this.assertNotOwnedByOther(
      tenantId,
      fetched.phones.map((p) => p.id),
    );

    const tokenEnc = await encryptSecret(input.accessToken, this.keys);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const now = new Date();
      // Conexão: reaproveita a da WABA, se já existir; senão cria.
      const [existingWaba] = await tx
        .select({ connectionId: whatsappAccounts.connectionId })
        .from(whatsappAccounts)
        .where(eq(whatsappAccounts.metaWabaId, input.wabaId))
        .limit(1);
      let connectionId = existingWaba?.connectionId ?? null;
      const connValues = {
        accessTokenEnc: tokenEnc,
        keyId: this.keys.keyId,
        tokenLast4: last4(input.accessToken),
        status: 'active' as const,
        lastValidatedAt: now,
        lastError: null,
        updatedAt: now,
      };
      if (connectionId) {
        await tx
          .update(metaConnections)
          .set(connValues)
          .where(eq(metaConnections.id, connectionId));
      } else {
        const [conn] = await tx
          .insert(metaConnections)
          .values({ tenantId, kind: 'system_user', method: input.method, ...connValues })
          .returning({ id: metaConnections.id });
        connectionId = conn?.id ?? null;
      }

      const portfolioId = await this.upsertPortfolio(tx, tenantId, fetched.business, now);
      const wabaRowId = await this.upsertWaba(
        tx,
        tenantId,
        portfolioId,
        connectionId,
        fetched.waba,
        now,
        {
          subscribed: fetched.subscribed,
        },
      );
      for (const phone of fetched.phones) {
        await this.upsertPhone(tx, tenantId, wabaRowId, phone, now);
      }

      await tx
        .insert(metaAssetRoutes)
        .values([
          { metaId: fetched.business.id, assetType: 'business' as const, tenantId },
          { metaId: fetched.waba.id, assetType: 'waba' as const, tenantId },
          ...fetched.phones.map((p) => ({
            metaId: p.id,
            assetType: 'phone_number' as const,
            tenantId,
          })),
        ])
        .onConflictDoNothing();

      await this.audit.record(
        ctx,
        {
          action: 'assets.connect',
          entityType: 'whatsapp_account',
          entityId: wabaRowId,
          tenantId,
          after: {
            method: input.method,
            businessId: fetched.business.id,
            wabaId: fetched.waba.id,
            phoneNumberIds: fetched.phones.map((p) => p.id),
            webhooksSubscribed: fetched.subscribed,
            tokenLast4: last4(input.accessToken),
          },
        },
        tx,
      );
      return this.view(tx);
    });
  }

  /** Re-sincroniza dados, limites e qualidade de todas as WABAs do cliente. */
  async sync(tenantId: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    const targets = await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .select({
          wabaId: whatsappAccounts.metaWabaId,
          businessId: businessPortfolios.metaBusinessId,
          connectionId: metaConnections.id,
          tokenEnc: metaConnections.accessTokenEnc,
        })
        .from(whatsappAccounts)
        .innerJoin(businessPortfolios, eq(businessPortfolios.id, whatsappAccounts.portfolioId))
        .innerJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
        .where(ne(metaConnections.status, 'revoked')),
    );

    const errors: SyncError[] = [];
    for (const t of targets) {
      const token = await decryptSecret(t.tokenEnc, this.keys);
      try {
        const fetched = await this.fetchAssets(token, t.businessId, t.wabaId, false);
        await withTenant(this.handle.db, tenantId, async (tx) => {
          const now = new Date();
          const portfolioId = await this.upsertPortfolio(tx, tenantId, fetched.business, now);
          const wabaRowId = await this.upsertWaba(
            tx,
            tenantId,
            portfolioId,
            t.connectionId,
            fetched.waba,
            now,
            {},
          );
          for (const phone of fetched.phones)
            await this.upsertPhone(tx, tenantId, wabaRowId, phone, now);
          await tx
            .insert(metaAssetRoutes)
            .values(
              fetched.phones.map((p) => ({
                metaId: p.id,
                assetType: 'phone_number' as const,
                tenantId,
              })),
            )
            .onConflictDoNothing();
          await tx
            .update(metaConnections)
            .set({ status: 'active', lastValidatedAt: now, lastError: null, updatedAt: now })
            .where(eq(metaConnections.id, t.connectionId));
        });
      } catch (err) {
        const appErr = toAppError(err);
        const code = appErr.code;
        errors.push({ wabaId: t.wabaId, code, message: appErr.message });
        this.logger.warn(`sync da WABA ${t.wabaId} falhou: ${code}`);
        if (code === 'meta_token_invalid') {
          await withTenant(this.handle.db, tenantId, async (tx) => {
            await tx
              .update(metaConnections)
              .set({
                status: 'broken',
                lastError: { code, details: appErr.details ?? null, at: new Date().toISOString() },
                updatedAt: new Date(),
              })
              .where(eq(metaConnections.id, t.connectionId));
            await this.audit.record(
              ctx,
              {
                action: 'assets.connection.broken',
                entityType: 'meta_connection',
                entityId: t.connectionId,
                tenantId,
                after: { code },
              },
              tx,
            );
          });
        }
      }
    }
    const view = await withTenant(this.handle.db, tenantId, (tx) => this.view(tx));
    return { ...view, syncErrors: errors };
  }

  // ------------------------------------------------------------------ internos

  private async fetchAssets(
    token: string,
    businessId: string,
    wabaId: string,
    subscribe: boolean,
  ): Promise<FetchedAssets> {
    const api = this.meta.withToken(token);
    const waba = await api.getWaba(wabaId);
    const [business, phones] = await Promise.all([
      api.getBusiness(businessId),
      api.listPhoneNumbers(wabaId),
    ]);
    const subscribed = subscribe ? await api.subscribeApp(wabaId) : false;
    return { business, waba, phones, subscribed };
  }

  private async requireTenant(tenantId: string) {
    const [tenant] = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Cliente não encontrado');
    return tenant;
  }

  /** Um ativo Meta pertence a um único cliente (D-02/D-14). */
  private async assertNotOwnedByOther(tenantId: string, metaIds: string[]) {
    if (!metaIds.length) return;
    const owned = await this.handle.db
      .select({ metaId: metaAssetRoutes.metaId })
      .from(metaAssetRoutes)
      .where(and(inArray(metaAssetRoutes.metaId, metaIds), ne(metaAssetRoutes.tenantId, tenantId)))
      .limit(1);
    if (owned.length) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'asset_owned_by_other_tenant',
        'Esse ativo da Meta já está vinculado a outro cliente',
        { metaId: owned[0]?.metaId },
      );
    }
  }

  private async upsertPortfolio(tx: Tx, tenantId: string, b: MetaBusiness, now: Date) {
    const tier = b.whatsapp_business_manager_messaging_limit ?? null;
    const values = {
      name: b.name ?? null,
      verificationStatus: b.verification_status ?? null,
      ...(tier
        ? {
            messagingLimitTier: tier,
            messagingLimitValue: messagingLimitValue(tier),
            limitSyncedAt: now,
          }
        : {}),
      metaRaw: b,
      syncedAt: now,
      updatedAt: now,
    };
    const [row] = await tx
      .insert(businessPortfolios)
      .values({ tenantId, metaBusinessId: b.id, ...values })
      .onConflictDoUpdate({ target: businessPortfolios.metaBusinessId, set: values })
      .returning({ id: businessPortfolios.id });
    if (!row) throw new Error('falha ao gravar portfolio');
    return row.id;
  }

  private async upsertWaba(
    tx: Tx,
    tenantId: string,
    portfolioId: string,
    connectionId: string | null,
    w: MetaWaba,
    now: Date,
    opts: { subscribed?: boolean },
  ) {
    const values = {
      portfolioId,
      connectionId,
      name: w.name ?? null,
      currency: w.currency ?? null,
      timezoneId: w.timezone_id ?? null,
      accountReviewStatus: w.account_review_status ?? null,
      metaRaw: w,
      syncedAt: now,
      updatedAt: now,
      ...(opts.subscribed !== undefined ? { webhooksSubscribed: opts.subscribed } : {}),
    };
    const [row] = await tx
      .insert(whatsappAccounts)
      .values({ tenantId, metaWabaId: w.id, ...values })
      .onConflictDoUpdate({ target: whatsappAccounts.metaWabaId, set: values })
      .returning({ id: whatsappAccounts.id });
    if (!row) throw new Error('falha ao gravar WABA');
    return row.id;
  }

  private async upsertPhone(
    tx: Tx,
    tenantId: string,
    wabaRowId: string,
    p: MetaPhoneNumber,
    now: Date,
  ) {
    const [before] = await tx
      .select({
        id: phoneNumbers.id,
        qualityRating: phoneNumbers.qualityRating,
        status: phoneNumbers.status,
      })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.metaPhoneNumberId, p.id))
      .limit(1);
    const status = mapPhoneStatus(p.status);
    const values = {
      wabaId: wabaRowId,
      phoneE164: displayToE164(p.display_phone_number) ?? `+${p.id}`,
      displayPhoneNumber: p.display_phone_number ?? null,
      verifiedName: p.verified_name ?? null,
      nameStatus: p.name_status ?? null,
      qualityRating: p.quality_rating ?? null,
      messagingLimitTier: p.whatsapp_business_manager_messaging_limit ?? null,
      throughputLevel:
        typeof p.throughput === 'string' ? p.throughput : (p.throughput?.level ?? null),
      codeVerificationStatus: p.code_verification_status ?? null,
      metaStatus: p.status ?? null,
      status,
      metaRaw: p,
      syncedAt: now,
      updatedAt: now,
    };
    const [row] = await tx
      .insert(phoneNumbers)
      .values({ tenantId, metaPhoneNumberId: p.id, ...values })
      .onConflictDoUpdate({ target: phoneNumbers.metaPhoneNumberId, set: values })
      .returning({ id: phoneNumbers.id });
    if (!row) throw new Error('falha ao gravar número');
    if (!before || before.qualityRating !== values.qualityRating || before.status !== status) {
      await tx.insert(accountHealth).values({
        tenantId,
        entityType: 'phone_number',
        entityId: row.id,
        qualityRating: values.qualityRating,
        status,
        source: 'sync',
        signal: { quality_rating: p.quality_rating ?? null, status: p.status ?? null },
      });
    }
    return row.id;
  }

  private async view(tx: Tx) {
    const [portfolios, wabas, phones, connections] = await Promise.all([
      tx.select().from(businessPortfolios),
      tx.select().from(whatsappAccounts),
      tx.select().from(phoneNumbers),
      tx
        .select({
          id: metaConnections.id,
          kind: metaConnections.kind,
          method: metaConnections.method,
          tokenLast4: metaConnections.tokenLast4,
          status: metaConnections.status,
          lastValidatedAt: metaConnections.lastValidatedAt,
          lastError: metaConnections.lastError,
          createdAt: metaConnections.createdAt,
        })
        .from(metaConnections),
    ]);
    const strip = <T extends { metaRaw?: unknown }>({ metaRaw: _r, ...rest }: T) => rest;
    return {
      connections,
      portfolios: portfolios.map((p) => ({
        ...strip(p),
        wabas: wabas
          .filter((w) => w.portfolioId === p.id)
          .map((w) => ({
            ...strip(w),
            phoneNumbers: phones.filter((n) => n.wabaId === w.id).map(strip),
          })),
      })),
    };
  }
}
