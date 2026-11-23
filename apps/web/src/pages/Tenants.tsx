import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconClients, IconPlus } from '../components/icons';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  StatusBadge,
  Textarea,
} from '../components/ui';
import { api, fieldErrors } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatPhone } from '../lib/format';
import { tenantStatus } from '../lib/labels';
import { keys } from '../lib/queries';
import type { Page, Tenant } from '../lib/types';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const EMPTY = {
  name: '',
  legalName: '',
  cnpj: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  notes: '',
};

export function TenantForm({
  onDone,
  onCancel,
}: {
  onDone: (t: Tenant) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = useMutation({
    mutationFn: () => {
      // campos vazios não vão (a API trata "" como nulo, mas e-mail vazio seria inválido)
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
      return api.post<Tenant>('/tenants', body);
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
      onDone(t);
    },
  });
  const errs = fieldErrors(create.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="Nome do cliente"
        htmlFor="t-name"
        error={errs.name}
        hint="Como vocês chamam o cliente no dia a dia."
      >
        <Input
          id="t-name"
          required
          value={form.name}
          onChange={set('name')}
          invalid={!!errs.name}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Razão social" htmlFor="t-legal" optional error={errs.legalName}>
          <Input id="t-legal" value={form.legalName} onChange={set('legalName')} />
        </Field>
        <Field label="CNPJ" htmlFor="t-cnpj" optional error={errs.cnpj}>
          <Input
            id="t-cnpj"
            inputMode="numeric"
            value={form.cnpj}
            onChange={set('cnpj')}
            invalid={!!errs.cnpj}
          />
        </Field>
        <Field label="Pessoa de contato" htmlFor="t-cname" optional error={errs.contactName}>
          <Input id="t-cname" value={form.contactName} onChange={set('contactName')} />
        </Field>
        <Field
          label="Telefone do contato"
          htmlFor="t-cphone"
          optional
          error={errs.contactPhone}
          hint="Com DDD. Ex.: (11) 98765-4321"
        >
          <Input
            id="t-cphone"
            type="tel"
            value={form.contactPhone}
            onChange={set('contactPhone')}
            invalid={!!errs.contactPhone}
          />
        </Field>
      </div>
      <Field label="E-mail do contato" htmlFor="t-cemail" optional error={errs.contactEmail}>
        <Input
          id="t-cemail"
          type="email"
          value={form.contactEmail}
          onChange={set('contactEmail')}
          invalid={!!errs.contactEmail}
        />
      </Field>
      <Field label="Observações" htmlFor="t-notes" optional error={errs.notes}>
        <Textarea id="t-notes" rows={3} value={form.notes} onChange={set('notes')} />
      </Field>
      {create.error && Object.keys(errs).length === 0 && <ErrorAlert error={create.error} />}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" loading={create.isPending}>
          Cadastrar cliente
        </Button>
      </div>
    </form>
  );
}

export function TenantsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [creating, setCreating] = useState(false);

  const list = useInfiniteQuery({
    queryKey: keys.tenants(q),
    queryFn: ({ pageParam }) =>
      api.get<Page<Tenant>>('/tenants', { q: q || undefined, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Cada cliente tem a própria conta de WhatsApp, contatos e modelos de mensagem."
        actions={
          can('tenants.write') && (
            <Button onClick={() => setCreating(true)}>
              <IconPlus className="size-4" /> Novo cliente
            </Button>
          )
        }
      />

      <div className="mb-4">
        <label htmlFor="search" className="sr-only">
          Buscar cliente
        </label>
        <Input
          id="search"
          type="search"
          placeholder="Buscar por nome, razão social ou CNPJ…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
      </div>

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorAlert error={list.error} retry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        q ? (
          <EmptyState
            title="Nenhum cliente encontrado"
            description={`Nada com “${q}”. Tente outro nome.`}
          />
        ) : (
          <EmptyState
            icon={<IconClients className="size-10" />}
            title="Nenhum cliente cadastrado ainda"
            description="Comece cadastrando o primeiro cliente. Depois você conecta o WhatsApp dele, importa os contatos e faz os disparos."
            action={
              can('tenants.write') && (
                <Button size="lg" onClick={() => setCreating(true)}>
                  <IconPlus className="size-4" /> Cadastrar primeiro cliente
                </Button>
              )
            }
          />
        )
      ) : (
        <div className="space-y-4">
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/clientes/${r.id}`)}
            rowLabel={(r) => `Abrir ${r.name}`}
            columns={[
              { key: 'name', header: 'Cliente', render: (r) => r.name },
              {
                key: 'status',
                header: 'Situação',
                render: (r) => <StatusBadge label={tenantStatus(r.status)} />,
              },
              { key: 'contact', header: 'Contato', render: (r) => r.contactName ?? '—' },
              { key: 'phone', header: 'Telefone', render: (r) => formatPhone(r.contactPhone) },
              { key: 'created', header: 'Cadastrado em', render: (r) => formatDate(r.createdAt) },
            ]}
          />
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo cliente" wide>
        <TenantForm
          onCancel={() => setCreating(false)}
          onDone={(t) => {
            setCreating(false);
            navigate(`/clientes/${t.id}`);
          }}
        />
      </Modal>
    </>
  );
}
