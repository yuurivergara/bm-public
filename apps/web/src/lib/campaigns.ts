import type { Campaign, CampaignCounts, CampaignStatus } from './types';

/** Mensagens que já saíram da fila (qualquer desfecho). */
export function processed(c: CampaignCounts): number {
  return Math.max(0, c.total - c.pending);
}

/** Percentual processado, 0–100 (inteiro). */
export function progressPct(c: CampaignCounts): number {
  if (!c.total) return 0;
  return Math.min(100, Math.floor((processed(c) / c.total) * 100));
}

/** Entregues inclui lidas (lida implica entregue). */
export function deliveredOrRead(c: CampaignCounts): number {
  return c.delivered + c.read;
}

export const isActive = (s: CampaignStatus) => s === 'running';
export const isFinished = (s: CampaignStatus) =>
  s === 'completed' || s === 'cancelled' || s === 'failed';

/** Ações permitidas por status (os botões só aparecem quando fazem sentido). */
export function allowedActions(s: CampaignStatus): ('start' | 'pause' | 'resume' | 'cancel')[] {
  switch (s) {
    case 'draft':
      return ['start', 'cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    default:
      return [];
  }
}

/**
 * Quantos dias o envio leva com a capacidade disponível hoje (limite diário de conversas).
 * 1 = cabe hoje. Infinity quando não há capacidade.
 */
export function daysNeeded(total: number, available: number, dailyLimit: number): number {
  if (total <= 0) return 0;
  if (total <= available) return 1;
  if (dailyLimit <= 0) return Number.POSITIVE_INFINITY;
  return 1 + Math.ceil((total - Math.max(0, available)) / dailyLimit);
}

export function sortCampaigns<T extends Pick<Campaign, 'status' | 'createdAt'>>(list: T[]): T[] {
  const rank = (s: CampaignStatus) => (s === 'running' ? 0 : s === 'paused' ? 1 : 2);
  return [...list].sort(
    (a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt),
  );
}
