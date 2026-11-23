import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconCheck } from '../../components/icons';
import { Button, Card, cx, DefinitionList, ErrorAlert, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatPhone } from '../../lib/format';
import { tenantStatus } from '../../lib/labels';
import { connectedPhones, keys, useAssets, useLists, useTemplates } from '../../lib/queries';
import type { Tenant } from '../../lib/types';

function Step({
  done,
  loading,
  title,
  description,
  action,
}: {
  done: boolean;
  loading?: boolean;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={cx(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
          done ? 'bg-ok text-white dark:text-canvas' : 'border-2 border-line-strong text-muted',
        )}
      >
        {loading ? <Spinner className="size-3" /> : done ? <IconCheck className="size-4" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx('text-sm font-medium', done ? 'text-muted line-through' : 'text-fg')}>
          {title}
        </p>
        {!done && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {!done && action}
    </li>
  );
}

export function OverviewTab({ tenant }: { tenant: Tenant }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const assets = useAssets(tenant.id, can('assets.read'));
  const templates = useTemplates(tenant.id, can('templates.read'));
  const lists = useLists(tenant.id, can('contacts.read'));

  const status = useMutation({
    mutationFn: (s: 'active' | 'paused') =>
      api.post<Tenant>(`/tenants/${tenant.id}/status`, { status: s }),
    onSuccess: (t) => {
      qc.setQueryData(keys.tenant(tenant.id), (old: Tenant | undefined) => ({ ...old, ...t }));
      qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });

  const phones = connectedPhones(assets.data);
  const hasConnection = phones.some((p) => p.status === 'connected');
  const hasTemplate = (templates.data ?? []).some((t) => t.status === 'APPROVED');
  const hasList = (lists.data ?? []).some((l) => l.size > 0);
  const base = `/clientes/${tenant.id}`;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card
          title="Próximos passos"
          description="O que falta para este cliente disparar mensagens."
        >
          <ol className="divide-y divide-line">
            <Step
              done={hasConnection}
              loading={assets.isPending}
              title="Conectar o WhatsApp do cliente"
              description="Ligar a conta do WhatsApp Business do cliente ao painel."
              action={
                <Link
                  className="text-sm font-medium text-accent hover:underline"
                  to={`${base}/whatsapp`}
                >
                  Conectar
                </Link>
              }
            />
            <Step
              done={hasTemplate}
              loading={templates.isPending}
              title="Ter um modelo de mensagem aprovado"
              description="A Meta precisa aprovar o texto antes do envio (costuma levar até 24 horas)."
              action={
                <Link
                  className="text-sm font-medium text-accent hover:underline"
                  to={`${base}/modelos`}
                >
                  Criar modelo
                </Link>
              }
            />
            <Step
              done={hasList}
              loading={lists.isPending}
              title="Importar a lista de contatos"
              description="Envie a planilha com os telefones (CSV, TXT ou Excel)."
              action={
                <Link
                  className="text-sm font-medium text-accent hover:underline"
                  to={`${base}/importar`}
                >
                  Importar
                </Link>
              }
            />
            <Step
              done={false}
              title="Fazer o disparo"
              description="Escolha a lista e o modelo e acompanhe o envio em tempo real."
              action={
                hasConnection && hasTemplate && hasList && can('campaigns.write') ? (
                  <Link
                    className="text-sm font-medium text-accent hover:underline"
                    to={`/disparos/novo?cliente=${tenant.id}`}
                  >
                    Novo disparo
                  </Link>
                ) : undefined
              }
            />
          </ol>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card
          title="Situação"
          actions={
            can('tenants.write') &&
            (tenant.status === 'paused' || tenant.status === 'onboarding' ? (
              <Button size="sm" loading={status.isPending} onClick={() => status.mutate('active')}>
                Ativar
              </Button>
            ) : tenant.status === 'active' ? (
              <Button
                size="sm"
                variant="secondary"
                loading={status.isPending}
                onClick={() => status.mutate('paused')}
              >
                Pausar cliente
              </Button>
            ) : null)
          }
        >
          <p className="text-sm text-muted">
            {tenantStatus(tenant.status).text}.{' '}
            {tenant.status === 'paused'
              ? 'Nenhum disparo novo é feito enquanto o cliente está pausado.'
              : tenant.status === 'onboarding'
                ? 'Ative quando a configuração estiver pronta.'
                : ''}
          </p>
          {status.error && (
            <div className="mt-3">
              <ErrorAlert error={status.error} />
            </div>
          )}
        </Card>
        <Card title="Dados do cliente">
          <DefinitionList
            items={[
              ['Razão social', tenant.legalName ?? '—'],
              ['CNPJ', tenant.cnpj ?? '—'],
              ['Contato', tenant.contactName ?? '—'],
              ['Telefone', formatPhone(tenant.contactPhone)],
              ['E-mail', tenant.contactEmail ?? '—'],
              ['Cadastrado em', formatDateTime(tenant.createdAt)],
            ]}
          />
          {tenant.notes && (
            <p className="mt-4 whitespace-pre-line text-sm text-muted">{tenant.notes}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
