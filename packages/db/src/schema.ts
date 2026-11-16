import {
  bigint,
  boolean,
  customType,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema tipado (Drizzle) espelhando as migrations SQL em /migrations.
 * As migrations são a fonte da verdade; o teste de drift (schema.test.ts) garante que
 * colunas daqui existam no banco com os mesmos nomes.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const userRole = pgEnum('user_role', ['owner', 'operator', 'viewer']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const tenantStatus = pgEnum('tenant_status', [
  'onboarding',
  'active',
  'paused',
  'offboarded',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: bytea('totp_secret_enc').notNull(),
  totpEnrolledAt: ts('totp_enrolled_at'),
  totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
  role: userRole('role').notNull().default('operator'),
  status: userStatus('status').notNull().default('active'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  idleExpiresAt: ts('idle_expires_at').notNull(),
  absoluteExpiresAt: ts('absolute_expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const loginChallenges = pgTable('login_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  cnpj: text('cnpj'),
  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),
  contactEmail: citext('contact_email'),
  status: tenantStatus('status').notNull().default('onboarding'),
  notes: text('notes'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  offboardedAt: ts('offboarded_at'),
});

export interface WavePolicy {
  firstPct: number;
  min: number;
  max: number;
  growth: number;
  gateMinutes: number;
}

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  monthlyCostCapUsd: numeric('monthly_cost_cap_usd', { precision: 12, scale: 2 }),
  capacitySafetyPct: smallint('capacity_safety_pct').notNull().default(90),
  wavePolicy: jsonb('wave_policy').$type<WavePolicy>().notNull(),
  maxMsgsPerContact24h: smallint('max_msgs_per_contact_24h').notNull().default(1),
  contactButtonUrl: text('contact_button_url'),
  autoReplyEnabled: boolean('auto_reply_enabled').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
  userId: uuid('user_id'),
  tenantId: uuid('tenant_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const schema = {
  users,
  userSessions,
  loginChallenges,
  tenants,
  tenantSettings,
  auditLogs,
};
