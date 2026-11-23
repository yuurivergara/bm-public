import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CampaignsUnavailable } from '../components/CampaignTable';
import { IconBack } from '../components/icons';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  ProgressBar,
  Select,
  Stat,
  StatusBadge,
} from '../components/ui';
import { api, isNotFound } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  allowedActions,
  deliveredOrRead,
  isActive,
  processed,
  progressPct,
} from '../lib/campaigns';
import { formatDateTime, formatMaskedPhone, formatNumber } from '../lib/format';
import { campaignStatus, RECIPIENT_STATUSES, recipientStatus } from '../lib/labels';
import { keys, tenantPath, useTenant } from '../lib/queries';
import type { Campaign, Recipient } from '../lib/types';

type Action = 'start' | 'pause' | 'resume' | 'cancel';

const ACTION_UI: Record<
  Action,
  { text: string; title: string; message: string; danger?: boolean }
> = {
  start: {
    text: 'Disparar agora',
    title: 'Começar o envio?',
    message: 'As mensagens começam a sair agora, respeitando o limite diário do cliente.',
  },
  pause: {
    text: 'Pausar',
    title: 'Pausar o envio?',
    message: 'Nenhuma mensagem nova sai enquanto estiver pausado. Você pode retomar depois.',
  },
  resume: {
    text: 'Retomar',
    title: 'Retomar o envio?',
    message: 'O envio continua de onde parou.',
  },
  cancel: {
    text: 'Cancelar disparo',
    title: 'Cancelar este disparo?',
    message: 'Quem ainda não recebeu não vai receber. Isso não pode ser desfeito.',
    danger: true,
  },
};

