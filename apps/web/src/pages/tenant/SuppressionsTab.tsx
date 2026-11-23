import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ChoiceCards,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cleanPhoneInput, formatDateTime, formatMaskedPhone, formatNumber } from '../../lib/format';
import { suppressionReason } from '../../lib/labels';
import { keys, tenantPath, useSuppressions } from '../../lib/queries';

interface SuppressResult {
  phoneMasked: string;
  created: boolean;
  removedFromLists: number;
}

function AddForm({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState<'manual' | 'complaint'>('manual');
  const add = useMutation({
    mutationFn: () =>
      api.post<SuppressResult>(`${tenantPath(tenantId)}/suppressions`, {
        phone: cleanPhoneInput(phone),
        reason,
      }),
    onSuccess: () => {
      setPhone('');
      qc.invalidateQueries({ queryKey: keys.suppressions(tenantId) });
      qc.invalidateQueries({ queryKey: keys.lists(tenantId) });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Telefone" htmlFor="s-phone" hint="Com DDD. Ex.: (11) 98765-4321">
        <Input
          id="s-phone"
          type="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="max-w-xs"
        />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Motivo</legend>
        <ChoiceCards
          name="s-reason"
          value={reason}
          onChange={setReason}
          options={[
            { value: 'manual', title: 'A pessoa pediu para não receber' },
            { value: 'complaint', title: 'Reclamação' },
          ]}
        />
      </fieldset>
      {add.error && <ErrorAlert error={add.error} />}
      {add.data && (
        <Alert tone="ok">
          {add.data.created
            ? `${formatMaskedPhone(add.data.phoneMasked)} bloqueado.`
            : `${formatMaskedPhone(add.data.phoneMasked)} já estava bloqueado.`}
          {add.data.removedFromLists > 0 &&
            ` Removido de ${add.data.removedFromLists} ${add.data.removedFromLists === 1 ? 'lista' : 'listas'}.`}
        </Alert>
      )}
      <Button type="submit" loading={add.isPending}>
        Bloquear este telefone
      </Button>
    </form>
  );
}

export function SuppressionsTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const list = useSuppressions(tenantId);
  return (
    <div className="space-y-6">
      <Alert tone="info" title="Opt-out é para sempre">
        Telefones nesta lista nunca recebem mensagens deste cliente, mesmo se aparecerem em
        planilhas novas. Quem toca no botão de descadastro ou responde pedindo para sair entra aqui
        automaticamente.
      </Alert>
      {can('contacts.suppress') && (
        <Card title="Bloquear um telefone manualmente">
          <AddForm tenantId={tenantId} />
        </Card>
      )}
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorAlert error={list.error} retry={() => list.refetch()} />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          title="Ninguém pediu para sair ainda"
          description="Quando alguém pedir, aparece aqui."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {formatNumber(list.data.total)}{' '}
            {list.data.total === 1 ? 'telefone bloqueado' : 'telefones bloqueados'}
            {list.data.total > list.data.data.length &&
              ` (mostrando os ${list.data.data.length} mais recentes)`}
            .
          </p>
          <DataTable
            rows={list.data.data}
            rowKey={(r) => `${r.phoneMasked}-${r.createdAt}`}
            columns={[
              { key: 'phone', header: 'Telefone', render: (r) => formatMaskedPhone(r.phoneMasked) },
              { key: 'reason', header: 'Motivo', render: (r) => suppressionReason(r.reason).text },
              { key: 'date', header: 'Desde', render: (r) => formatDateTime(r.createdAt) },
            ]}
          />
        </div>
      )}
    </div>
  );
}
