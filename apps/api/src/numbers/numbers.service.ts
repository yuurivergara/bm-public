import { randomInt } from 'node:crypto';
import {
  type DbHandle,
  type InventoryStatus,
  metaAssetRoutes,
  metaConnections,
  type NumberProviderKind,
  numberAssignments,
  numberInventory,
  numberProviders,
  orm,
  phoneNumbers,
  setTenantContext,
  type Tx,
  tenants,
  whatsappAccounts,
  withTenant,
} from '@bm/db';
import { MetaApiError, type MetaClient } from '@bm/meta-client';
import {
  decryptSecret,
  encryptSecret,
  type KeyProvider,
  maskPhone,
  normalizePhone,
} from '@bm/shared';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import { metaWriteError } from '../common/meta-errors';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../core/audit.service';
import { DB, KEY_PROVIDER, META_CLIENT } from '../core/tokens';

const { and, asc, eq, isNull, ne, or, lte, sql } = orm;

export interface ProviderInput {
  name: string;
  apiKind: NumberProviderKind;
}

export interface InventoryInput {
  providerId: string;
  phone: string;
  monthlyCostBrl: number;
  notes?: string | null;
}

export interface AssignInput {
  /** WABA local (uuid) que receberá o número. */
  wabaId: string;
  /** Número específico do estoque; se omitido, usa o disponível mais antigo. */
  inventoryId?: string;
  /** Nome exibido solicitado à Meta. */
  verifiedName: string;
}

/** Separa E.164 em código do país + número nacional (para o add phone number da Meta). */
export function splitE164(e164: string): { cc: string; national: string } {
  // Inventário atual: Brasil. Outros países exigem tabela de DDI; recusamos explicitamente.
  if (e164.startsWith('+55')) return { cc: '55', national: e164.slice(3) };
  throw new AppError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'unsupported_country',
    'Por enquanto só números do Brasil (+55) entram no estoque',
  );
}

