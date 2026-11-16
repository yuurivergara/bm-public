import {
  type DbHandle,
  orm,
  setTenantContext,
  tenantSettings,
  tenants,
  type WavePolicy,
  withTenant,
} from '@bm/db';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { AuditService } from '../core/audit.service';
import { DB } from '../core/tokens';

const { and, desc, eq, ilike, lt, or } = orm;

export type TenantStatus = (typeof tenants.status.enumValues)[number];

export const DEFAULT_WAVE_POLICY: WavePolicy = {
  firstPct: 5,
  min: 20,
  max: 200,
  growth: 2,
  gateMinutes: 15,
};

export interface TenantInput {
  name: string;
  legalName?: string | null;
  cnpj?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
}

export interface SettingsInput {
  monthlyCostCapUsd?: number | null;
  capacitySafetyPct?: number;
  wavePolicy?: WavePolicy;
  maxMsgsPerContact24h?: number;
  contactButtonUrl?: string | null;
}

export interface ListQuery {
  status?: TenantStatus;
  q?: string;
  cursor?: string;
  limit: number;
}

/** Transições de status permitidas nesta fase (offboarding completo entra com o Number Inventory). */
const TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  onboarding: ['active', 'paused'],
  active: ['paused'],
  paused: ['active'],
  offboarded: [],
};

function encodeCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_cursor', 'Cursor inválido');
  }
  return { createdAt, id };
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListQuery) {
    const filters = [];
    if (query.status) filters.push(eq(tenants.status, query.status));
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
      filters.push(
        or(ilike(tenants.name, like), ilike(tenants.legalName, like), eq(tenants.cnpj, query.q)),
      );
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      filters.push(
        or(
          lt(tenants.createdAt, c.createdAt),
          and(eq(tenants.createdAt, c.createdAt), lt(tenants.id, c.id)),
        ),
      );
    }
    const rows = await this.handle.db
      .select()
      .from(tenants)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(tenants.createdAt), desc(tenants.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(id: string) {
    const [tenant] = await this.handle.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant) throw new NotFoundException('Cliente não encontrado');
    const [settings] = await withTenant(this.handle.db, id, (tx) =>
      tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, id)).limit(1),
    );
    return { ...tenant, settings: settings ?? null };
  }

  async create(input: TenantInput, ctx: RequestContext) {
    return this.handle.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values(input)
        .onConflictDoNothing({ target: tenants.cnpj })
        .returning();
      if (!tenant) throw new AppError(HttpStatus.CONFLICT, 'cnpj_taken', 'CNPJ já cadastrado');
      await setTenantContext(tx, tenant.id);
      const [settings] = await tx
        .insert(tenantSettings)
        .values({ tenantId: tenant.id, wavePolicy: DEFAULT_WAVE_POLICY })
        .returning();
      await this.audit.record(
        ctx,
        {
          action: 'tenant.create',
          entityType: 'tenant',
          entityId: tenant.id,
          tenantId: tenant.id,
          after: tenant,
        },
        tx,
      );
      return { ...tenant, settings };
    });
  }

  async update(id: string, patch: Partial<TenantInput>, ctx: RequestContext) {
    return this.handle.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, id))
        .limit(1)
        .for('update');
      if (!before) throw new NotFoundException('Cliente não encontrado');
      if (patch.cnpj && patch.cnpj !== before.cnpj) {
        const [dup] = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.cnpj, patch.cnpj));
        if (dup) throw new AppError(HttpStatus.CONFLICT, 'cnpj_taken', 'CNPJ já cadastrado');
      }
      const [after] = await tx
        .update(tenants)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(tenants.id, id))
        .returning();
      await this.audit.record(
        ctx,
        {
          action: 'tenant.update',
          entityType: 'tenant',
          entityId: id,
          tenantId: id,
          before,
          after,
        },
        tx,
      );
      return after;
    });
  }

  async changeStatus(id: string, status: TenantStatus, ctx: RequestContext) {
    return this.handle.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, id))
        .limit(1)
        .for('update');
      if (!before) throw new NotFoundException('Cliente não encontrado');
      if (!TRANSITIONS[before.status].includes(status)) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'invalid_transition',
          `Transição ${before.status} → ${status} não permitida`,
        );
      }
      const [after] = await tx
        .update(tenants)
        .set({ status, updatedAt: new Date() })
        .where(eq(tenants.id, id))
        .returning();
      await this.audit.record(
        ctx,
        {
          action: `tenant.status.${status}`,
          entityType: 'tenant',
          entityId: id,
          tenantId: id,
          before,
          after,
        },
        tx,
      );
      return after;
    });
  }

  async updateSettings(id: string, patch: SettingsInput, ctx: RequestContext) {
    return withTenant(this.handle.db, id, async (tx) => {
      const [before] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, id))
        .limit(1)
        .for('update');
      if (!before) throw new NotFoundException('Cliente não encontrado');
      const { monthlyCostCapUsd, ...rest } = patch;
      const [after] = await tx
        .update(tenantSettings)
        .set({
          ...rest,
          ...(monthlyCostCapUsd !== undefined
            ? {
                monthlyCostCapUsd: monthlyCostCapUsd === null ? null : monthlyCostCapUsd.toFixed(2),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenantSettings.tenantId, id))
        .returning();
      await this.audit.record(
        ctx,
        {
          action: 'tenant.settings.update',
          entityType: 'tenant_settings',
          entityId: id,
          tenantId: id,
          before,
          after,
        },
        tx,
      );
      return after;
    });
  }
}
