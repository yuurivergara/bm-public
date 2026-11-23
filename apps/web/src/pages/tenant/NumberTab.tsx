import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  ChoiceCards,
  DefinitionList,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Select,
  StatusBadge,
  Steps,
} from '../../components/ui';
import { api, fieldErrors } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatPhone } from '../../lib/format';
import { phoneStatus, registrationStatus } from '../../lib/labels';
import {
  allWabas,
  connectedPhones,
  keys,
  tenantPath,
  useAssets,
  useTenantNumber,
} from '../../lib/queries';
import type { InventoryNumber, TenantNumber } from '../../lib/types';

const STEP_INDEX: Record<string, number> = {
  added: 1,
  code_requested: 2,
  code_verified: 3,
  registered: 4,
  deregistered: 3,
};

function useNumberAction(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post<TenantNumber>(`${tenantPath(tenantId)}${path}`, body),
    onSuccess: (data) => {
      qc.setQueryData(keys.tenantNumber(tenantId), data);
      qc.invalidateQueries({ queryKey: keys.assets(tenantId) });
    },
  });
}

function AssignForm({ tenantId, retry }: { tenantId: string; retry?: boolean }) {
  const assets = useAssets(tenantId);
  const inventory = useQuery({
    queryKey: ['inventory', 'available'],
    queryFn: () =>
      api
        .get<{ data: InventoryNumber[] }>('/number-inventory', { status: 'available' })
        .then((r) => r.data),
  });
  const wabas = allWabas(assets.data);
  const [wabaId, setWabaId] = useState('');
  const [inventoryId, setInventoryId] = useState('');
  const [verifiedName, setVerifiedName] = useState('');
  const action = useNumberAction(tenantId);
  const errs = fieldErrors(action.error);
  const chosenWaba = wabaId || (wabas.length === 1 ? (wabas[0]?.id ?? '') : '');

  if (assets.isPending) return <Loading />;
  if (wabas.length === 0) {
    return (
      <Alert tone="warn" title="Conecte o WhatsApp do cliente primeiro">
        O número é adicionado na conta do WhatsApp do cliente.{' '}
        <Link className="font-medium underline" to={`/clientes/${tenantId}/whatsapp`}>
          Ir para Conexão WhatsApp
        </Link>
      </Alert>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    action.mutate({
      path: '/number/assign',
      body: {
        wabaId: chosenWaba,
        verifiedName: verifiedName.trim(),
        ...(inventoryId ? { inventoryId } : {}),
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {wabas.length > 1 && (
        <Field label="Conta do WhatsApp" htmlFor="n-waba" error={errs.wabaId}>
          <Select
            id="n-waba"
            required
            value={chosenWaba}
            onChange={(e) => setWabaId(e.target.value)}
          >
            <option value="">Escolha…</option>
            {wabas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.metaWabaId}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {!retry && (
        <Field
          label="Número do estoque"
          htmlFor="n-inv"
          error={errs.inventoryId}
          hint={inventory.data?.length === 0 ? 'Não há números disponíveis no estoque.' : undefined}
        >
          <Select id="n-inv" value={inventoryId} onChange={(e) => setInventoryId(e.target.value)}>
            <option value="">O próximo disponível (automático)</option>
            {(inventory.data ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {formatPhone(n.phoneE164)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label="Nome que aparece no WhatsApp"
        htmlFor="n-name"
        error={errs.verifiedName}
        hint="Normalmente o nome da empresa do cliente. A Meta revisa esse nome."
      >
        <Input
          id="n-name"
          required
          minLength={3}
          maxLength={120}
          value={verifiedName}
          onChange={(e) => setVerifiedName(e.target.value)}
        />
      </Field>
      {action.error && <ErrorAlert error={action.error} />}
      <Button type="submit" size="lg" loading={action.isPending} disabled={!chosenWaba}>
        {retry ? 'Tentar de novo' : 'Adicionar número à conta do cliente'}
      </Button>
    </form>
  );
}

function RegistrationSteps({ tenantId, data }: { tenantId: string; data: TenantNumber }) {
  const { can } = useAuth();
  const phone = data.phoneNumber;
  const [method, setMethod] = useState<'SMS' | 'VOICE'>('SMS');
  const [code, setCode] = useState('');
  const action = useNumberAction(tenantId);
  if (!phone) return null;
  const step = phone.registrationStatus ?? 'added';
  const base = `/phone-numbers/${phone.id}`;
  const canAct = can('numbers.assign');

  return (
    <div className="space-y-5">
      <Steps
        steps={['Atribuir', 'Pedir código', 'Confirmar código', 'Ativar']}
        current={STEP_INDEX[step] ?? 1}
      />
      {phone.registrationError && step !== 'registered' && (
        <Alert tone="danger" title="A última tentativa falhou">
          {phone.registrationError}
        </Alert>
      )}
      {action.error && <ErrorAlert error={action.error} />}

      {canAct && (step === 'added' || step === 'code_requested') && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {step === 'added'
              ? 'A Meta vai mandar um código de 6 números para este telefone. Como prefere receber?'
              : 'Não chegou? Você pode pedir de novo (por SMS ou ligação).'}
          </p>
          <ChoiceCards
            name="method"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'SMS', title: 'Por SMS' },
              { value: 'VOICE', title: 'Por ligação de voz' },
            ]}
          />
          <Button
            variant={step === 'added' ? 'primary' : 'secondary'}
            size={step === 'added' ? 'lg' : 'md'}
            loading={action.isPending && action.variables?.path.endsWith('/request')}
            onClick={() =>
              action.mutate({
                path: `${base}/verification/request`,
                body: { method, language: 'pt_BR' },
              })
            }
          >
            {step === 'added' ? 'Pedir código' : 'Pedir outro código'}
          </Button>
        </div>
      )}

      {canAct && step === 'code_requested' && (
        <form
          className="space-y-3 border-t border-line pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate({ path: `${base}/verification/verify`, body: { code } });
          }}
        >
          <Field
            label="Código recebido"
            htmlFor="n-code"
            hint="6 números, enviados pela Meta para o telefone."
          >
            <Input
              id="n-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="max-w-40 text-center font-mono text-lg tracking-[0.3em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
          <Button
            type="submit"
            size="lg"
            disabled={code.length !== 6}
            loading={action.isPending && action.variables?.path.endsWith('/verify')}
          >
            Confirmar código
          </Button>
        </form>
      )}

      {canAct && (step === 'code_verified' || step === 'deregistered') && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Código confirmado. Falta ativar o número para envio.</p>
          <Button
            size="lg"
            loading={action.isPending}
            onClick={() => action.mutate({ path: `${base}/register` })}
          >
            Ativar número
          </Button>
        </div>
      )}

      {step === 'registered' && (
        <Alert tone="ok" title="Número pronto para enviar mensagens">
          Ativado em {formatDateTime(phone.registeredAt)}.
        </Alert>
      )}
    </div>
  );
}

export function NumberTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const num = useTenantNumber(tenantId);
  const assets = useAssets(tenantId);

  if (num.isPending) return <Loading />;
  if (num.error) return <ErrorAlert error={num.error} retry={() => num.refetch()} />;
  const { assignment, phoneNumber } = num.data;
  const shared = connectedPhones(assets.data).filter(
    (p) => !p.registrationStatus && p.status !== 'disconnected',
  );

  if (!assignment) {
    return (
      <div className="space-y-6">
        {shared.length > 0 && (
          <Alert tone="info" title="Este cliente já tem número próprio">
            O número {shared[0]?.displayPhoneNumber ?? formatPhone(shared[0]?.phoneE164)} veio junto
            com a conta do WhatsApp do cliente. Só é possível um número ativo por cliente.
          </Alert>
        )}
        {shared.length === 0 && (
          <Card
            title="Atribuir um número do estoque"
            description="Use quando o cliente não tem número próprio: um número do seu estoque é adicionado à conta do WhatsApp dele."
          >
            {can('numbers.assign') ? (
              <AssignForm tenantId={tenantId} />
            ) : (
              <p className="text-sm text-muted">Nenhum número atribuído a este cliente.</p>
            )}
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card title="Número do cliente">
        <DefinitionList
          items={[
            ['Telefone', formatPhone(phoneNumber?.phoneE164 ?? assignment.phoneE164)],
            ['Nome no WhatsApp', phoneNumber?.verifiedName ?? '—'],
            [
              'Situação',
              phoneNumber ? <StatusBadge key="s" label={phoneStatus(phoneNumber.status)} /> : '—',
            ],
            [
              'Registro',
              <StatusBadge
                key="r"
                label={registrationStatus(phoneNumber?.registrationStatus ?? null)}
              />,
            ],
            ['Atribuído em', formatDateTime(assignment.assignedAt)],
          ]}
        />
      </Card>
      <Card
        title="Ativação do número"
        description="Siga os passos na ordem. Cada passo fala com a Meta na hora."
      >
        {phoneNumber ? (
          <RegistrationSteps tenantId={tenantId} data={num.data} />
        ) : (
          <div className="space-y-4">
            <Alert tone="warn" title="O número ainda não entrou na conta do cliente">
              A etapa de adicionar o número na Meta não terminou. Tente de novo.
            </Alert>
            {can('numbers.assign') && <AssignForm tenantId={tenantId} retry />}
          </div>
        )}
      </Card>
    </div>
  );
}
