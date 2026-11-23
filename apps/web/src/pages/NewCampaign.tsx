import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CampaignsUnavailable } from '../components/CampaignTable';
import { IconBack } from '../components/icons';
import { MessagePreview } from '../components/MessagePreview';
import {
  Alert,
  Button,
  buttonClass,
  Card,
  ChoiceCards,
  DefinitionList,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  StatusBadge,
  Steps,
} from '../components/ui';
import { api, errorMessage, isNotFound } from '../lib/api';
import { daysNeeded } from '../lib/campaigns';
import { formatDate, formatMaskedPhone, formatNumber, formatPhone, plural } from '../lib/format';
import { qualityRating, tenantStatus } from '../lib/labels';
import {
  connectedPhones,
  keys,
  tenantPath,
  useAllTenants,
  useAssets,
  useCapacity,
  useLists,
  useTemplates,
} from '../lib/queries';
import {
  bindingErrors,
  positionalVariables,
  renderTemplate,
  resolveBinding,
  templateBody,
  templateButtons,
  templateFooter,
  templateHeader,
} from '../lib/templates';
import type { Campaign, ListMember, Template, VariableBinding } from '../lib/types';

const STEPS = ['Cliente', 'Número', 'Lista', 'Modelo', 'Variáveis', 'Revisar'];

function NavButtons({
  onBack,
  onNext,
  nextDisabled,
  nextText = 'Continuar',
}: {
  onBack?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextText?: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      <Button size="lg" disabled={nextDisabled} onClick={onNext}>
        {nextText}
      </Button>
      {onBack && (
        <Button size="lg" variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      )}
    </div>
  );
}