function Recipients({
  tenantId,
  campaignId,
  running,
}: {
  tenantId: string;
  campaignId: string;
  running: boolean;
}) {
  const [status, setStatus] = useState('');
  const q = useInfiniteQuery({
    queryKey: keys.recipients(tenantId, campaignId, status),
    queryFn: ({ pageParam }) =>
      api.get<{ data: Recipient[]; next: string | null }>(
        `${tenantPath(tenantId)}/campaigns/${campaignId}/recipients`,
        { status: status || undefined, after: pageParam, limit: 50 },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: running ? 10_000 : false,
  });
  // Ao terminar/pausar, o polling para: busca uma última vez para não ficar "Na fila" na tela.
  const wasRunning = useRef(running);
  const { refetch } = q;
  useEffect(() => {
    if (wasRunning.current && !running) void refetch();
    wasRunning.current = running;
  }, [running, refetch]);
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Card
      title="Contatos do disparo"
      actions={
        <Select
          aria-label="Filtrar por situação"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 w-48"
        >
          <option value="">Todas as situações</option>
          {RECIPIENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {recipientStatus(s).text}
            </option>
          ))}
        </Select>
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorAlert error={q.error} retry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nenhum contato nesta situação.</p>
      ) : (
        <div className="space-y-4">
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { key: 'phone', header: 'Telefone', render: (r) => formatMaskedPhone(r.phoneMasked) },
              { key: 'name', header: 'Nome', render: (r) => r.name ?? '—' },
              {
                key: 'status',
                header: 'Situação',
                render: (r) => <StatusBadge label={recipientStatus(r.status)} />,
              },
              {
                key: 'error',
                header: 'Detalhe',
                render: (r) =>
                  r.errorMessage || r.errorCode ? (
                    <span className="text-xs text-muted">
                      {r.errorMessage ?? 'Erro'}
                      {r.errorCode ? ` (código ${r.errorCode})` : ''}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { key: 'at', header: 'Atualizado', render: (r) => formatDateTime(r.updatedAt) },
            ]}
          />
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={q.isFetchingNextPage}
                onClick={() => q.fetchNextPage()}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function CampaignDetailPage() {
  const { tenantId = '', campaignId = '' } = useParams();
  const location = useLocation();
  const startError = (location.state as { startError?: string } | null)?.startError;
  const { can } = useAuth();
  const qc = useQueryClient();
  const tenant = useTenant(tenantId);
  const [confirming, setConfirming] = useState<Action>();
  const campaign = useQuery({
    queryKey: keys.campaign(tenantId, campaignId),
    queryFn: () => api.get<Campaign>(`${tenantPath(tenantId)}/campaigns/${campaignId}`),
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.status) ? 3000 : false),
  });
  const act = useMutation({
    mutationFn: (a: Action) =>
      api.post<Campaign>(`${tenantPath(tenantId)}/campaigns/${campaignId}/${a}`),
    onSuccess: (c) => {
      qc.setQueryData(keys.campaign(tenantId, campaignId), c);
      qc.invalidateQueries({ queryKey: keys.campaigns(tenantId) });
      qc.invalidateQueries({ queryKey: ['recipients', tenantId, campaignId] });
      setConfirming(undefined);
    },
  });

  const back = (
    <Link
      to="/disparos"
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <IconBack className="size-4" /> Disparos
    </Link>
  );

  if (campaign.isPending) return <Loading />;
  if (campaign.error) {
    return (
      <>
        <PageHeader back={back} title="Disparo" />
        {isNotFound(campaign.error) ? (
          <EmptyState
            title="Disparo não encontrado"
            description="Ele pode ter sido removido, ou o módulo de envio ainda não está no ar."
          />
        ) : (
          <ErrorAlert error={campaign.error} retry={() => campaign.refetch()} />
        )}
        {isNotFound(campaign.error) && (
          <div className="mt-4">
            <CampaignsUnavailable />
          </div>
        )}
      </>
    );
  }
  const c = campaign.data;
  const k = c.counts;
  const actions = can('campaigns.write') ? allowedActions(c.status) : [];
  const pct = progressPct(k);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {c.name}
            <StatusBadge label={campaignStatus(c.status)} />
          </span>
        }
        description={tenant.data ? `Cliente: ${tenant.data.name}` : undefined}
        actions={actions.map((a) => (
          <Button
            key={a}
            variant={a === 'cancel' ? 'secondary' : a === 'pause' ? 'secondary' : 'primary'}
            onClick={() => {
              act.reset();
              setConfirming(a);
            }}
          >
            {ACTION_UI[a].text}
          </Button>
        ))}
      />

      <div className="space-y-6">
        {startError && c.status === 'draft' && (
          <Alert tone="danger" title="O disparo foi criado, mas não começou">
            {startError} Corrija e use “Disparar agora”.
          </Alert>
        )}
        {c.status === 'paused' && (
          <Alert tone="warn" title="Envio pausado">
            {c.pauseReason || 'Pausado manualmente. Use “Retomar” para continuar.'}
          </Alert>
        )}
        {c.status === 'failed' && (
          <Alert tone="danger" title="O disparo falhou">
            {c.pauseReason || 'Veja os detalhes dos contatos abaixo.'}
          </Alert>
        )}

        <Card>
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <p className="text-3xl font-semibold tabular-nums text-fg">{pct}%</p>
              <p className="text-sm text-muted">
                {formatNumber(processed(k))} de {formatNumber(k.total)} processados
                {isActive(c.status) && ' · atualizando a cada 3 segundos'}
              </p>
            </div>
            <ProgressBar value={pct} label="Progresso do disparo" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Enviadas"
              value={formatNumber(k.sent + deliveredOrRead(k))}
              hint="Saíram para a Meta"
            />
            <Stat
              label="Entregues"
              value={formatNumber(deliveredOrRead(k))}
              tone="ok"
              hint="Chegaram no celular"
            />
            <Stat label="Lidas" value={formatNumber(k.read)} tone="accent" />
            <Stat
              label="Falharam"
              value={formatNumber(k.failed)}
              tone={k.failed ? 'danger' : undefined}
            />
            <Stat label="Na fila" value={formatNumber(k.pending)} />
            <Stat
              label="Não enviadas"
              value={formatNumber(k.skipped)}
              tone={k.skipped ? 'warn' : undefined}
              hint="Puladas por regra"
            />
            <Stat
              label="Sem confirmação"
              value={formatNumber(k.uncertain)}
              hint="A Meta não confirmou"
            />
            <Stat label="Total" value={formatNumber(k.total)} />
          </div>
        </Card>

        <Card title="Detalhes">
          <DefinitionList
            items={[
              ['Número de envio', c.displayPhone],
              ['Lista', c.listName],
              ['Modelo', `${c.templateName} (${c.language})`],
              ['Criado em', formatDateTime(c.createdAt)],
              ['Início', formatDateTime(c.startedAt)],
              ['Fim', formatDateTime(c.finishedAt)],
            ]}
          />
        </Card>

        <Recipients tenantId={tenantId} campaignId={campaignId} running={isActive(c.status)} />
      </div>

      {confirming && (
        <ConfirmDialog
          open
          title={ACTION_UI[confirming].title}
          message={ACTION_UI[confirming].message}
          confirmText={ACTION_UI[confirming].text}
          danger={ACTION_UI[confirming].danger}
          loading={act.isPending}
          error={act.error}
          onConfirm={() => act.mutate(confirming)}
          onClose={() => setConfirming(undefined)}
        />
      )}
    </>
  );
}
