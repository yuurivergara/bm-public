import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { IconPlus } from '../components/icons';
import {
  Alert,
  Badge,
  Button,
  ChoiceCards,
  ConfirmDialog,
  DataTable,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import { api, fieldErrors } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { ROLE_LABELS } from '../lib/labels';
import type { ManagedUser, Role } from '../lib/types';

export const PASSWORD_MIN = 12;

/** Validação local do formulário de usuário (a API valida de novo). */
export function validateNewUser(u: { name: string; email: string; password: string }) {
  const e: Record<string, string> = {};
  if (!u.name.trim()) e.name = 'Informe o nome.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email.trim())) e.email = 'E-mail inválido.';
  if (u.password.length < PASSWORD_MIN)
    e.password = `A senha precisa de pelo menos ${PASSWORD_MIN} caracteres.`;
  return e;
}

function UserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [role, setRole] = useState<Role>('operator');
  const [showErrors, setShowErrors] = useState(false);
  const local = validateNewUser(form);
  const create = useMutation({
    mutationFn: () =>
      api.post<ManagedUser>('/users', {
        ...form,
        email: form.email.trim(),
        name: form.name.trim(),
        role,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
  });
  const errs = { ...(showErrors ? local : {}), ...fieldErrors(create.error) };
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setShowErrors(true);
        if (Object.keys(local).length === 0) create.mutate();
      }}
    >
      <Field label="Nome" htmlFor="u-name" error={errs.name}>
        <Input
          id="u-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>
      <Field label="E-mail" htmlFor="u-email" error={errs.email}>
        <Input
          id="u-email"
          type="email"
          autoComplete="off"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field
        label="Senha inicial"
        htmlFor="u-pass"
        error={errs.password}
        hint={`Mínimo de ${PASSWORD_MIN} caracteres. Passe para a pessoa por um canal seguro; no primeiro acesso ela configura o autenticador.`}
      >
        <Input
          id="u-pass"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Permissão</legend>
        <ChoiceCards
          name="u-role"
          value={role}
          onChange={setRole}
          options={(['operator', 'viewer', 'owner'] as Role[]).map((r) => ({
            value: r,
            title: ROLE_LABELS[r]?.text ?? r,
            description: ROLE_LABELS[r]?.hint,
          }))}
        />
      </fieldset>
      {create.error && !Object.keys(fieldErrors(create.error)).length && (
        <ErrorAlert error={create.error} />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
        <Button type="submit" loading={create.isPending}>
          Criar usuário
        </Button>
      </div>
    </form>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<ManagedUser>();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ data: ManagedUser[] }>('/users').then((r) => r.data),
  });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: string; role?: Role }) =>
      api.patch(`/users/${id}`, patch),
    onSuccess: () => {
      setToggling(undefined);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Usuários"
        description="Quem acessa o painel. Todo acesso usa senha + código do app autenticador."
        actions={
          <Button onClick={() => setCreating(true)}>
            <IconPlus className="size-4" /> Novo usuário
          </Button>
        }
      />
      {update.error && !toggling && (
        <div className="mb-4">
          <ErrorAlert error={update.error} />
        </div>
      )}
      {users.isPending ? (
        <Loading />
      ) : users.error ? (
        <ErrorAlert error={users.error} retry={() => users.refetch()} />
      ) : (
        <DataTable
          rows={users.data}
          rowKey={(u) => u.id}
          columns={[
            {
              key: 'name',
              header: 'Nome',
              render: (u) => (
                <span>
                  {u.name}
                  {u.id === me?.user.id && <span className="ml-2 text-xs text-muted">(você)</span>}
                  <span className="block text-xs font-normal text-muted">{u.email}</span>
                </span>
              ),
            },
            {
              key: 'role',
              header: 'Permissão',
              render: (u) =>
                u.id === me?.user.id ? (
                  ROLE_LABELS[u.role]?.text
                ) : (
                  <select
                    aria-label={`Permissão de ${u.name}`}
                    className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg"
                    value={u.role}
                    disabled={update.isPending}
                    onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    {(['owner', 'operator', 'viewer'] as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]?.text}
                      </option>
                    ))}
                  </select>
                ),
            },
            {
              key: 'status',
              header: 'Situação',
              render: (u) =>
                u.status === 'active' ? (
                  u.totpEnrolledAt ? (
                    <Badge tone="ok">Ativo</Badge>
                  ) : (
                    <Badge tone="info">Aguardando 1º acesso</Badge>
                  )
                ) : (
                  <Badge>Desativado</Badge>
                ),
            },
            { key: 'last', header: 'Último acesso', render: (u) => formatDateTime(u.lastLoginAt) },
            {
              key: 'act',
              header: '',
              render: (u) =>
                u.id === me?.user.id ? null : (
                  <Button size="sm" variant="ghost" onClick={() => setToggling(u)}>
                    {u.status === 'active' ? 'Desativar' : 'Reativar'}
                  </Button>
                ),
            },
          ]}
        />
      )}
      <Alert tone="info">
        <span className="text-sm">
          Esqueceu a senha ou trocou de celular? Desative o usuário e crie um novo acesso para a
          pessoa.
        </span>
      </Alert>

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo usuário">
        {creating && <UserForm onDone={() => setCreating(false)} />}
      </Modal>
      <ConfirmDialog
        open={!!toggling}
        title={toggling?.status === 'active' ? 'Desativar usuário?' : 'Reativar usuário?'}
        message={
          toggling?.status === 'active'
            ? `${toggling?.name} perde o acesso imediatamente (as sessões abertas são encerradas).`
            : `${toggling?.name} volta a poder entrar no painel.`
        }
        confirmText={toggling?.status === 'active' ? 'Desativar' : 'Reativar'}
        danger={toggling?.status === 'active'}
        loading={update.isPending}
        error={update.error}
        onConfirm={() =>
          toggling &&
          update.mutate({
            id: toggling.id,
            status: toggling.status === 'active' ? 'disabled' : 'active',
          })
        }
        onClose={() => {
          setToggling(undefined);
          update.reset();
        }}
      />
    </>
  );
}