export function NewCampaignPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tenants = useAllTenants();

  const [step, setStep] = useState(params.get('cliente') ? 1 : 0);
  const [tenantId, setTenantId] = useState(params.get('cliente') ?? '');
  const [phoneId, setPhoneId] = useState('');
  const [listId, setListId] = useState(params.get('lista') ?? '');
  const [templateId, setTemplateId] = useState('');
  const [bindings, setBindings] = useState<Record<string, VariableBinding>>({});
  const [sampleIdx, setSampleIdx] = useState(0);
  const [name, setName] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const enabled = !!tenantId;
  const assets = useAssets(tenantId, enabled);
  const capacity = useCapacity(tenantId, enabled);
  const lists = useLists(tenantId, enabled);
  const templates = useTemplates(tenantId, enabled);
  const members = useQuery({
    queryKey: ['members', tenantId, listId, 100],
    queryFn: () =>
      api
        .get<{ data: ListMember[] }>(`${tenantPath(tenantId)}/lists/${listId}/members`, {
          limit: 100,
        })
        .then((r) => r.data),
    enabled: !!tenantId && !!listId,
  });

  const tenant = tenants.data?.find((t) => t.id === tenantId);
  const assetPhones = connectedPhones(assets.data);
  const phones = useMemo(() => {
    if (capacity.data?.phoneNumbers.length) {
      return capacity.data.phoneNumbers.map((p) => {
        const a = assetPhones.find((x) => x.id === p.id);
        return {
          id: p.id,
          display: p.displayPhone,
          quality: p.qualityRating,
          wabaId: a?.wabaId,
          verifiedName: a?.verifiedName ?? null,
        };
      });
    }
    return assetPhones
      .filter((p) => p.status === 'connected')
      .map((p) => ({
        id: p.id,
        display: p.displayPhoneNumber ?? formatPhone(p.phoneE164),
        quality: p.qualityRating,
        wabaId: p.wabaId,
        verifiedName: p.verifiedName,
      }));
  }, [capacity.data, assetPhones]);
  const phone = phones.find((p) => p.id === phoneId);
  const list = lists.data?.find((l) => l.id === listId);
  const approved = (templates.data ?? []).filter(
    (t) => t.status === 'APPROVED' && (!phone?.wabaId || t.wabaId === phone.wabaId),
  );
  const template = approved.find((t) => t.id === templateId);
  const body = template ? templateBody(template) : '';
  const vars = positionalVariables(body);
  const attrKeys = useMemo(
    () => [...new Set((members.data ?? []).flatMap((m) => Object.keys(m.attributes ?? {})))].sort(),
    [members.data],
  );
  const withName = (members.data ?? []).filter((m) => m.name);
  const samples = withName.length ? withName : (members.data ?? []);
  const sample = samples.length ? samples[sampleIdx % samples.length] : undefined;
  const values = Object.fromEntries(vars.map((v) => [v, resolveBinding(bindings[v], sample)]));
  const bErrors = bindingErrors(vars, bindings);

  // seleção automática quando só há uma opção
  useEffect(() => {
    if (!phoneId && phones.length === 1 && phones[0]) setPhoneId(phones[0].id);
  }, [phones, phoneId]);
  // padrão das variáveis: {{1}} = nome (se a lista tiver nomes), as demais em branco
  useEffect(() => {
    if (!template) return;
    setBindings((prev) => {
      const next: Record<string, VariableBinding> = {};
      for (const v of positionalVariables(templateBody(template))) {
        next[v] =
          prev[v] ??
          (v === '1' && withName.length ? { source: 'name' } : { source: 'fixed', value: '' });
      }
      return next;
    });
  }, [template, withName.length]);
  useEffect(() => {
    if (template && list && !name) {
      setName(
        `${template.name} · ${list.name} · ${formatDate(new Date().toISOString())}`.slice(0, 120),
      );
    }
  }, [template, list, name]);

  const create = useMutation({
    mutationFn: async () => {
      const c = await api.post<Campaign>(`${tenantPath(tenantId)}/campaigns`, {
        name: name.trim(),
        listId,
        templateId,
        phoneNumberId: phoneId,
        variables: bindings,
      });
      try {
        await api.post<Campaign>(`${tenantPath(tenantId)}/campaigns/${c.id}/start`);
        return { campaign: c, startError: undefined as string | undefined };
      } catch (err) {
        return { campaign: c, startError: errorMessage(err) };
      }
    },
    onSuccess: ({ campaign, startError }) => {
      qc.invalidateQueries({ queryKey: keys.campaigns(tenantId) });
      navigate(`/disparos/${tenantId}/${campaign.id}`, { state: { startError } });
    },
  });

  const header = (
    <PageHeader
      back={
        <Link
          to="/disparos"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <IconBack className="size-4" /> Disparos
        </Link>
      }
      title="Novo disparo"
      description={
        tenant ? `Cliente: ${tenant.name}` : 'Siga os passos. Você revisa tudo antes de enviar.'
      }
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
        <ErrorAlert error={tenants.error} />
      </>
    );

  const changeTenant = (id: string) => {
    setTenantId(id);
    setPhoneId('');
    setListId('');
    setTemplateId('');
    setBindings({});
  };

  return (
    <div className="mx-auto max-w-3xl">
      {header}
      <Steps steps={STEPS} current={step} />

      {step === 0 && (
        <Card title="Para qual cliente é o disparo?">
          {tenants.data.length === 0 ? (
            <EmptyState
              title="Nenhum cliente cadastrado"
              action={
                <Link className={buttonClass()} to="/clientes">
                  Cadastrar cliente
                </Link>
              }
            />
          ) : (
            <>
              <Field label="Cliente" htmlFor="nc-tenant">
                <Select
                  id="nc-tenant"
                  value={tenantId}
                  onChange={(e) => changeTenant(e.target.value)}
                >
                  <option value="">Escolha o cliente…</option>
                  {tenants.data
                    .filter((t) => t.status !== 'offboarded')
                    .map((t) => (
                      <option key={t.id} value={t.id} disabled={t.status === 'paused'}>
                        {t.name}
                        {t.status !== 'active'
                          ? ` (${tenantStatus(t.status).text.toLowerCase()})`
                          : ''}
                      </option>
                    ))}
                </Select>
              </Field>
              <NavButtons nextDisabled={!tenantId} onNext={() => setStep(1)} />
            </>
          )}
        </Card>
      )}

      {step === 1 && (
        <Card title="Por qual número de WhatsApp enviar?">
          {assets.isPending || (capacity.isPending && !capacity.error) ? (
            <Loading />
          ) : isNotFound(capacity.error) && isNotFound(assets.error) ? (
            <CampaignsUnavailable />
          ) : phones.length === 0 ? (
            <Alert tone="warn" title="Este cliente ainda não tem número de WhatsApp conectado">
              <Link className="font-medium underline" to={`/clientes/${tenantId}/whatsapp`}>
                Conectar o WhatsApp do cliente
              </Link>
            </Alert>
          ) : (
            <ChoiceCards
              name="nc-phone"
              value={phoneId}
              onChange={setPhoneId}
              options={phones.map((p) => ({
                value: p.id,
                title: (
                  <span className="flex flex-wrap items-center gap-2">
                    {p.display}
                    <StatusBadge label={qualityRating(p.quality)} />
                  </span>
                ),
                description: p.verifiedName ?? undefined,
              }))}
            />
          )}
          <NavButtons onBack={() => setStep(0)} nextDisabled={!phoneId} onNext={() => setStep(2)} />
        </Card>
      )}

      {step === 2 && (
        <Card title="Para qual lista de contatos?">
          {lists.isPending ? (
            <Loading />
          ) : lists.error ? (
            <ErrorAlert error={lists.error} />
          ) : lists.data.filter((l) => l.size > 0).length === 0 ? (
            <EmptyState
              title="Nenhuma lista com contatos"
              description="Importe uma planilha para este cliente primeiro."
              action={
                <Link className={buttonClass()} to={`/clientes/${tenantId}/importar`}>
                  Importar planilha
                </Link>
              }
            />
          ) : (
            <ChoiceCards
              name="nc-list"
              value={listId}
              onChange={(id) => {
                setListId(id);
                setSampleIdx(0);
              }}
              options={lists.data
                .filter((l) => l.size > 0)
                .map((l) => ({
                  value: l.id,
                  title: l.name,
                  description: `${plural(l.size, 'contato')} · criada em ${formatDate(l.createdAt)}`,
                }))}
            />
          )}
          <NavButtons onBack={() => setStep(1)} nextDisabled={!list} onNext={() => setStep(3)} />
        </Card>
      )}

      {step === 3 && (
        <Card
          title="Qual mensagem enviar?"
          description="Só aparecem modelos já aprovados pela Meta."
        >
          {templates.isPending ? (
            <Loading />
          ) : templates.error ? (
            <ErrorAlert error={templates.error} />
          ) : approved.length === 0 ? (
            <EmptyState
              title="Nenhum modelo aprovado"
              description="Crie um modelo e aguarde a aprovação da Meta (ou sincronize se já foi aprovado)."
              action={
                <Link className={buttonClass()} to={`/clientes/${tenantId}/modelos`}>
                  Ver modelos do cliente
                </Link>
              }
            />
          ) : (
            <div className="space-y-3">
              {approved.map((t: Template) => (
                <label
                  key={t.id}
                  htmlFor={`nc-t-${t.id}`}
                  className={`block cursor-pointer rounded-xl border p-3.5 ${templateId === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle'}`}
                >
                  <span className="flex items-center gap-3">
                    <input
                      id={`nc-t-${t.id}`}
                      type="radio"
                      name="nc-template"
                      checked={templateId === t.id}
                      onChange={() => setTemplateId(t.id)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    <span className="font-medium text-fg">{t.name}</span>
                    <span className="text-xs text-muted">{t.language}</span>
                  </span>
                  <MessagePreview
                    className="mt-3"
                    header={templateHeader(t)}
                    body={templateBody(t)}
                    footer={templateFooter(t)}
                    buttons={templateButtons(t)}
                  />
                </label>
              ))}
            </div>
          )}
          <NavButtons
            onBack={() => setStep(2)}
            nextDisabled={!template}
            onNext={() => setStep(vars.length ? 4 : 5)}
          />
        </Card>
      )}

      {step === 4 && template && (
        <Card
          title="Preencha as partes variáveis"
          description="Escolha o que entra em cada {{número}} da mensagem."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-5">
              {vars.map((v) => {
                const b = bindings[v] ?? { source: 'fixed' as const, value: '' };
                const set = (nb: VariableBinding) => setBindings((all) => ({ ...all, [v]: nb }));
                return (
                  <fieldset key={v} className="space-y-2 rounded-xl border border-line p-3.5">
                    <legend className="px-1 text-sm font-semibold text-fg">{`{{${v}}}`}</legend>
                    <Select
                      aria-label={`O que vai em {{${v}}}`}
                      value={b.source}
                      onChange={(e) => {
                        const source = e.target.value as VariableBinding['source'];
                        set(
                          source === 'name'
                            ? { source }
                            : { source, value: source === 'attribute' ? (attrKeys[0] ?? '') : '' },
                        );
                      }}
                    >
                      <option value="name">Nome do contato</option>
                      <option value="attribute" disabled={attrKeys.length === 0}>
                        Coluna da planilha
                        {attrKeys.length === 0 ? ' (a lista não tem colunas extras)' : ''}
                      </option>
                      <option value="fixed">Texto fixo (igual para todos)</option>
                    </Select>
                    {b.source === 'attribute' && (
                      <Select
                        aria-label="Coluna da planilha"
                        value={b.value ?? ''}
                        onChange={(e) => set({ source: 'attribute', value: e.target.value })}
                      >
                        {attrKeys.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </Select>
                    )}
                    {b.source === 'fixed' && (
                      <Input
                        aria-label={`Texto fixo para {{${v}}}`}
                        placeholder="Ex.: 20% de desconto"
                        maxLength={1000}
                        value={b.value ?? ''}
                        onChange={(e) => set({ source: 'fixed', value: e.target.value })}
                      />
                    )}
                    {b.source === 'name' && withName.length === 0 && members.data && (
                      <p className="text-xs text-warn">
                        Os contatos desta lista não têm nome. Prefira um texto fixo.
                      </p>
                    )}
                    {showErrors && bErrors[v] && (
                      <p className="text-xs font-medium text-danger">{bErrors[v]}</p>
                    )}
                  </fieldset>
                );
              })}
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg">Como fica a mensagem</p>
              <MessagePreview
                header={templateHeader(template)}
                body={renderTemplate(body, values)}
                footer={templateFooter(template)}
                buttons={templateButtons(template)}
              />
              {sample ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>
                    Exemplo com o contato {sample.name ?? 'sem nome'} (
                    {formatMaskedPhone(sample.phoneMasked)})
                  </span>
                  {samples.length > 1 && (
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline"
                      onClick={() => setSampleIdx((i) => i + 1)}
                    >
                      Ver outro exemplo
                    </button>
                  )}
                </div>
              ) : members.isPending ? (
                <p className="text-xs text-muted">Carregando contatos de exemplo…</p>
              ) : null}
            </div>
          </div>
          <NavButtons
            onBack={() => setStep(3)}
            onNext={() => {
              setShowErrors(true);
              if (Object.keys(bErrors).length === 0) setStep(5);
            }}
          />
        </Card>
      )}

      {step === 5 && template && list && (
        <ReviewStep
          tenantName={tenant?.name ?? ''}
          phoneDisplay={phone?.display ?? '—'}
          listName={list.name}
          total={list.size}
          template={template}
          preview={renderTemplate(body, values)}
          capacity={capacity.data}
          capacityError={capacity.error}
          name={name}
          setName={setName}
          onBack={() => setStep(vars.length ? 4 : 3)}
          onSubmit={() => create.mutate()}
          submitting={create.isPending}
          error={create.error}
        />
      )}
    </div>
  );
}

