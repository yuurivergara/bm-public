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
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
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

// ---------------------------------------------------------------------------
// Ativos Meta (0002)
// ---------------------------------------------------------------------------
export const connectionStatus = pgEnum('connection_status', ['active', 'broken', 'revoked']);
export const onboardingMethod = pgEnum('onboarding_method', [
  'embedded_signup',
  'partner_share',
  'manual',
]);

export const metaConnections = pgTable('meta_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'system_user' | 'business_integration'>().notNull(),
  method: onboardingMethod('method').notNull(),
  accessTokenEnc: bytea('access_token_enc').notNull(),
  keyId: text('key_id').notNull(),
  tokenLast4: text('token_last4').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  expiresAt: ts('expires_at'),
  status: connectionStatus('status').notNull().default('active'),
  lastValidatedAt: ts('last_validated_at'),
  lastError: jsonb('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const businessPortfolios = pgTable('business_portfolios', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  metaBusinessId: text('meta_business_id').notNull().unique(),
  name: text('name'),
  verificationStatus: text('verification_status'),
  messagingLimitTier: text('messaging_limit_tier'),
  messagingLimitValue: integer('messaging_limit_value'),
  limitSyncedAt: ts('limit_synced_at'),
  metaRaw: jsonb('meta_raw'),
  syncedAt: ts('synced_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type WabaStatus = 'active' | 'restricted' | 'disabled';

export const whatsappAccounts = pgTable('whatsapp_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  portfolioId: uuid('portfolio_id')
    .notNull()
    .references(() => businessPortfolios.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => metaConnections.id, {
    onDelete: 'set null',
  }),
  metaWabaId: text('meta_waba_id').notNull().unique(),
  name: text('name'),
  currency: text('currency'),
  timezoneId: text('timezone_id'),
  accountReviewStatus: text('account_review_status'),
  paymentStatus: text('payment_status'),
  webhooksSubscribed: boolean('webhooks_subscribed').notNull().default(false),
  status: text('status').$type<WabaStatus>().notNull().default('active'),
  restrictionInfo: jsonb('restriction_info'),
  metaRaw: jsonb('meta_raw'),
  syncedAt: ts('synced_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type PhoneStatus = 'pending' | 'connected' | 'flagged' | 'restricted' | 'disconnected';

export const phoneNumbers = pgTable('phone_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  wabaId: uuid('waba_id')
    .notNull()
    .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
  metaPhoneNumberId: text('meta_phone_number_id').notNull().unique(),
  phoneE164: text('phone_e164').notNull(),
  displayPhoneNumber: text('display_phone_number'),
  verifiedName: text('verified_name'),
  nameStatus: text('name_status'),
  qualityRating: text('quality_rating'),
  messagingLimitTier: text('messaging_limit_tier'),
  throughputLevel: text('throughput_level'),
  codeVerificationStatus: text('code_verification_status'),
  metaStatus: text('meta_status'),
  status: text('status').$type<PhoneStatus>().notNull().default('pending'),
  metaRaw: jsonb('meta_raw'),
  registeredAt: ts('registered_at'),
  syncedAt: ts('synced_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  inventoryId: uuid('inventory_id').references(() => numberInventory.id),
  registrationStatus: text('registration_status').$type<RegistrationStatus>(),
  registrationError: text('registration_error'),
  twoStepPinEnc: bytea('two_step_pin_enc'),
  pinKeyId: text('pin_key_id'),
});

export type RegistrationStatus =
  | 'added'
  | 'code_requested'
  | 'code_verified'
  | 'registered'
  | 'deregistered';

export type HealthEntity = 'portfolio' | 'waba' | 'phone_number' | 'template';

export const accountHealth = pgTable('account_health', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').$type<HealthEntity>().notNull(),
  entityId: uuid('entity_id').notNull(),
  qualityRating: text('quality_rating'),
  status: text('status'),
  source: text('source').$type<'webhook' | 'sync'>().notNull(),
  signal: jsonb('signal').notNull(),
  observedAt: ts('observed_at').notNull().defaultNow(),
});

export type MetaAssetType = 'business' | 'waba' | 'phone_number';

export const metaAssetRoutes = pgTable('meta_asset_routes', {
  metaId: text('meta_id').primaryKey(),
  assetType: text('asset_type').$type<MetaAssetType>().notNull(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type WebhookEventStatus =
  | 'queued'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored'
  | 'dead';

export const webhookEvents = pgTable('webhook_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  source: text('source').$type<'meta' | 'number_provider'>().notNull(),
  object: text('object'),
  field: text('field'),
  entryId: text('entry_id'),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').$type<WebhookEventStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  error: text('error'),
});

// ---------------------------------------------------------------- S3: números e templates

export type NumberProviderKind = 'manual' | 'sms_webhook' | 'voice_transcription';
export type InventoryStatus = 'available' | 'verifying' | 'active' | 'quarantine' | 'cancelled';

export const numberProviders = pgTable('number_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  apiKind: text('api_kind').$type<NumberProviderKind>().notNull(),
  configEnc: bytea('config_enc'),
  keyId: text('key_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const numberInventory = pgTable('number_inventory', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => numberProviders.id),
  phoneE164: text('phone_e164').notNull().unique(),
  monthlyCostBrl: numeric('monthly_cost_brl', { precision: 10, scale: 2 }).notNull().default('0'),
  status: text('status').$type<InventoryStatus>().notNull().default('available'),
  quarantineUntil: ts('quarantine_until'),
  notes: text('notes'),
  acquiredAt: ts('acquired_at').notNull().defaultNow(),
  cancelledAt: ts('cancelled_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const numberAssignments = pgTable('number_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  inventoryId: uuid('inventory_id')
    .notNull()
    .references(() => numberInventory.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id, {
    onDelete: 'set null',
  }),
  assignedBy: uuid('assigned_by').references(() => users.id),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
  releasedAt: ts('released_at'),
  releaseReason: text('release_reason'),
});

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    wabaId: uuid('waba_id')
      .notNull()
      .references(() => whatsappAccounts.id, { onDelete: 'cascade' }),
    metaTemplateId: text('meta_template_id').unique(),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category'),
    submittedCategory: text('submitted_category'),
    previousCategory: text('previous_category'),
    parameterFormat: text('parameter_format'),
    status: text('status').notNull().default('PENDING'),
    qualityScore: text('quality_score'),
    rejectionReason: text('rejection_reason'),
    components: jsonb('components').notNull(),
    metaRaw: jsonb('meta_raw'),
    lastStatusAt: ts('last_status_at'),
    syncedAt: ts('synced_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('message_templates_waba_id_name_language_key').on(t.wabaId, t.name, t.language)],
);

// ---------------------------------------------------------------------------- S4 contatos

export type ImportStatus =
  | 'uploaded'
  | 'parsing'
  | 'preview'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export interface ImportMapping {
  /** Coluna do telefone: nome do cabeçalho ou índice (1 = primeira). */
  phone: string | number;
  name?: string | number;
  /** Variável do template → coluna. */
  attributes?: Record<string, string | number>;
  hasHeader: boolean;
  delimiter?: string;
}

export const contactImports = pgTable('contact_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  originalFilename: text('original_filename').notNull(),
  fileFormat: text('file_format').$type<'csv' | 'txt' | 'xlsx'>().notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  fileSha256: bytea('file_sha256').notNull(),
  status: text('status').$type<ImportStatus>().notNull().default('uploaded'),
  mapping: jsonb('mapping').$type<ImportMapping>().notNull(),
  listName: text('list_name').notNull(),
  rowCount: integer('row_count'),
  validCount: integer('valid_count'),
  invalidCount: integer('invalid_count'),
  duplicateCount: integer('duplicate_count'),
  suppressedCount: integer('suppressed_count'),
  existingCount: integer('existing_count'),
  errorSample: jsonb('error_sample').$type<{ row: number; reason: string }[]>(),
  error: text('error'),
  originDeclaration: text('origin_declaration').notNull(),
  legalBasis: text('legal_basis').notNull(),
  declarationNotes: text('declaration_notes'),
  declaredBy: uuid('declared_by')
    .notNull()
    .references(() => users.id),
  declaredAt: ts('declared_at').notNull(),
  listId: uuid('list_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

/** Fila do processador de importações (sem RLS: só IDs; ver migration 0004). */
export const contactImportJobs = pgTable('contact_import_jobs', {
  importId: uuid('import_id')
    .primaryKey()
    .references(() => contactImports.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'parse' | 'confirm'>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableAt: ts('available_at').notNull().defaultNow(),
  leaseUntil: ts('lease_until'),
  lastError: text('last_error'),
});

export const contactImportRows = pgTable(
  'contact_import_rows',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => contactImports.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    rowNo: integer('row_no').notNull(),
    phoneE164: text('phone_e164'),
    phoneHash: bytea('phone_hash'),
    name: text('name'),
    attributes: jsonb('attributes').notNull().default({}),
    status: text('status').$type<'valid' | 'invalid' | 'duplicate' | 'suppressed'>().notNull(),
    reason: text('reason'),
  },
  (t) => [primaryKey({ columns: [t.importId, t.rowNo] })],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phoneE164: text('phone_e164').notNull(),
    phoneHash: bytea('phone_hash').notNull(),
    name: text('name'),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    firstImportId: uuid('first_import_id').references(() => contactImports.id, {
      onDelete: 'set null',
    }),
    invalidAt: ts('invalid_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('contacts_tenant_id_phone_e164_key').on(t.tenantId, t.phoneE164)],
);

export const contactLists = pgTable('contact_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  importId: uuid('import_id')
    .unique()
    .references(() => contactImports.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  size: integer('size').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const contactListMembers = pgTable(
  'contact_list_members',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => contactLists.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.contactId] })],
);

export const consentRecords = pgTable('consent_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  basis: text('basis').notNull(),
  source: text('source').$type<'import_declaration' | 'opt_in_reply' | 'manual'>().notNull(),
  importId: uuid('import_id').references(() => contactImports.id, { onDelete: 'set null' }),
  evidence: jsonb('evidence'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
});

export type SuppressionReason =
  | 'opt_out_keyword'
  | 'opt_out_button'
  | 'manual'
  | 'complaint'
  | 'invalid';

export const suppressions = pgTable(
  'suppressions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    phoneHash: bytea('phone_hash').notNull(),
    phoneMasked: text('phone_masked').notNull(),
    reason: text('reason').$type<SuppressionReason>().notNull(),
    sourceMessageId: uuid('source_message_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.phoneHash] })],
);

export const schema = {
  users,
  userSessions,
  loginChallenges,
  tenants,
  tenantSettings,
  auditLogs,
  metaConnections,
  businessPortfolios,
  whatsappAccounts,
  phoneNumbers,
  accountHealth,
  metaAssetRoutes,
  webhookEvents,
  numberProviders,
  numberInventory,
  numberAssignments,
  messageTemplates,
  contactImports,
  contactImportJobs,
  contactImportRows,
  contacts,
  contactLists,
  contactListMembers,
  consentRecords,
  suppressions,
};
