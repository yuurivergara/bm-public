/** Formatos das respostas da API (apps/api). Datas chegam como string ISO. */
import type { Permission, Role } from '@bm/shared';

export type { Permission, Role };

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt?: string | null;
}

export interface Me {
  user: User;
  permissions: Permission[];
}

export interface LoginResponse {
  challengeToken: string;
  totpEnrolled: boolean;
  otpauthUri?: string;
}

export type TenantStatus = 'onboarding' | 'active' | 'paused' | 'offboarded';

export interface Tenant {
  id: string;
  name: string;
  legalName: string | null;
  cnpj: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  status: TenantStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  data: T[];
  nextCursor?: string | null;
}

// ------------------------------------------------------------------ ativos Meta

export interface PhoneNumber {
  id: string;
  wabaId: string;
  metaPhoneNumberId: string;
  phoneE164: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  throughputLevel: string | null;
  status: 'pending' | 'connected' | 'flagged' | 'restricted' | 'disconnected';
  registrationStatus: string | null;
}

export interface Waba {
  id: string;
  metaWabaId: string;
  name: string | null;
  accountReviewStatus: string | null;
  webhooksSubscribed: boolean;
  status: string;
  phoneNumbers: PhoneNumber[];
}

export interface Portfolio {
  id: string;
  metaBusinessId: string;
  name: string | null;
  verificationStatus: string | null;
  messagingLimitTier: string | null;
  messagingLimitValue: number | null;
  wabas: Waba[];
}

export interface Connection {
  id: string;
  method: string;
  tokenLast4: string;
  /** app próprio do cliente (App Secret guardado) */
  ownApp?: boolean;
  metaAppId?: string | null;
  status: 'active' | 'broken' | 'revoked';
  lastValidatedAt: string | null;
  createdAt: string;
}

export interface Assets {
  connections: Connection[];
  portfolios: Portfolio[];
  syncErrors?: { wabaId: string; code: string; message: string }[];
}

// ------------------------------------------------------------------ templates

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: { type: string; text: string }[];
  example?: unknown;
}

export interface Template {
  id: string;
  wabaId: string;
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  qualityScore: string | null;
  rejectionReason: string | null;
  components: TemplateComponent[];
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ contatos

export type ImportStatus =
  | 'uploaded'
  | 'parsing'
  | 'preview'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export interface ContactImport {
  id: string;
  originalFilename: string;
  fileFormat: 'csv' | 'txt' | 'xlsx';
  status: ImportStatus;
  listName: string;
  rowCount: number | null;
  validCount: number | null;
  invalidCount: number | null;
  duplicateCount: number | null;
  suppressedCount: number | null;
  existingCount: number | null;
  errorSample: { row: number; reason: string }[] | null;
  error: string | null;
  listId: string | null;
  columns?: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface ContactList {
  id: string;
  importId: string | null;
  name: string;
  size: number;
  createdAt: string;
}

export interface ListMember {
  id: string;
  phoneMasked: string;
  name: string | null;
  attributes: Record<string, string>;
  invalidAt: string | null;
}

export interface Suppression {
  phoneMasked: string;
  reason: string;
  createdAt: string;
}

// ------------------------------------------------------------------ números

export interface NumberProvider {
  id: string;
  name: string;
  apiKind: string;
  createdAt: string;
}

export type InventoryStatus = 'available' | 'verifying' | 'active' | 'quarantine' | 'cancelled';

export interface InventoryNumber {
  id: string;
  providerId: string;
  phoneE164: string;
  monthlyCostBrl: number;
  status: InventoryStatus;
  quarantineUntil: string | null;
  notes: string | null;
  acquiredAt: string;
}

export interface TenantNumber {
  assignment: {
    assignmentId: string;
    inventoryId: string;
    assignedAt: string;
    phoneNumberId: string | null;
    phoneE164: string | null;
    inventoryStatus: string | null;
  } | null;
  phoneNumber: {
    id: string;
    metaPhoneNumberId: string;
    phoneE164: string;
    verifiedName: string | null;
    status: string;
    registrationStatus: string | null;
    registrationError: string | null;
    registeredAt: string | null;
  } | null;
}

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  totpEnrolledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ disparos (contrato do S5)

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export type VariableSource = 'name' | 'attribute' | 'fixed';

export interface VariableBinding {
  source: VariableSource;
  value?: string;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  uncertain: number;
  cancelled: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  pauseReason?: string | null;
  listId: string;
  listName: string;
  templateId: string;
  templateName: string;
  language: string;
  phoneNumberId: string;
  displayPhone: string;
  variables: Record<string, VariableBinding>;
  counts: CampaignCounts;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type RecipientStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'skipped'
  | 'uncertain'
  | 'cancelled';

export interface Recipient {
  id: string;
  phoneMasked: string;
  name: string | null;
  status: RecipientStatus;
  errorCode: string | number | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface Capacity {
  /** null = limite ilimitado na Meta */
  limit: number | null;
  used24h: number;
  available: number | null;
  phoneNumbers: {
    id: string;
    displayPhone: string;
    qualityRating: string | null;
    throughput: string | number | null;
  }[];
}
