/** Consultas compartilhadas (TanStack Query). Chaves estáveis para invalidar depois de ações. */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type {
  Assets,
  Campaign,
  Capacity,
  ContactImport,
  ContactList,
  Page,
  Suppression,
  Template,
  Tenant,
  TenantNumber,
} from './types';

export const keys = {
  tenants: (q?: string) => ['tenants', q ?? ''] as const,
  allTenants: ['tenants', '__all'] as const,
  tenant: (id: string) => ['tenant', id] as const,
  assets: (id: string) => ['assets', id] as const,
  templates: (id: string) => ['templates', id] as const,
  lists: (id: string) => ['lists', id] as const,
  imports: (id: string) => ['imports', id] as const,
  suppressions: (id: string) => ['suppressions', id] as const,
  tenantNumber: (id: string) => ['tenant-number', id] as const,
  campaigns: (id: string) => ['campaigns', id] as const,
  campaign: (tid: string, cid: string) => ['campaign', tid, cid] as const,
  recipients: (tid: string, cid: string, status: string) =>
    ['recipients', tid, cid, status] as const,
  capacity: (id: string) => ['capacity', id] as const,
};

const t = (id: string) => `/tenants/${encodeURIComponent(id)}`;

/** Todos os clientes (até 1.000), para seletores e para a visão geral de disparos. */
export async function fetchAllTenants(): Promise<Tenant[]> {
  const out: Tenant[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await api.get<Page<Tenant>>('/tenants', { limit: 100, cursor });
    out.push(...page.data);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export const useAllTenants = () =>
  useQuery({ queryKey: keys.allTenants, queryFn: fetchAllTenants });

export const useTenant = (id: string) =>
  useQuery({ queryKey: keys.tenant(id), queryFn: () => api.get<Tenant>(t(id)) });

export const useAssets = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.assets(id),
    queryFn: () => api.get<Assets>(`${t(id)}/assets`),
    enabled,
  });

export const useTemplates = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.templates(id),
    queryFn: () => api.get<{ data: Template[] }>(`${t(id)}/templates`).then((r) => r.data),
    enabled,
  });

export const useLists = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.lists(id),
    queryFn: () => api.get<{ data: ContactList[] }>(`${t(id)}/lists`).then((r) => r.data),
    enabled,
  });

export const useImports = (id: string) =>
  useQuery({
    queryKey: keys.imports(id),
    queryFn: () => api.get<{ data: ContactImport[] }>(`${t(id)}/imports`).then((r) => r.data),
  });

export const useSuppressions = (id: string) =>
  useQuery({
    queryKey: keys.suppressions(id),
    queryFn: () => api.get<{ total: number; data: Suppression[] }>(`${t(id)}/suppressions`),
  });

export const useTenantNumber = (id: string) =>
  useQuery({
    queryKey: keys.tenantNumber(id),
    queryFn: () => api.get<TenantNumber>(`${t(id)}/number`),
  });

export const fetchCampaigns = (id: string) =>
  api.get<{ data: Campaign[] }>(`${t(id)}/campaigns`).then((r) => r.data);

export const useCampaigns = (id: string) =>
  useQuery({ queryKey: keys.campaigns(id), queryFn: () => fetchCampaigns(id) });

export const useCapacity = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.capacity(id),
    queryFn: () => api.get<Capacity>(`${t(id)}/capacity`),
    enabled,
  });

export const tenantPath = t;

/** Números de WhatsApp conectados de um cliente (de todas as contas). */
export function connectedPhones(assets: Assets | undefined) {
  return (assets?.portfolios ?? []).flatMap((p) =>
    p.wabas.flatMap((w) => w.phoneNumbers.map((n) => ({ ...n, waba: w, portfolio: p }))),
  );
}

export function allWabas(assets: Assets | undefined) {
  return (assets?.portfolios ?? []).flatMap((p) => p.wabas.map((w) => ({ ...w, portfolio: p })));
}
