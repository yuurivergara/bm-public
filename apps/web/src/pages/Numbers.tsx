import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { IconPlus } from '../components/icons';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
} from '../components/ui';
import { api, fieldErrors } from '../lib/api';
import { formatBRL, formatDate, formatPhone } from '../lib/format';
import { inventoryStatus } from '../lib/labels';
import type { InventoryNumber, InventoryStatus, NumberProvider } from '../lib/types';

const STATUS_FILTERS: { value: '' | InventoryStatus; text: string }[] = [
  { value: '', text: 'Todos' },
  { value: 'available', text: 'Disponíveis' },
  { value: 'verifying', text: 'Em verificação' },
  { value: 'active', text: 'Em uso' },
  { value: 'quarantine', text: 'Quarentena' },
  { value: 'cancelled', text: 'Cancelados' },
];

function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<{ data: NumberProvider[] }>('/number-providers').then((r) => r.data),
  });
}

function ProviderForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<NumberProvider>('/number-providers', { name: name.trim(), apiKind: 'manual' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      onDone();
    },
  });
  const errs = fieldErrors(create.error);
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field
        label="Nome do fornecedor"
        htmlFor="p-name"
        error={errs.name}
        hint="De onde vêm os chips/números virtuais. Ex.: Operadora X"
      >
        <Input
          id="p-name"
          required
          minLength={2}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {create.error && !errs.name && <ErrorAlert error={create.error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
        <Button type="submit" loading={create.isPending}>
          Cadastrar fornecedor
        </Button>
      </div>
    </form>
  );
}

function NumberForm({ providers, onDone }: { providers: NumberProvider[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState(
    providers.length === 1 ? (providers[0]?.id ?? '') : '',
  );
  const [phone, setPhone] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<InventoryNumber>('/number-inventory', {
        providerId,
        phone: phone.trim(),
        monthlyCostBrl: Number(cost.replace(',', '.') || '0'),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] });
      onDone();
    },
  });
  const errs = fieldErrors(create.error);
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field label="Fornecedor" htmlFor="i-prov" error={errs.providerId}>
        <Select
          id="i-prov"
          required
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="">Escolha…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Número"
        htmlFor="i-phone"
        error={errs.phone}
        hint="Com DDD. Ex.: (11) 98765-4321"
      >
        <Input
          id="i-phone"
          type="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </Field>
      <Field label="Custo mensal (R$)" htmlFor="i-cost" error={errs.monthlyCostBrl}>
        <Input
          id="i-cost"
          inputMode="decimal"
          placeholder="0,00"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />
      </Field>
      <Field label="Observações" htmlFor="i-notes" optional error={errs.notes}>
        <Input
          id="i-notes"
          maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      {create.error && Object.keys(errs).length === 0 && <ErrorAlert error={create.error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
        <Button type="submit" loading={create.isPending}>
          Adicionar ao estoque
        </Button>
      </div>
    </form>
  );
}

export function NumbersPage() {
  const [status, setStatus] = useState<'' | InventoryStatus>('');
  const [modal, setModal] = useState<'number' | 'provider'>();
  const providers = useProviders();
  const inventory = useQuery({
    queryKey: ['inventory', status],
    queryFn: () =>
      api
        .get<{ data: InventoryNumber[] }>('/number-inventory', { status: status || undefined })
        .then((r) => r.data),
  });
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        title="Números"
        description="Estoque de números próprios para clientes que não têm número de WhatsApp. Um número por cliente."
        actions={
          <>
            <Button variant="secondary" onClick={() => setModal('provider')}>
              Novo fornecedor
            </Button>
            <Button onClick={() => setModal('number')} disabled={!providers.data?.length}>
              <IconPlus className="size-4" /> Adicionar número
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        {providers.data?.length === 0 && (
          <Alert tone="info" title="Cadastre um fornecedor primeiro">
            Todo número do estoque vem de um fornecedor (operadora ou serviço de números virtuais).
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="inv-status" className="text-sm text-muted">
            Mostrar
          </label>
          <Select
            id="inv-status"
            className="w-48"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | InventoryStatus)}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.text}
              </option>
            ))}
          </Select>
        </div>
        {inventory.isPending ? (
          <Loading />
        ) : inventory.error ? (
          <ErrorAlert error={inventory.error} retry={() => inventory.refetch()} />
        ) : inventory.data.length === 0 ? (
          <EmptyState
            title={status ? 'Nenhum número nesta situação' : 'Estoque vazio'}
            description="Adicione os números que vocês compraram para atribuir aos clientes."
          />
        ) : (
          <DataTable
            rows={inventory.data}
            rowKey={(n) => n.id}
            columns={[
              { key: 'phone', header: 'Número', render: (n) => formatPhone(n.phoneE164) },
              {
                key: 'status',
                header: 'Situação',
                render: (n) => <StatusBadge label={inventoryStatus(n.status)} />,
              },
              { key: 'prov', header: 'Fornecedor', render: (n) => providerName(n.providerId) },
              { key: 'cost', header: 'Custo/mês', render: (n) => formatBRL(n.monthlyCostBrl) },
              {
                key: 'since',
                header: 'Desde',
                render: (n) =>
                  n.status === 'quarantine' && n.quarantineUntil
                    ? `livre em ${formatDate(n.quarantineUntil)}`
                    : formatDate(n.acquiredAt),
              },
              {
                key: 'notes',
                header: 'Observações',
                render: (n) => n.notes ?? '—',
                hideOnCard: true,
              },
            ]}
          />
        )}
        {(providers.data?.length ?? 0) > 0 && (
          <Card title="Fornecedores">
            <ul className="flex flex-wrap gap-2">
              {providers.data?.map((p) => (
                <li
                  key={p.id}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-fg"
                >
                  {p.name}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Modal
        open={modal === 'provider'}
        onClose={() => setModal(undefined)}
        title="Novo fornecedor"
      >
        <ProviderForm onDone={() => setModal(undefined)} />
      </Modal>
      <Modal
        open={modal === 'number'}
        onClose={() => setModal(undefined)}
        title="Adicionar número ao estoque"
      >
        {providers.data && (
          <NumberForm providers={providers.data} onDone={() => setModal(undefined)} />
        )}
      </Modal>
    </>
  );
}
