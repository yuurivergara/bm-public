import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { IconRefresh } from '../../components/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  ErrorAlert,
  Field,
  Input,
  Loading,
  StatusBadge,
} from '../../components/ui';
import { api, fieldErrors } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatNumber, formatPhone } from '../../lib/format';
import { connectionStatus, phoneStatus, qualityRating } from '../../lib/labels';
import { keys, tenantPath, useAssets } from '../../lib/queries';
import type { Assets } from '../../lib/types';

const webhookUrl = () => `${window.location.origin}/webhooks/meta`;

function HelpBox() {
  return (
    <Alert tone="info" title="O que pedir ao cliente">
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        <li>
          No <strong>Meta Business Suite</strong> (Gerenciador de Negócios) do próprio cliente,
          criar um <strong>app</strong> no Meta for Developers ligado à empresa dele.
        </li>
        <li>
          Em <em>Configurações do negócio → Usuários do sistema</em>, criar um usuário do sistema,
          dar acesso à conta do WhatsApp e gerar um <strong>token</strong> com as permissões{' '}
          <code className="rounded bg-surface px-1">whatsapp_business_management</code> e{' '}
          <code className="rounded bg-surface px-1">whatsapp_business_messaging</code>.
        </li>
        <li>
          No app do cliente, em <em>WhatsApp → Configuração → Webhook</em>: URL de retorno{' '}
          <code className="rounded bg-surface px-1 break-all">{webhookUrl()}</code> e o token de
          verificação (peça ao Yuri). Depois, assinar os campos <code>messages</code>,{' '}
          <code>message_template_status_update</code> e <code>user_preferences</code>. É assim que
          chegam entregas, leituras e pedidos de descadastro.
        </li>
        <li>
          Enviar para você: o <strong>ID do negócio</strong>, o{' '}
          <strong>ID da conta do WhatsApp</strong> (WABA), o token, o <strong>ID do app</strong> e a{' '}
          <strong>Chave secreta do app</strong> (<em>Configurações do app → Básico</em>), por um
          canal seguro.
        </li>
      </ol>
      <p className="mt-2">
        Nunca peça login ou senha do Facebook do cliente. O token fica guardado cifrado e não é
        mostrado de novo.
      </p>
    </Alert>
  );
}

