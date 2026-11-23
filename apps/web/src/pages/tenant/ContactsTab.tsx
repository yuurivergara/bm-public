import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IconUpload } from '../../components/icons';
import {
  Alert,
  Button,
  buttonClass,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Loading,
  Modal,
  StatusBadge,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatMaskedPhone, formatNumber } from '../../lib/format';
import { importStatus } from '../../lib/labels';
import { tenantPath, useImports, useLists } from '../../lib/queries';
import type { ContactList, ListMember } from '../../lib/types';

const IN_PROGRESS = new Set(['uploaded', 'parsing', 'preview', 'confirming']);

function MembersModal({
  tenantId,
  list,
  onClose,
}: {
  tenantId: string;
  list?: ContactList;
  onClose: () => void;
}) {
  const members = useQuery({
    queryKey: ['members', tenantId, list?.id],
    queryFn: () =>
      api
        .get<{ data: ListMember[] }>(`${tenantPath(tenantId)}/lists/${list?.id}/members`, {
          limit: 50,
        })
        .then((r) => r.data),
    enabled: !!list,
  });
  const attrKeys = [
    ...new Set((members.data ?? []).flatMap((m) => Object.keys(m.attributes ?? {}))),
  ];
  return (
    <Modal open={!!list} onClose={onClose} title={list ? `Lista “${list.name}”` : ''} wide>
      {members.isPending ? (
        <Loading />
      ) : members.error ? (
        <ErrorAlert error={members.error} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Mostrando os primeiros {formatNumber(members.data.length)} de{' '}
            {formatNumber(list?.size ?? 0)} contatos. Os telefones aparecem mascarados para proteger
            os dados.
          </p>
          <DataTable
            rows={members.data}
            rowKey={(m) => m.id}
            columns={[
              { key: 'phone', header: 'Telefone', render: (m) => formatMaskedPhone(m.phoneMasked) },
              { key: 'name', header: 'Nome', render: (m) => m.name ?? '—' },
              ...attrKeys.map((k) => ({
                key: `a-${k}`,
                header: k,
                render: (m: ListMember) => m.attributes?.[k] ?? '—',
              })),
            ]}
          />
        </div>
      )}
    </Modal>
  );
}

export function ContactsTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const lists = useLists(tenantId);
  const imports = useImports(tenantId);
  const [viewing, setViewing] = useState<ContactList>();
  const pending = (imports.data ?? []).filter((i) => IN_PROGRESS.has(i.status));
  const importUrl = `/clientes/${tenantId}/importar`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Listas de contatos criadas a partir das planilhas. Quem pediu para sair fica de fora
          sempre.
        </p>
        {can('contacts.import') && (
          <Button onClick={() => navigate(importUrl)}>
            <IconUpload className="size-4" /> Importar planilha
          </Button>
        )}
      </div>

      {pending.map((i) => (
        <Alert
          key={i.id}
          tone={i.status === 'preview' ? 'warn' : 'info'}
          title={
            i.status === 'preview'
              ? `A planilha “${i.originalFilename}” está esperando sua confirmação`
              : `A planilha “${i.originalFilename}” está sendo processada`
          }
          action={
            <Link className={buttonClass('secondary', 'sm')} to={`${importUrl}?importacao=${i.id}`}>
              {i.status === 'preview' ? 'Revisar e confirmar' : 'Acompanhar'}
            </Link>
          }
        />
      ))}

      {lists.isPending ? (
        <Loading />
      ) : lists.error ? (
        <ErrorAlert error={lists.error} retry={() => lists.refetch()} />
      ) : lists.data.length === 0 ? (
        <EmptyState
          icon={<IconUpload className="size-10" />}
          title="Nenhuma lista de contatos ainda"
          description="Importe uma planilha (CSV, TXT ou Excel) com os telefones. Você confere tudo antes de criar a lista."
          action={
            can('contacts.import') && (
              <Button size="lg" onClick={() => navigate(importUrl)}>
                Importar planilha
              </Button>
            )
          }
        />
      ) : (
        <DataTable
          rows={lists.data}
          rowKey={(l) => l.id}
          onRowClick={(l) => setViewing(l)}
          rowLabel={(l) => `Ver contatos da lista ${l.name}`}
          columns={[
            { key: 'name', header: 'Lista', render: (l) => l.name },
            { key: 'size', header: 'Contatos', render: (l) => formatNumber(l.size) },
            { key: 'created', header: 'Criada em', render: (l) => formatDateTime(l.createdAt) },
            {
              key: 'act',
              header: '',
              render: (l) =>
                can('campaigns.write') && l.size > 0 ? (
                  <Link
                    className="text-sm font-medium text-accent hover:underline"
                    to={`/disparos/novo?cliente=${tenantId}&lista=${l.id}`}
                  >
                    Disparar para esta lista
                  </Link>
                ) : null,
            },
          ]}
        />
      )}

      {(imports.data?.length ?? 0) > 0 && (
        <Card title="Histórico de importações">
          <ul className="divide-y divide-line">
            {imports.data?.slice(0, 20).map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{i.originalFilename}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(i.createdAt)} · lista “{i.listName}”
                    {i.validCount != null && ` · ${formatNumber(i.validCount)} válidos`}
                  </p>
                </div>
                <StatusBadge label={importStatus(i.status)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <MembersModal tenantId={tenantId} list={viewing} onClose={() => setViewing(undefined)} />
    </div>
  );
}