function ReviewStep(props: {
  tenantName: string;
  phoneDisplay: string;
  listName: string;
  total: number;
  template: Template;
  preview: string;
  capacity?: { limit: number; available: number; used24h: number };
  capacityError: unknown;
  name: string;
  setName: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: unknown;
}) {
  const { capacity, total } = props;
  const days = capacity ? daysNeeded(total, capacity.available, capacity.limit) : undefined;
  return (
    <div className="space-y-6">
      <Card title="Revise antes de disparar">
        <DefinitionList
          items={[
            ['Cliente', props.tenantName],
            ['Número de envio', props.phoneDisplay],
            ['Lista', props.listName],
            ['Contatos na lista', formatNumber(total)],
            ['Modelo', props.template.name],
            [
              'Capacidade disponível hoje',
              capacity
                ? `${formatNumber(capacity.available)} de ${formatNumber(capacity.limit)} conversas`
                : 'Não informada',
            ],
          ]}
        />
        <div className="mt-5">
          <MessagePreview
            body={props.preview}
            header={templateHeader(props.template)}
            footer={templateFooter(props.template)}
            buttons={templateButtons(props.template)}
          />
        </div>
      </Card>

      {capacity && total > capacity.available && (
        <Alert tone="warn" title="Este envio vai levar mais de um dia">
          A lista tem {formatNumber(total)} contatos e hoje dá para enviar{' '}
          {formatNumber(Math.max(0, capacity.available))} (limite da Meta para este cliente).{' '}
          {days !== undefined && Number.isFinite(days) ? `Previsão: cerca de ${days} dias.` : ''}
        </Alert>
      )}
      {props.capacityError && !isNotFound(props.capacityError) ? (
        <ErrorAlert error={props.capacityError} />
      ) : null}

      <Card>
        <div className="space-y-4">
          <Field label="Nome do disparo" htmlFor="nc-name" hint="Só para vocês acharem depois.">
            <Input
              id="nc-name"
              maxLength={120}
              value={props.name}
              onChange={(e) => props.setName(e.target.value)}
            />
          </Field>
          {props.error ? <ErrorAlert error={props.error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              loading={props.submitting}
              disabled={!props.name.trim()}
              onClick={props.onSubmit}
            >
              Disparar agora para {plural(total, 'contato')}
            </Button>
            <Button size="lg" variant="ghost" onClick={props.onBack}>
              Voltar
            </Button>
          </div>
          <p className="text-xs text-muted">
            Contatos que pediram para sair são pulados automaticamente. Você pode pausar a qualquer
            momento.
          </p>
        </div>
      </Card>
    </div>
  );
}
