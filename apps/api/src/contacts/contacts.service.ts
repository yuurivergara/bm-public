import {
  contactListMembers,
  contactLists,
  contacts,
  type DbHandle,
  orm,
  type SuppressionReason,
  suppressions,
  tenants,
  withTenant,
} from '@bm/db';
import { hashPhone, maskPhone, normalizePhone } from '@bm/shared';
import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppError } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../core/audit.service';
import { DB } from '../core/tokens';

const { and, asc, count, desc, eq, gt, sql } = orm;

/** Listas, membros e supressão (FR-CON-05/06). Telefones sempre mascarados nas respostas. */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async lists(tenantId: string) {
    await this.requireTenant(tenantId);
    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select().from(contactLists).orderBy(desc(contactLists.createdAt)).limit(200),
    );
    return { data: rows.map(({ tenantId: _t, ...r }) => r) };
  }

  async list(tenantId: string, listId: string) {
    await this.requireTenant(tenantId);
    const [row] = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select().from(contactLists).where(eq(contactLists.id, listId)),
    );
    if (!row) throw new NotFoundException('Lista não encontrada');
    const { tenantId: _t, ...rest } = row;
    return rest;
  }

  /** Membros paginados por cursor (id do contato). */
  async members(tenantId: string, listId: string, after: string | undefined, limit: number) {
    await this.list(tenantId, listId);
    const rows = await withTenant(this.handle.db, tenantId, (tx) =>
      tx
        .select({
          id: contacts.id,
          phone: contacts.phoneE164,
          name: contacts.name,
          attributes: contacts.attributes,
          invalidAt: contacts.invalidAt,
        })
        .from(contactListMembers)
        .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
        .where(
          and(eq(contactListMembers.listId, listId), after ? gt(contacts.id, after) : undefined),
        )
        .orderBy(asc(contacts.id))
        .limit(limit),
    );
    return {
      data: rows.map(({ phone, ...r }) => ({ ...r, phoneMasked: maskPhone(phone) })),
      next: rows.length === limit ? rows[rows.length - 1]?.id : null,
    };
  }

  async suppressionList(tenantId: string, limit: number) {
    await this.requireTenant(tenantId);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const [total] = await tx.select({ n: count() }).from(suppressions);
      const rows = await tx
        .select({
          phoneMasked: suppressions.phoneMasked,
          reason: suppressions.reason,
          createdAt: suppressions.createdAt,
        })
        .from(suppressions)
        .orderBy(desc(suppressions.createdAt))
        .limit(limit);
      return { total: total?.n ?? 0, data: rows };
    });
  }

  /**
   * Suprime um telefone para sempre neste cliente (FR-CON-06) e o tira das listas existentes.
   * Idempotente: suprimir de novo devolve o registro original.
   */
  async suppress(
    tenantId: string,
    input: { phone: string; reason: Extract<SuppressionReason, 'manual' | 'complaint'> },
    ctx: RequestContext,
  ) {
    await this.requireTenant(tenantId);
    const n = normalizePhone(input.phone);
    if (!n.ok) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_phone', 'Telefone inválido', {
        reason: n.reason,
      });
    }
    const phoneHash = hashPhone(n.e164, this.config.PHONE_HASH_PEPPER, tenantId);
    const phoneMasked = maskPhone(n.e164);
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const inserted = await tx
        .insert(suppressions)
        .values({
          tenantId,
          phoneHash,
          phoneMasked,
          reason: input.reason,
          createdBy: ctx.userId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      // Remove das listas e corrige os tamanhos
      const removed = await tx.execute<{ list_id: string }>(sql`
        delete from contact_list_members m using contacts c
         where m.contact_id = c.id and c.phone_hash = ${phoneHash}
        returning m.list_id`);
      const lists = [...new Set([...removed].map((r) => r.list_id))];
      for (const listId of lists) {
        await tx.execute(sql`
          update contact_lists set size = (select count(*) from contact_list_members where list_id = ${listId})
           where id = ${listId}`);
      }
      if (inserted.length) {
        await this.audit.record(
          ctx,
          {
            action: 'suppression.create',
            entityType: 'suppression',
            tenantId,
            after: { phone: phoneMasked, reason: input.reason, removedFromLists: lists.length },
          },
          tx,
        );
      }
      const [row] = inserted.length
        ? inserted
        : await tx.select().from(suppressions).where(eq(suppressions.phoneHash, phoneHash));
      return {
        phoneMasked: row?.phoneMasked,
        reason: row?.reason,
        createdAt: row?.createdAt,
        created: inserted.length > 0,
        removedFromLists: lists.length,
      };
    });
  }

  private async requireTenant(tenantId: string) {
    const [t] = await this.handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw new NotFoundException('Cliente não encontrado');
  }
}
