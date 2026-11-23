import { useNavigate } from 'react-router-dom';
import { progressPct } from '../lib/campaigns';
import { formatDateTime, formatNumber } from '../lib/format';
import { campaignStatus } from '../lib/labels';
import type { Campaign } from '../lib/types';
import { Alert, DataTable, ProgressBar, StatusBadge } from './ui';

export type CampaignRow = Campaign & { tenantId: string; tenantName?: string };

export function CampaignTable({ rows, showTenant }: { rows: CampaignRow[]; showTenant?: boolean }) {
  const navigate = useNavigate();
  return (
    <DataTable
      rows={rows}
      rowKey={(c) => c.id}
      onRowClick={(c) => navigate(`/disparos/${c.tenantId}/${c.id}`)}
      rowLabel={(c) => `Abrir disparo ${c.name}`}
      columns={[
        { key: 'name', header: 'Disparo', render: (c) => c.name },
        ...(showTenant
          ? [{ key: 'tenant', header: 'Cliente', render: (c: CampaignRow) => c.tenantName ?? '—' }]
          : []),
        {
          key: 'status',
          header: 'Situação',
          render: (c) => <StatusBadge label={campaignStatus(c.status)} />,
        },
        {
          key: 'progress',
          header: 'Progresso',
          className: 'min-w-40',
          render: (c) => (
            <div className="space-y-1">
              <ProgressBar value={progressPct(c.counts)} label={`Progresso de ${c.name}`} />
              <p className="text-xs text-muted">
                {formatNumber(c.counts.total - c.counts.pending)} de {formatNumber(c.counts.total)}
              </p>
            </div>
          ),
        },
        { key: 'list', header: 'Lista', render: (c) => c.listName, hideOnCard: true },
        { key: 'date', header: 'Criado em', render: (c) => formatDateTime(c.createdAt) },
      ]}
    />
  );
}

/** Aviso quando a API ainda não tem os endpoints de disparo (backend do S5 em construção). */
export function CampaignsUnavailable() {
  return (
    <Alert tone="info" title="Disparos ainda não disponíveis neste servidor">
      O módulo de envio está sendo instalado. Assim que estiver no ar, os disparos aparecem aqui.
    </Alert>
  );
}
