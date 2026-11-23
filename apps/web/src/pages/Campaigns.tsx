import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type CampaignRow, CampaignsUnavailable, CampaignTable } from '../components/CampaignTable';
import { IconPlus, IconSend } from '../components/icons';
import { buttonClass, cx, EmptyState, ErrorAlert, Loading, PageHeader } from '../components/ui';
import { isNotFound } from '../lib/api';
import { useAuth } from '../lib/auth';
import { sortCampaigns } from '../lib/campaigns';
import { fetchCampaigns, keys, useAllTenants } from '../lib/queries';

const FILTERS = [
  { id: 'all', label: 'Todos' },
  { id: 'active', label: 'Em andamento' },
  { id: 'done', label: 'Encerrados' },
] as const;

export function CampaignsPage() {
  const { can } = useAuth();
  const tenants = useAllTenants();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const results = useQueries({
    queries: (tenants.data ?? []).map((t) => ({
      queryKey: keys.campaigns(t.id),
      queryFn: () => fetchCampaigns(t.id),
      refetchInterval: (q: { state: { data?: { status: string }[] } }) =>
        q.state.data?.some((c) => c.status === 'running') ? 5000 : false,
    })),
  });

  const newLink = can('campaigns.write') && (
    <Link className={buttonClass('primary')} to="/disparos/novo">
      <IconPlus className="size-4" /> Novo disparo
    </Link>
  );
  const header = (
    <PageHeader
      title="Disparos"
      description="Todos os envios de todos os clientes. Os que estão em andamento atualizam sozinhos."
      actions={newLink}
    />
  );

  if (tenants.isPending)
    return (
      <>
        {header}
        <Loading />
      </>
    );
  if (tenants.error)
    return (
      <>
        {header}
        <ErrorAlert error={tenants.error} retry={() => tenants.refetch()} />
      </>
    );

  const loading = results.some((r) => r.isPending);
  const unavailable = results.length > 0 && results.every((r) => isNotFound(r.error));
  const firstError = results.find((r) => r.error && !isNotFound(r.error))?.error;
  const rows: CampaignRow[] = sortCampaigns(
    results.flatMap((r, i) => {
      const t = tenants.data[i];
      return t && r.data ? r.data.map((c) => ({ ...c, tenantId: t.id, tenantName: t.name })) : [];
    }),
  );
  const visible = rows.filter((c) =>
    filter === 'all'
      ? true
      : filter === 'active'
        ? ['draft', 'running', 'paused'].includes(c.status)
        : ['completed', 'cancelled', 'failed'].includes(c.status),
  );

  return (
    <>
      {header}
      {unavailable ? (
        <CampaignsUnavailable />
      ) : tenants.data.length === 0 ? (
        <EmptyState
          icon={<IconSend className="size-10" />}
          title="Cadastre um cliente primeiro"
          description="Os disparos são feitos sempre em nome de um cliente, com o WhatsApp dele."
          action={
            <Link className={buttonClass('primary', 'lg')} to="/clientes">
              Ir para Clientes
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {firstError && <ErrorAlert error={firstError} />}
          <fieldset className="flex flex-wrap gap-1 rounded-xl bg-subtle p-1 text-sm">
            <legend className="sr-only">Filtrar disparos</legend>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cx(
                  'rounded-lg px-3 py-1.5 font-medium',
                  filter === f.id ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg',
                )}
              >
                {f.label}
              </button>
            ))}
          </fieldset>
          {loading && rows.length === 0 ? (
            <Loading />
          ) : visible.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? 'Nenhum disparo ainda' : 'Nada neste filtro'}
              description={
                rows.length === 0
                  ? 'Crie o primeiro: escolha o cliente, a lista de contatos e um modelo aprovado.'
                  : undefined
              }
              action={rows.length === 0 ? newLink : undefined}
            />
          ) : (
            <CampaignTable rows={visible} showTenant />
          )}
        </div>
      )}
    </>
  );
}