@Injectable()
export class NumbersService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(META_CLIENT) private readonly meta: MetaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ provedores

  listProviders() {
    return this.handle.db
      .select({
        id: numberProviders.id,
        name: numberProviders.name,
        apiKind: numberProviders.apiKind,
        createdAt: numberProviders.createdAt,
      })
      .from(numberProviders)
      .orderBy(asc(numberProviders.name));
  }

  async createProvider(input: ProviderInput, ctx: RequestContext) {
    return this.handle.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(numberProviders)
        .values(input)
        .onConflictDoNothing({ target: numberProviders.name })
        .returning({
          id: numberProviders.id,
          name: numberProviders.name,
          apiKind: numberProviders.apiKind,
          createdAt: numberProviders.createdAt,
        });
      if (!p) throw new AppError(HttpStatus.CONFLICT, 'provider_exists', 'Provedor já cadastrado');
      await this.audit.record(
        ctx,
        {
          action: 'number_provider.create',
          entityType: 'number_provider',
          entityId: p.id,
          after: p,
        },
        tx,
      );
      return p;
    });
  }

  // ------------------------------------------------------------------ estoque

  async listInventory(status?: InventoryStatus) {
    const rows = await this.handle.db
      .select()
      .from(numberInventory)
      .where(status ? eq(numberInventory.status, status) : undefined)
      .orderBy(asc(numberInventory.acquiredAt));
    return rows.map((r) => ({ ...r, monthlyCostBrl: Number(r.monthlyCostBrl) }));
  }

  async addInventory(input: InventoryInput, ctx: RequestContext) {
    const e164 = this.parseOperatorNumber(input.phone);
    return this.handle.db.transaction(async (tx) => {
      const [provider] = await tx
        .select({ id: numberProviders.id })
        .from(numberProviders)
        .where(eq(numberProviders.id, input.providerId));
      if (!provider) throw new NotFoundException('Provedor não encontrado');
      const [row] = await tx
        .insert(numberInventory)
        .values({
          providerId: input.providerId,
          phoneE164: e164,
          monthlyCostBrl: input.monthlyCostBrl.toFixed(2),
          notes: input.notes ?? null,
        })
        .onConflictDoNothing({ target: numberInventory.phoneE164 })
        .returning();
      if (!row)
        throw new AppError(HttpStatus.CONFLICT, 'number_exists', 'Número já está no estoque');
      await this.audit.record(
        ctx,
        {
          action: 'number_inventory.create',
          entityType: 'number_inventory',
          entityId: row.id,
          after: { ...row, phoneE164: maskPhone(row.phoneE164) },
        },
        tx,
      );
      return { ...row, monthlyCostBrl: Number(row.monthlyCostBrl) };
    });
  }

  /**
   * Números do operador entram sempre em E.164 explícito: nada de "corrigir" nono dígito num
   * número virtual (ele pode ser fixo).
   */
  private parseOperatorNumber(raw: string): string {
    const trimmed = raw.trim();
    const n = normalizePhone(trimmed);
    if (
      !trimmed.startsWith('+') ||
      !n.ok ||
      n.fixedNinthDigit ||
      n.e164 !== trimmed.replace(/[^\d+]/g, '')
    ) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'invalid_phone',
        'Informe o número em E.164 exato, ex.: +5511912345678',
      );
    }
    splitE164(n.e164);
    return n.e164;
  }

  // ------------------------------------------------------------------ atribuição (D-13)

  /** Situação do número do cliente: atribuição ativa + número na WABA + estado do registro. */
  async tenantNumber(tenantId: string) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, (tx) => this.currentView(tx));
  }

  /**
   * Atribui um número do estoque e o adiciona à WABA do cliente na Meta. Idempotente: repetir a
   * chamada depois de uma falha na Meta retoma do ponto em que parou, sem duplicar ativos.
   */
  async assign(tenantId: string, input: AssignInput, ctx: RequestContext) {
    await this.requireTenant(tenantId);

    const assignment = await this.handle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const waba = await this.wabaWithToken(tx, input.wabaId);

      const [active] = await tx
        .select()
        .from(numberAssignments)
        .where(isNull(numberAssignments.releasedAt))
        .limit(1);
      if (active) {
        if (input.inventoryId && active.inventoryId !== input.inventoryId) {
          throw new AppError(
            HttpStatus.CONFLICT,
            'tenant_has_number',
            'O cliente já tem um número atribuído (D-13: um número ativo por cliente)',
          );
        }
        return { ...active, waba };
      }

      // D-13 também vale para número compartilhado por parceria
      const [otherPhone] = await tx
        .select({ id: phoneNumbers.id })
        .from(phoneNumbers)
        .where(ne(phoneNumbers.status, 'disconnected'))
        .limit(1);
      if (otherPhone) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'tenant_has_number',
          'O cliente já tem um número ativo na WABA (D-13: um número ativo por cliente)',
        );
      }

      const [inv] = await tx
        .select()
        .from(numberInventory)
        .where(
          and(
            input.inventoryId ? eq(numberInventory.id, input.inventoryId) : undefined,
            or(
              eq(numberInventory.status, 'available'),
              and(
                eq(numberInventory.status, 'quarantine'),
                lte(numberInventory.quarantineUntil, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(asc(numberInventory.acquiredAt))
        .limit(1)
        .for('update', input.inventoryId ? {} : { skipLocked: true });
      if (!inv) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'number_unavailable',
          input.inventoryId
            ? 'Número indisponível (atribuído, em quarentena ou cancelado)'
            : 'Não há número disponível no estoque',
        );
      }
      await tx
        .update(numberInventory)
        .set({ status: 'verifying', quarantineUntil: null, updatedAt: new Date() })
        .where(eq(numberInventory.id, inv.id));
      const [row] = await tx
        .insert(numberAssignments)
        .values({ inventoryId: inv.id, tenantId, assignedBy: ctx.userId ?? null })
        .returning();
      if (!row) throw new Error('falha ao criar atribuição');
      await this.audit.record(
        ctx,
        {
          action: 'number.assign',
          entityType: 'number_assignment',
          entityId: row.id,
          tenantId,
          after: { inventoryId: inv.id, phone: maskPhone(inv.phoneE164), wabaId: input.wabaId },
        },
        tx,
      );
      return { ...row, waba };
    });

    if (!assignment.phoneNumberId) {
      await this.addToWaba(
        tenantId,
        assignment.id,
        assignment.inventoryId,
        assignment.waba,
        input,
        ctx,
      );
    }
    return this.tenantNumber(tenantId);
  }

  /** Passo 1 do registro: adiciona o número à WABA (POST /{waba-id}/phone_numbers). */
  private async addToWaba(
    tenantId: string,
    assignmentId: string,
    inventoryId: string,
    waba: { id: string; metaWabaId: string; token: string; appSecret?: string },
    input: AssignInput,
    ctx: RequestContext,
  ) {
    const [inv] = await this.handle.db
      .select()
      .from(numberInventory)
      .where(eq(numberInventory.id, inventoryId));
    if (!inv) throw new NotFoundException('Número do estoque não encontrado');
    const { cc, national } = splitE164(inv.phoneE164);

    let metaPhoneId: string;
    try {
      ({ id: metaPhoneId } = await this.meta
        .withToken(waba.token, waba.appSecret)
        .addPhoneNumber(waba.metaWabaId, {
          cc,
          phoneNumber: national,
          verifiedName: input.verifiedName,
        }));
    } catch (err) {
      throw metaWriteError(err);
    }

    await withTenant(this.handle.db, tenantId, async (tx) => {
      const [phone] = await tx
        .insert(phoneNumbers)
        .values({
          tenantId,
          wabaId: waba.id,
          metaPhoneNumberId: metaPhoneId,
          phoneE164: inv.phoneE164,
          verifiedName: input.verifiedName,
          status: 'pending',
          inventoryId,
          registrationStatus: 'added',
        })
        .onConflictDoUpdate({
          target: phoneNumbers.metaPhoneNumberId,
          set: { inventoryId, registrationStatus: 'added', updatedAt: new Date() },
        })
        .returning({ id: phoneNumbers.id });
      if (!phone) throw new Error('falha ao gravar número');
      await tx
        .update(numberAssignments)
        .set({ phoneNumberId: phone.id })
        .where(eq(numberAssignments.id, assignmentId));
      await tx
        .insert(metaAssetRoutes)
        .values({ metaId: metaPhoneId, assetType: 'phone_number', tenantId })
        .onConflictDoNothing();
      await this.audit.record(
        ctx,
        {
          action: 'number.add_to_waba',
          entityType: 'phone_number',
          entityId: phone.id,
          tenantId,
          after: { metaPhoneNumberId: metaPhoneId, phone: maskPhone(inv.phoneE164) },
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ verificação e registro

  /** Passo 2: solicita o código (SMS ou voz) para o número. */
  async requestCode(
    tenantId: string,
    phoneId: string,
    input: { method: 'SMS' | 'VOICE'; language: string },
    ctx: RequestContext,
  ) {
    const p = await this.phoneWithToken(tenantId, phoneId);
    this.assertStep(p.registrationStatus, ['added', 'code_requested']);
    try {
      await this.meta.withToken(p.token, p.appSecret).requestCode(p.metaPhoneNumberId, input);
    } catch (err) {
      // §10.2: 136024 = número já verificado → pula direto para o registro
      if (err instanceof MetaApiError && err.code === 136024) {
        await this.setStep(tenantId, phoneId, 'code_verified', ctx, 'number.already_verified', {});
        return this.tenantNumber(tenantId);
      }
      await this.callMeta(tenantId, phoneId, () => Promise.reject(err));
    }
    await this.setStep(tenantId, phoneId, 'code_requested', ctx, 'number.request_code', {
      method: input.method,
    });
    return this.tenantNumber(tenantId);
  }

  /** Passo 3: confirma o código recebido (fallback manual do FR-NUM-04). */
  async verifyCode(tenantId: string, phoneId: string, code: string, ctx: RequestContext) {
    const p = await this.phoneWithToken(tenantId, phoneId);
    this.assertStep(p.registrationStatus, ['code_requested']);
    await this.callMeta(tenantId, phoneId, () =>
      this.meta.withToken(p.token, p.appSecret).verifyCode(p.metaPhoneNumberId, code),
    );
    await this.setStep(tenantId, phoneId, 'code_verified', ctx, 'number.verify_code', {});
    return this.tenantNumber(tenantId);
  }

  /**
   * Passo 4: registra o número na Cloud API com o PIN da verificação em duas etapas. O PIN é
   * gerado aqui (6 dígitos), guardado cifrado e nunca devolvido.
   */
  async register(tenantId: string, phoneId: string, ctx: RequestContext) {
    const p = await this.phoneWithToken(tenantId, phoneId);
    // 'registered': re-registro após aprovação de nome (§10.4)
    this.assertStep(p.registrationStatus, ['code_verified', 'deregistered', 'registered']);
    const pin = p.pinEnc
      ? await decryptSecret(p.pinEnc, this.keys)
      : String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!p.pinEnc) {
      const pinEnc = await encryptSecret(pin, this.keys);
      await withTenant(this.handle.db, tenantId, (tx) =>
        tx
          .update(phoneNumbers)
          .set({ twoStepPinEnc: pinEnc, pinKeyId: this.keys.keyId })
          .where(eq(phoneNumbers.id, phoneId)),
      );
    }
    await this.callMeta(tenantId, phoneId, () =>
      this.meta.withToken(p.token, p.appSecret).registerPhone(p.metaPhoneNumberId, pin),
    );
    await withTenant(this.handle.db, tenantId, async (tx) => {
      await tx
        .update(phoneNumbers)
        .set({
          registrationStatus: 'registered',
          registrationError: null,
          registeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(phoneNumbers.id, phoneId));
      const [phone] = await tx
        .select({ inventoryId: phoneNumbers.inventoryId })
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, phoneId));
      if (phone?.inventoryId) {
        await tx
          .update(numberInventory)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(numberInventory.id, phone.inventoryId));
      }
      await this.audit.record(
        ctx,
        { action: 'number.register', entityType: 'phone_number', entityId: phoneId, tenantId },
        tx,
      );
    });
    return this.tenantNumber(tenantId);
  }

  // ------------------------------------------------------------------ liberação (offboarding)

  /**
   * Libera o número do cliente: desregistra na Meta (melhor esforço), encerra a atribuição e
   * põe o número em quarentena (FR-NUM-05). Não existe "mover" número entre clientes ativos.
   */
  async release(tenantId: string, reason: string, ctx: RequestContext) {
    await this.requireTenant(tenantId);
    const current = await withTenant(this.handle.db, tenantId, async (tx) => {
      const [a] = await tx
        .select()
        .from(numberAssignments)
        .where(isNull(numberAssignments.releasedAt))
        .limit(1);
      return a;
    });
    if (!current) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'no_assignment',
        'O cliente não tem número atribuído',
      );
    }

    let deregisterError: string | null = null;
    if (current.phoneNumberId) {
      const p = await this.phoneWithToken(tenantId, current.phoneNumberId);
      if (p.registrationStatus === 'registered') {
        try {
          await this.meta.withToken(p.token, p.appSecret).deregisterPhone(p.metaPhoneNumberId);
        } catch (err) {
          deregisterError = metaWriteError(err).message;
        }
      }
    }

    const until = new Date(Date.now() + this.config.NUMBER_QUARANTINE_DAYS * 86_400_000);
    await this.handle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await tx
        .update(numberAssignments)
        .set({ releasedAt: new Date(), releaseReason: reason })
        .where(eq(numberAssignments.id, current.id));
      if (current.phoneNumberId) {
        await tx
          .update(phoneNumbers)
          .set({
            status: 'disconnected',
            registrationStatus: deregisterError ? undefined : 'deregistered',
            registrationError: deregisterError,
            updatedAt: new Date(),
          })
          .where(eq(phoneNumbers.id, current.phoneNumberId));
      }
      await tx
        .update(numberInventory)
        .set({ status: 'quarantine', quarantineUntil: until, updatedAt: new Date() })
        .where(eq(numberInventory.id, current.inventoryId));
      await this.audit.record(
        ctx,
        {
          action: 'number.release',
          entityType: 'number_assignment',
          entityId: current.id,
          tenantId,
          after: { reason, quarantineUntil: until.toISOString(), deregisterError },
        },
        tx,
      );
    });
    return { released: true, quarantineUntil: until, deregisterError };
  }

  // ------------------------------------------------------------------ apoio

  private async currentView(tx: Tx) {
    const [a] = await tx
      .select({
        assignmentId: numberAssignments.id,
        inventoryId: numberAssignments.inventoryId,
        assignedAt: numberAssignments.assignedAt,
        phoneNumberId: numberAssignments.phoneNumberId,
      })
      .from(numberAssignments)
      .where(isNull(numberAssignments.releasedAt))
      .limit(1);
    if (!a) return { assignment: null, phoneNumber: null };
    const [inv] = await tx
      .select({ phoneE164: numberInventory.phoneE164, status: numberInventory.status })
      .from(numberInventory)
      .where(eq(numberInventory.id, a.inventoryId));
    const phone = a.phoneNumberId
      ? (
          await tx
            .select({
              id: phoneNumbers.id,
              metaPhoneNumberId: phoneNumbers.metaPhoneNumberId,
              phoneE164: phoneNumbers.phoneE164,
              verifiedName: phoneNumbers.verifiedName,
              status: phoneNumbers.status,
              registrationStatus: phoneNumbers.registrationStatus,
              registrationError: phoneNumbers.registrationError,
              registeredAt: phoneNumbers.registeredAt,
            })
            .from(phoneNumbers)
            .where(eq(phoneNumbers.id, a.phoneNumberId))
        )[0]
      : undefined;
    return {
      assignment: { ...a, phoneE164: inv?.phoneE164 ?? null, inventoryStatus: inv?.status ?? null },
      phoneNumber: phone ?? null,
    };
  }

  private async callMeta(tenantId: string, phoneId: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      const appErr = metaWriteError(err);
      await withTenant(this.handle.db, tenantId, (tx) =>
        tx
          .update(phoneNumbers)
          .set({ registrationError: appErr.message.slice(0, 500), updatedAt: new Date() })
          .where(eq(phoneNumbers.id, phoneId)),
      );
      throw appErr;
    }
  }

  private async setStep(
    tenantId: string,
    phoneId: string,
    step: 'code_requested' | 'code_verified',
    ctx: RequestContext,
    action: string,
    after: Record<string, unknown>,
  ) {
    await withTenant(this.handle.db, tenantId, async (tx) => {
      await tx
        .update(phoneNumbers)
        .set({ registrationStatus: step, registrationError: null, updatedAt: new Date() })
        .where(eq(phoneNumbers.id, phoneId));
      await this.audit.record(
        ctx,
        { action, entityType: 'phone_number', entityId: phoneId, tenantId, after },
        tx,
      );
    });
  }

  private assertStep(current: string | null, allowed: string[]) {
    if (!current || !allowed.includes(current)) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'invalid_registration_step',
        `Passo inválido para o estado atual do registro (${current ?? 'sem registro pela plataforma'})`,
        { current, allowed },
      );
    }
  }

  private async phoneWithToken(tenantId: string, phoneId: string) {
    const row = await withTenant(this.handle.db, tenantId, async (tx) => {
      const [r] = await tx
        .select({
          metaPhoneNumberId: phoneNumbers.metaPhoneNumberId,
          registrationStatus: phoneNumbers.registrationStatus,
          pinEnc: phoneNumbers.twoStepPinEnc,
          tokenEnc: metaConnections.accessTokenEnc,
          appSecretEnc: metaConnections.appSecretEnc,
          connStatus: metaConnections.status,
        })
        .from(phoneNumbers)
        .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, phoneNumbers.wabaId))
        .innerJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
        .where(eq(phoneNumbers.id, phoneId));
      return r;
    });
    if (!row) throw new NotFoundException('Número não encontrado');
    this.assertConnection(row.connStatus);
    return {
      ...row,
      token: await decryptSecret(row.tokenEnc, this.keys),
      appSecret: row.appSecretEnc ? await decryptSecret(row.appSecretEnc, this.keys) : undefined,
    };
  }

  private async wabaWithToken(tx: Tx, wabaId: string) {
    const [w] = await tx
      .select({
        id: whatsappAccounts.id,
        metaWabaId: whatsappAccounts.metaWabaId,
        tokenEnc: metaConnections.accessTokenEnc,
        appSecretEnc: metaConnections.appSecretEnc,
        connStatus: metaConnections.status,
      })
      .from(whatsappAccounts)
      .innerJoin(metaConnections, eq(metaConnections.id, whatsappAccounts.connectionId))
      .where(eq(whatsappAccounts.id, wabaId));
    if (!w) throw new NotFoundException('WABA não encontrada para este cliente');
    this.assertConnection(w.connStatus);
    return {
      id: w.id,
      metaWabaId: w.metaWabaId,
      token: await decryptSecret(w.tokenEnc, this.keys),
      appSecret: w.appSecretEnc ? await decryptSecret(w.appSecretEnc, this.keys) : undefined,
    };
  }

  private assertConnection(status: string) {
    if (status !== 'active') {
      throw new AppError(
        HttpStatus.CONFLICT,
        'meta_connection_broken',
        'A conexão com a Meta deste cliente não está ativa; reconecte os ativos',
      );
    }
  }

  private async requireTenant(tenantId: string) {
    const [t] = await this.handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw new NotFoundException('Cliente não encontrado');
  }
}
