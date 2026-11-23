import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconPlus, IconRefresh } from '../../components/icons';
import { MessagePreview } from '../../components/MessagePreview';
import {
  Alert,
  Badge,
  Button,
  ChoiceCards,
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Select,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, slugify } from '../../lib/format';
import { templateCategory, templateStatus } from '../../lib/labels';
import { allWabas, keys, tenantPath, useAssets, useTemplates } from '../../lib/queries';
import {
  BODY_MAX,
  buildTemplatePayload,
  DEFAULT_OPT_OUT_TEXT,
  type DraftErrors,
  positionalVariables,
  renderTemplate,
  type TemplateDraft,
  templateBody,
  templateButtons,
  templateFooter,
  templateHeader,
  validateTemplateDraft,
} from '../../lib/templates';
import type { Template } from '../../lib/types';

function TemplateForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const assets = useAssets(tenantId);
  const wabas = allWabas(assets.data);
  const [wabaId, setWabaId] = useState('');
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState<TemplateDraft>({
    name: '',
    category: 'MARKETING',
    language: 'pt_BR',
    body: '',
    footer: '',
    optOutButton: DEFAULT_OPT_OUT_TEXT,
    examples: {},
  });
  const [showErrors, setShowErrors] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const chosenWaba = wabaId || (wabas.length === 1 ? (wabas[0]?.id ?? '') : '');
  const errors: DraftErrors = useMemo(() => validateTemplateDraft(draft), [draft]);
  const vars = positionalVariables(draft.body);
  const update = (patch: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const create = useMutation({
    mutationFn: () =>
      api.post<Template>(
        `${tenantPath(tenantId)}/templates`,
        buildTemplatePayload(draft, chosenWaba),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.templates(tenantId) });
      onDone();
    },
  });

  function insertVariable() {
    const next = `{{${vars.length + 1}}}`;
    const el = bodyRef.current;
    const pos = el?.selectionStart ?? draft.body.length;
    const body = draft.body.slice(0, pos) + next + draft.body.slice(pos);
    update({ body });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + next.length, pos + next.length);
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length === 0 && chosenWaba) create.mutate();
  }

  const err = (k: keyof DraftErrors) => (showErrors ? errors[k] : undefined);

  if (assets.isPending) return <Loading />;
  if (wabas.length === 0) {
    return (
      <Alert tone="warn" title="Conecte o WhatsApp do cliente primeiro">
        O modelo é criado na conta do WhatsApp do cliente.{' '}
        <Link className="font-medium underline" to={`/clientes/${tenantId}/whatsapp`}>
          Ir para Conexão WhatsApp
        </Link>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        {wabas.length > 1 && (
          <Field label="Conta do WhatsApp" htmlFor="tp-waba">
            <Select
              id="tp-waba"
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
        <Field
          label="Nome do modelo"
          htmlFor="tp-title"
          error={err('name')}
          hint={draft.name ? `Nome técnico na Meta: ${draft.name}` : 'Ex.: Promoção de Natal'}
        >
          <Input
            id="tp-title"
            required
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              update({ name: slugify(e.target.value, 512) });
            }}
          />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium text-fg">Tipo de mensagem</legend>
          <ChoiceCards
            name="tp-category"
            value={draft.category}
            onChange={(category) => update({ category })}
            options={[
              {
                value: 'MARKETING',
                title: 'Marketing',
                description: 'Promoções, novidades, convites, ofertas.',
              },
              {
                value: 'UTILITY',
                title: 'Utilidade',
                description: 'Avisos de pedido, cobrança, agendamento. Sem propaganda.',
              },
            ]}
          />
        </fieldset>
        <Field
          label="Texto da mensagem"
          htmlFor="tp-body"
          error={err('body')}
          hint={`Use {{1}}, {{2}}… onde entra algo que muda por contato (ex.: o nome). ${draft.body.length}/${BODY_MAX}`}
        >
          <Textarea
            id="tp-body"
            ref={bodyRef}
            rows={6}
            required
            maxLength={BODY_MAX}
            value={draft.body}
            onChange={(e) => update({ body: e.target.value })}
            placeholder="Olá, {{1}}! Temos uma novidade para você…"
            invalid={!!err('body')}
          />
        </Field>
        <Button size="sm" variant="secondary" onClick={insertVariable}>
          <IconPlus className="size-4" /> Inserir variável {`{{${vars.length + 1}}}`}
        </Button>
        {vars.length > 0 && (
          <div className="space-y-3 rounded-xl border border-line p-4">
            <p className="text-sm text-muted">
              A Meta pede um exemplo de cada variável para revisar o modelo (não é enviado aos
              contatos).
            </p>
            {vars.map((v) => (
              <Field
                key={v}
                label={`Exemplo para {{${v}}}`}
                htmlFor={`tp-ex-${v}`}
                error={err(`example_${v}`)}
              >
                <Input
                  id={`tp-ex-${v}`}
                  value={draft.examples[v] ?? ''}
                  placeholder={v === '1' ? 'Ana' : ''}
                  onChange={(e) => update({ examples: { ...draft.examples, [v]: e.target.value } })}
                />
              </Field>
            ))}
          </div>
        )}
        <Field
          label="Rodapé"
          htmlFor="tp-footer"
          optional
          error={err('footer')}
          hint="Texto pequeno no fim. Ex.: nome da loja."
        >
          <Input
            id="tp-footer"
            maxLength={60}
            value={draft.footer}
            onChange={(e) => update({ footer: e.target.value })}
          />
        </Field>
        <Field
          label="Botão de descadastro"
          htmlFor="tp-optout"
          optional={draft.category !== 'MARKETING'}
          error={err('optOutButton')}
          hint={
            draft.category === 'MARKETING'
              ? 'Obrigatório em marketing: quem tocar nele não recebe mais mensagens deste cliente.'
              : 'Recomendado. Quem tocar nele não recebe mais mensagens deste cliente.'
          }
        >
          <Input
            id="tp-optout"
            maxLength={25}
            value={draft.optOutButton}
            onChange={(e) => update({ optOutButton: e.target.value })}
          />
        </Field>
        {create.error && <ErrorAlert error={create.error} />}
        {showErrors && Object.keys(errors).length > 0 && (
          <Alert tone="warn">Corrija os campos destacados antes de enviar.</Alert>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="submit" size="lg" loading={create.isPending}>
            Enviar para aprovação da Meta
          </Button>
          <Button variant="ghost" size="lg" onClick={onDone}>
            Cancelar
          </Button>
        </div>
      </div>
      <div className="space-y-2 lg:col-span-2">
        <p className="text-sm font-medium text-fg">Prévia</p>
        <MessagePreview
          body={renderTemplate(draft.body, draft.examples)}
          footer={draft.footer}
          buttons={draft.optOutButton.trim() ? [draft.optOutButton.trim()] : []}
        />
        <p className="text-xs text-muted">
          Depois de enviado, a Meta revisa o modelo (geralmente em até 24 horas). Use “Sincronizar
          com a Meta” para ver se já foi aprovado.
        </p>
      </div>
    </form>
  );
}

function TemplateCard({ t, onDelete }: { t: Template; onDelete?: () => void }) {
  const status = templateStatus(t.status);
  return (
    <li className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all font-semibold text-fg">{t.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge>{templateCategory(t.category).text}</Badge>
            <span>{t.language}</span>
            <span>· atualizado {formatDateTime(t.updatedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge label={status} />
          {onDelete && t.status !== 'DELETED' && (
            <Button size="sm" variant="ghost" onClick={onDelete}>
              Excluir
            </Button>
          )}
        </div>
      </div>
      {t.status === 'REJECTED' && (
        <div className="mt-3">
          <Alert tone="danger" title="A Meta reprovou este modelo">
            {t.rejectionReason && t.rejectionReason !== 'NONE'
              ? `Motivo: ${t.rejectionReason}. `
              : ''}
            Ajuste o texto e crie um novo modelo com outro nome.
          </Alert>
        </div>
      )}
      <MessagePreview
        className="mt-3"
        header={templateHeader(t)}
        body={templateBody(t)}
        footer={templateFooter(t)}
        buttons={templateButtons(t)}
      />
    </li>
  );
}

export function TemplatesTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const templates = useTemplates(tenantId);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Template>();
  const sync = useMutation({
    mutationFn: () =>
      api.post<{ data: Template[]; synced: number; syncErrors: { message: string }[] }>(
        `${tenantPath(tenantId)}/templates/sync`,
      ),
    onSuccess: (r) => qc.setQueryData(keys.templates(tenantId), r.data),
  });
  const remove = useMutation({
    mutationFn: (t: Template) => api.del(`${tenantPath(tenantId)}/templates/${t.id}`),
    onSuccess: () => {
      setDeleting(undefined);
      qc.invalidateQueries({ queryKey: keys.templates(tenantId) });
    },
  });

  if (creating) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-6">
        <h2 className="mb-5 text-lg font-semibold text-fg">Novo modelo de mensagem</h2>
        <TemplateForm tenantId={tenantId} onDone={() => setCreating(false)} />
      </div>
    );
  }

  const list = (templates.data ?? []).filter((t) => t.status !== 'DELETED');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Modelos de mensagem (templates) precisam ser aprovados pela Meta antes do disparo.
        </p>
        <div className="flex flex-wrap gap-2">
          {can('templates.write') && (
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
              <IconRefresh className="size-4" /> Sincronizar com a Meta
            </Button>
          )}
          {can('templates.write') && (
            <Button onClick={() => setCreating(true)}>
              <IconPlus className="size-4" /> Novo modelo
            </Button>
          )}
        </div>
      </div>
      {sync.error && <ErrorAlert error={sync.error} />}
      {sync.data?.syncErrors?.length ? (
        <Alert tone="warn" title="Alguns modelos não puderam ser atualizados">
          {sync.data.syncErrors.map((e) => e.message).join(' · ')}
        </Alert>
      ) : sync.isSuccess ? (
        <Alert tone="ok">Lista atualizada com a Meta.</Alert>
      ) : null}

      {templates.isPending ? (
        <Loading />
      ) : templates.error ? (
        <ErrorAlert error={templates.error} retry={() => templates.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          title="Nenhum modelo ainda"
          description="Crie o primeiro modelo de mensagem. Se o cliente já tem modelos na conta dele, use “Sincronizar com a Meta” para trazê-los."
          action={
            can('templates.write') && (
              <Button size="lg" onClick={() => setCreating(true)}>
                <IconPlus className="size-4" /> Criar modelo
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {list.map((t) => (
            <TemplateCard
              key={t.id}
              t={t}
              onDelete={can('templates.delete') ? () => setDeleting(t) : undefined}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Excluir modelo?"
        message={
          <>
            O modelo <strong>{deleting?.name}</strong> será apagado também na conta do WhatsApp do
            cliente. Isso não pode ser desfeito.
          </>
        }
        confirmText="Excluir modelo"
        danger
        loading={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => {
          setDeleting(undefined);
          remove.reset();
        }}
      />
    </div>
  );
}