function ConnectForm({ tenantId, reconnect }: { tenantId: string; reconnect: boolean }) {
  const qc = useQueryClient();
  const [businessId, setBusinessId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const connect = useMutation({
    mutationFn: () =>
      api.post<Assets>(`${tenantPath(tenantId)}/assets/partner-share`, {
        businessId: businessId.trim(),
        wabaId: wabaId.trim(),
        accessToken: accessToken.trim(),
        // app próprio do cliente: os dois juntos (ou nenhum)
        ...(appId.trim() || appSecret.trim()
          ? { appId: appId.trim(), appSecret: appSecret.trim() }
          : {}),
      }),
    onSuccess: (data) => {
      setAccessToken('');
      setAppSecret('');
      qc.setQueryData(keys.assets(tenantId), data);
      qc.invalidateQueries({ queryKey: keys.tenantNumber(tenantId) });
    },
    onError: () => {
      setAccessToken('');
      setAppSecret('');
    },
  });
  const errs = fieldErrors(connect.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    connect.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4" autoComplete="off">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="ID do negócio (Business ID)"
          htmlFor="c-business"
          error={errs.businessId}
          hint="Só números."
        >
          <Input
            id="c-business"
            inputMode="numeric"
            required
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
          />
        </Field>
        <Field
          label="ID da conta do WhatsApp (WABA ID)"
          htmlFor="c-waba"
          error={errs.wabaId}
          hint="Só números."
        >
          <Input
            id="c-waba"
            inputMode="numeric"
            required
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Token de acesso"
        htmlFor="c-token"
        error={errs.accessToken}
        hint="Cole o token do usuário do sistema. Ele é guardado cifrado e nunca aparece de novo."
      >
        <Input
          id="c-token"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="ID do app do cliente"
          htmlFor="c-app"
          error={errs.appId}
          hint="Do app que gerou o token (Meta for Developers)."
        >
          <Input
            id="c-app"
            inputMode="numeric"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
        </Field>
        <Field
          label="Chave secreta do app"
          htmlFor="c-secret"
          error={errs.appSecret}
          hint="Configurações do app → Básico. Guardada cifrada; não aparece de novo."
        >
          <Input
            id="c-secret"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </Field>
      </div>
      {connect.error && <ErrorAlert error={connect.error} />}
      {connect.isSuccess && (
        <Alert tone="ok">Conta conectada. Os dados abaixo vieram da Meta agora.</Alert>
      )}
      <Button type="submit" size="lg" loading={connect.isPending}>
        {reconnect ? 'Atualizar conexão' : 'Conectar WhatsApp'}
      </Button>
    </form>
  );
}

export function ConnectionTab({ tenantId }: { tenantId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const assets = useAssets(tenantId);
  const [showForm, setShowForm] = useState(false);
  const sync = useMutation({
    mutationFn: () => api.post<Assets>(`${tenantPath(tenantId)}/assets/sync`),
    onSuccess: (data) => qc.setQueryData(keys.assets(tenantId), data),
  });

  if (assets.isPending) return <Loading />;
  if (assets.error) return <ErrorAlert error={assets.error} retry={() => assets.refetch()} />;
  const a = assets.data;
  const connected = a.portfolios.length > 0;
  const broken = a.connections.find((c) => c.status === 'broken');

  return (
    <div className="space-y-6">
      {broken && (
        <Alert tone="danger" title="O token deste cliente parou de funcionar">
          A Meta recusou o token (expirado ou revogado). Peça um novo token ao cliente e atualize a
          conexão.
        </Alert>
      )}
      {sync.data?.syncErrors?.length ? (
        <Alert tone="warn" title="A sincronização teve problemas">
          <ul className="list-disc pl-5">
            {sync.data.syncErrors.map((e) => (
              <li key={e.wabaId}>{e.message}</li>
            ))}
          </ul>
        </Alert>
      ) : sync.isSuccess ? (
        <Alert tone="ok">Dados atualizados com a Meta.</Alert>
      ) : null}
      {sync.error && <ErrorAlert error={sync.error} />}

      {connected ? (
        <>
          {a.portfolios.map((p) => (
            <Card
              key={p.id}
              title={p.name ?? 'Empresa na Meta'}
              description={`ID do negócio: ${p.metaBusinessId}`}
              actions={
                can('assets.write') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={sync.isPending}
                    onClick={() => sync.mutate()}
                  >
                    <IconRefresh className="size-4" /> Sincronizar
                  </Button>
                )
              }
            >
              <DefinitionList
                items={[
                  [
                    'Verificação da empresa',
                    p.verificationStatus === 'verified'
                      ? 'Verificada'
                      : (p.verificationStatus ?? '—'),
                  ],
                  [
                    'Limite diário de conversas',
                    p.messagingLimitValue
                      ? formatNumber(p.messagingLimitValue)
                      : (p.messagingLimitTier ?? '—'),
                  ],
                ]}
              />
              <div className="mt-5 space-y-4">
                {p.wabas.map((w) => (
                  <div key={w.id} className="rounded-xl border border-line p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-fg">
                          {w.name ?? 'Conta do WhatsApp'}
                        </p>
                        <p className="text-xs text-muted">WABA ID: {w.metaWabaId}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {w.accountReviewStatus && (
                          <Badge tone={w.accountReviewStatus === 'APPROVED' ? 'ok' : 'warn'}>
                            {w.accountReviewStatus === 'APPROVED'
                              ? 'Conta aprovada'
                              : `Revisão: ${w.accountReviewStatus}`}
                          </Badge>
                        )}
                        <Badge tone={w.webhooksSubscribed ? 'ok' : 'warn'}>
                          {w.webhooksSubscribed ? 'Recebendo avisos da Meta' : 'Sem avisos da Meta'}
                        </Badge>
                      </div>
                    </div>
                    {w.phoneNumbers.length === 0 ? (
                      <p className="mt-3 text-sm text-muted">Nenhum número nesta conta ainda.</p>
                    ) : (
                      <ul className="mt-3 divide-y divide-line">
                        {w.phoneNumbers.map((n) => (
                          <li
                            key={n.id}
                            className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                          >
                            <div>
                              <p className="text-sm font-medium text-fg">
                                {n.displayPhoneNumber ?? formatPhone(n.phoneE164)}
                              </p>
                              <p className="text-xs text-muted">
                                {n.verifiedName ?? 'Sem nome de exibição'}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <StatusBadge label={phoneStatus(n.status)} />
                              <StatusBadge label={qualityRating(n.qualityRating)} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <Card
            title="Token"
            description="Credencial usada para falar com a Meta em nome do cliente."
          >
            <ul className="space-y-2">
              {a.connections.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="text-muted">
                    Token terminado em <span className="font-mono text-fg">••••{c.tokenLast4}</span>{' '}
                    · validado em {formatDateTime(c.lastValidatedAt)}
                    {c.ownApp ? ` · app do cliente ${c.metaAppId ?? ''}` : ''}
                  </span>
                  <StatusBadge label={connectionStatus(c.status)} />
                </li>
              ))}
            </ul>
            {can('assets.write') && (
              <div className="mt-4">
                {showForm ? (
                  <div className="space-y-4">
                    <HelpBox />
                    <ConnectForm tenantId={tenantId} reconnect />
                  </div>
                ) : (
                  <Button variant="secondary" onClick={() => setShowForm(true)}>
                    Trocar token ou conectar outra conta
                  </Button>
                )}
              </div>
            )}
          </Card>
        </>
      ) : can('assets.write') ? (
        <Card
          title="Conectar o WhatsApp do cliente"
          description="Leva poucos minutos com os dados certos em mãos."
        >
          <div className="space-y-5">
            <HelpBox />
            <ConnectForm tenantId={tenantId} reconnect={false} />
          </div>
        </Card>
      ) : (
        <Alert tone="info">O WhatsApp deste cliente ainda não foi conectado.</Alert>
      )}
    </div>
  );
}
