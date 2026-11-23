import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconBack, IconFile, IconUpload } from '../components/icons';
import {
  Alert,
  Button,
  buttonClass,
  Card,
  Checkbox,
  ChoiceCards,
  ConfirmDialog,
  ErrorAlert,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Spinner,
  Stat,
  Steps,
  Textarea,
} from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { formatNumber, plural } from '../lib/format';
import {
  attributeKey,
  buildMapping,
  type ColumnChoice,
  decodeText,
  detectFormat,
  guessNameColumn,
  guessPhoneColumn,
  PROBE_MAPPING,
  previewFromText,
} from '../lib/importing';
import { LEGAL_BASIS_OPTIONS, ORIGIN_OPTIONS } from '../lib/labels';
import { keys, tenantPath, useTenant } from '../lib/queries';
import type { ContactImport } from '../lib/types';

const STEPS = ['Arquivo', 'Origem dos contatos', 'Colunas', 'Conferir', 'Pronto'];
const WORKING = new Set(['uploaded', 'parsing', 'confirming']);

type Origin = (typeof ORIGIN_OPTIONS)[number]['value'];
type Basis = (typeof LEGAL_BASIS_OPTIONS)[number]['value'];

interface Declaration {
  origin?: Origin;
  basis?: Basis;
  notes: string;
  accepted: boolean;
}

function baseForm(listName: string, d: Declaration, hasHeader: boolean) {
  const f = new FormData();
  // a API exige os campos ANTES do arquivo
  f.append('listName', listName.trim());
  f.append('originDeclaration', d.origin ?? '');
  f.append('legalBasis', d.basis ?? '');
  if (d.notes.trim()) f.append('declarationNotes', d.notes.trim());
  f.append('declarationAccepted', d.accepted ? 'true' : 'false');
  f.append('hasHeader', hasHeader ? 'true' : 'false');
  return f;
}

function FilePicker({ file, onFile }: { file: File | null; onFile: (f: File) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      htmlFor="imp-file"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-subtle'
      }`}
    >
      {file ? (
        <IconFile className="size-9 text-accent" />
      ) : (
        <IconUpload className="size-9 text-muted" />
      )}
      <span className="text-sm font-medium text-fg">
        {file ? file.name : 'Clique para escolher a planilha ou arraste o arquivo aqui'}
      </span>
      <span className="text-xs text-muted">
        {file
          ? `${(file.size / 1024 / 1024).toFixed(1)} MB · clique para trocar`
          : 'Aceita CSV, TXT ou Excel (.xlsx). Uma linha por contato.'}
      </span>
      <input
        id="imp-file"
        type="file"
        accept=".csv,.txt,.xlsx"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

/** Etapas 4 e 5: acompanha a análise, mostra a prévia e confirma. */
function ImportProgress({
  tenantId,
  importId,
  onRestart,
}: {
  tenantId: string;
  importId: string;
  onRestart: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [listName, setListName] = useState<string>();
  const [cancelOpen, setCancelOpen] = useState(false);
  const path = `${tenantPath(tenantId)}/imports/${importId}`;
  const imp = useQuery({
    queryKey: ['import', tenantId, importId],
    queryFn: () => api.get<ContactImport>(path),
    refetchInterval: (q) => (q.state.data && !WORKING.has(q.state.data.status) ? false : 1500),
  });
  const confirm = useMutation({
    mutationFn: () =>
      api.post<ContactImport>(`${path}/confirm`, listName ? { listName: listName.trim() } : {}),
    onSuccess: (d) => qc.setQueryData(['import', tenantId, importId], d),
  });
  const cancel = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.imports(tenantId) });
      navigate(`/clientes/${tenantId}/contatos`);
    },
  });
  const d = imp.data;
  useEffect(() => {
    if (d?.status === 'confirmed') {
      qc.invalidateQueries({ queryKey: keys.lists(tenantId) });
      qc.invalidateQueries({ queryKey: keys.imports(tenantId) });
    }
  }, [d?.status, qc, tenantId]);

  if (imp.isPending) return <Loading />;
  if (imp.error || !d) return <ErrorAlert error={imp.error} retry={() => imp.refetch()} />;

  const stepIdx = d.status === 'confirmed' ? 4 : 3;
  const header = <Steps steps={STEPS} current={stepIdx} />;

  if (d.status === 'uploaded' || d.status === 'parsing') {
    return (
      <>
        {header}
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Spinner className="size-8 text-accent" />
            <p className="font-medium text-fg">Analisando a planilha “{d.originalFilename}”…</p>
            <p className="max-w-md text-sm text-muted">
              Conferimos cada telefone, tiramos repetidos e quem já pediu para sair. Planilhas
              grandes podem levar alguns minutos. Pode sair desta tela: a análise continua.
            </p>
          </div>
        </Card>
      </>
    );
  }

  if (d.status === 'failed' || d.status === 'cancelled') {
    return (
      <>
        {header}
        <Alert
          tone={d.status === 'failed' ? 'danger' : 'info'}
          title={d.status === 'failed' ? 'Não foi possível ler a planilha' : 'Importação cancelada'}
        >
          {d.error ?? 'Confira o arquivo e tente de novo.'}
        </Alert>
        <div className="mt-4">
          <Button onClick={onRestart}>Importar outro arquivo</Button>
        </div>
      </>
    );
  }

  if (d.status === 'confirming') {
    return (
      <>
        {header}
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Spinner className="size-8 text-accent" />
            <p className="font-medium text-fg">Criando a lista “{d.listName}”…</p>
            <p className="text-sm text-muted">Isso leva poucos instantes.</p>
          </div>
        </Card>
      </>
    );
  }

  if (d.status === 'confirmed') {
    return (
      <>
        {header}
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-ok-soft text-2xl text-ok">
              ✓
            </span>
            <p className="text-lg font-semibold text-fg">Lista “{d.listName}” criada</p>
            <p className="text-sm text-muted">
              {plural(d.validCount ?? 0, 'contato pronto', 'contatos prontos')} para receber
              mensagens.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {d.listId && (
                <Link
                  className={buttonClass('primary', 'lg')}
                  to={`/disparos/novo?cliente=${tenantId}&lista=${d.listId}`}
                >
                  Fazer um disparo com esta lista
                </Link>
              )}
              <Link
                className={buttonClass('secondary', 'lg')}
                to={`/clientes/${tenantId}/contatos`}
              >
                Ver listas
              </Link>
            </div>
          </div>
        </Card>
      </>
    );
  }

  // preview
  const valid = d.validCount ?? 0;
  return (
    <>
      {header}
      <div className="space-y-6">
        <Card
          title="Confira o resultado"
          description={`Arquivo “${d.originalFilename}”: ${plural(d.rowCount ?? 0, 'linha')}.`}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Prontos para receber"
              value={formatNumber(valid)}
              tone="ok"
              hint={
                d.existingCount
                  ? `${formatNumber(d.existingCount)} já eram contatos do cliente`
                  : undefined
              }
            />
            <Stat
              label="Telefones inválidos"
              value={formatNumber(d.invalidCount)}
              tone={d.invalidCount ? 'danger' : undefined}
              hint="Ficam de fora"
            />
            <Stat
              label="Repetidos na planilha"
              value={formatNumber(d.duplicateCount)}
              hint="Contados uma vez só"
            />
            <Stat
              label="Pediram para sair"
              value={formatNumber(d.suppressedCount)}
              tone={d.suppressedCount ? 'warn' : undefined}
              hint="Nunca recebem mensagens"
            />
          </div>
          {(d.errorSample?.length ?? 0) > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-sm font-medium text-fg">Exemplos de linhas com problema</p>
              <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                {d.errorSample?.slice(0, 10).map((e) => (
                  <li key={e.row} className="flex gap-3 px-3 py-2">
                    <span className="w-20 shrink-0 text-muted">Linha {e.row}</span>
                    <span className="text-fg">{e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {valid === 0 ? (
          <Alert tone="danger" title="Nenhum telefone válido nesta planilha">
            Confira se escolheu a coluna certa de telefone e se os números têm DDD.
          </Alert>
        ) : (
          <Card title="Criar a lista">
            <div className="space-y-4">
              <Field label="Nome da lista" htmlFor="imp-confirm-name">
                <Input
                  id="imp-confirm-name"
                  value={listName ?? d.listName}
                  maxLength={120}
                  onChange={(e) => setListName(e.target.value)}
                />
              </Field>
              {confirm.error && <ErrorAlert error={confirm.error} />}
              <div className="flex flex-wrap gap-2">
                <Button size="lg" loading={confirm.isPending} onClick={() => confirm.mutate()}>
                  Confirmar e criar lista com {plural(valid, 'contato')}
                </Button>
                <Button size="lg" variant="ghost" onClick={() => setCancelOpen(true)}>
                  Cancelar importação
                </Button>
              </div>
            </div>
          </Card>
        )}
        {valid === 0 && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Descartar e tentar outro arquivo
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={cancelOpen}
        title="Cancelar importação?"
        message="Nenhum contato desta planilha será salvo."
        confirmText="Cancelar importação"
        danger
        loading={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelOpen(false)}
      />
    </>
  );
}

export function ImportWizardPage() {
  const { tenantId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tenant = useTenant(tenantId);
  const importId = params.get('importacao');

  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [listName, setListName] = useState('');
  const [decl, setDecl] = useState<Declaration>({ notes: '', accepted: false });
  const [hasHeader, setHasHeader] = useState(true);
  const [rawColumns, setRawColumns] = useState<string[]>([]);
  const [sampleText, setSampleText] = useState<string>();
  const [choice, setChoice] = useState<ColumnChoice>({ phone: -1, name: -1, extras: [] });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const format = file ? detectFormat(file.name) : undefined;
  const preview = sampleText !== undefined ? previewFromText(sampleText, hasHeader) : undefined;
  const columns =
    preview?.columns ?? (hasHeader ? rawColumns : rawColumns.map((_, i) => `coluna ${i + 1}`));

  function restart() {
    setParams({});
    setStep(0);
    setFile(null);
    setRawColumns([]);
    setSampleText(undefined);
    setError(undefined);
  }

  if (tenant.isPending) return <Loading />;
  if (tenant.error) return <ErrorAlert error={tenant.error} />;

  const back = (
    <Link
      to={`/clientes/${tenantId}/contatos`}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <IconBack className="size-4" /> {tenant.data.name}
    </Link>
  );
  const page = (children: ReactNode) => (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        back={back}
        title="Importar planilha de contatos"
        description={`Cliente: ${tenant.data.name}`}
      />
      {children}
    </div>
  );

  if (importId)
    return page(<ImportProgress tenantId={tenantId} importId={importId} onRestart={restart} />);

  function pickFile(f: File) {
    setError(undefined);
    if (!detectFormat(f.name)) {
      setError('Formato não aceito. Use .csv, .txt ou .xlsx (Excel).');
      return;
    }
    setFile(f);
    setHasHeader(detectFormat(f.name) !== 'txt');
    if (!listName) setListName(f.name.replace(/\.[^.]+$/, '').slice(0, 120));
  }

  /** Lê as colunas: CSV/TXT no navegador; XLSX pela API (resposta 422 com as colunas). */
  async function detectColumns() {
    if (!file || !format) return;
    setBusy(true);
    setError(undefined);
    try {
      let cols: string[];
      if (format === 'xlsx') {
        const f = baseForm(listName, decl, true);
        f.append('mapping', JSON.stringify(PROBE_MAPPING));
        f.append('file', file);
        try {
          const r = await api.upload<ContactImport>(`${tenantPath(tenantId)}/imports`, f);
          // improvável (planilha com 999.999 colunas): descarta a importação de teste
          await api.del(`${tenantPath(tenantId)}/imports/${r.id}`).catch(() => undefined);
          cols = r.columns ?? [];
        } catch (err) {
          const details =
            err instanceof ApiError
              ? (err.details as { columns?: string[] } | undefined)
              : undefined;
          if (!(err instanceof ApiError && err.code === 'mapping_required' && details?.columns))
            throw err;
          cols = details.columns;
        }
        setSampleText(undefined);
        setRawColumns(cols);
      } else {
        const text = decodeText(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
        setSampleText(text);
        cols = previewFromText(text, hasHeader).columns;
        setRawColumns(cols);
      }
      const phone = guessPhoneColumn(cols);
      const name = guessNameColumn(cols, phone);
      setChoice({
        phone,
        name,
        extras: cols.map((_, i) => i).filter((i) => i !== phone && i !== name),
      });
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const f = baseForm(listName, decl, hasHeader);
      f.append('mapping', JSON.stringify(buildMapping(columns, choice)));
      f.append('file', file);
      const r = await api.upload<ContactImport>(`${tenantPath(tenantId)}/imports`, f);
      setParams({ importacao: r.id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const declOk =
    !!decl.origin &&
    !!decl.basis &&
    decl.accepted &&
    (decl.origin !== 'other' || decl.notes.trim().length > 0);
  const takenKeys = new Set<string>();

  return page(
    <>
      <Steps steps={STEPS} current={step} />
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {step === 0 && (
        <Card>
          <div className="space-y-5">
            <FilePicker file={file} onFile={pickFile} />
            <Field
              label="Nome da lista"
              htmlFor="imp-name"
              hint="Para achar depois. Ex.: Clientes loja centro – novembro"
            >
              <Input
                id="imp-name"
                maxLength={120}
                value={listName}
                onChange={(e) => setListName(e.target.value)}
              />
            </Field>
            <Button size="lg" disabled={!file || !listName.trim()} onClick={() => setStep(1)}>
              Continuar
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card
          title="De onde vieram estes contatos?"
          description="A lei (LGPD) exige saber a origem. Essa declaração fica registrada junto com a lista."
        >
          <div className="space-y-6">
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-fg">Origem</legend>
              <ChoiceCards
                name="origin"
                value={decl.origin}
                onChange={(origin) => setDecl((d) => ({ ...d, origin }))}
                options={ORIGIN_OPTIONS.map((o) => ({ value: o.value, title: o.text }))}
              />
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-fg">
                Por que o cliente pode mandar mensagem para eles?
              </legend>
              <ChoiceCards
                name="basis"
                value={decl.basis}
                onChange={(basis) => setDecl((d) => ({ ...d, basis }))}
                options={LEGAL_BASIS_OPTIONS.map((o) => ({ value: o.value, title: o.text }))}
              />
            </fieldset>
            <Field
              label="Detalhes"
              htmlFor="imp-notes"
              optional={decl.origin !== 'other'}
              hint="Ex.: cadastro no site em 2025, com caixa de aceite."
            >
              <Textarea
                id="imp-notes"
                rows={2}
                maxLength={2000}
                value={decl.notes}
                onChange={(e) => setDecl((d) => ({ ...d, notes: e.target.value }))}
              />
            </Field>
            <div className="rounded-xl border border-line bg-subtle p-4">
              <Checkbox
                checked={decl.accepted}
                onChange={(accepted) => setDecl((d) => ({ ...d, accepted }))}
                label="Declaro que estes contatos foram obtidos pelo cliente de forma legítima, com a base legal indicada acima."
                description="Quem pedir para sair será bloqueado para sempre e nunca mais receberá mensagens deste cliente."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={!declOk} loading={busy} onClick={detectColumns}>
                Continuar
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setStep(0)}>
                Voltar
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="Quais colunas usar?"
          description="Conferimos o começo da planilha. Ajuste se algo estiver errado."
        >
          <div className="space-y-5">
            <Checkbox
              checked={hasHeader}
              onChange={setHasHeader}
              label="A primeira linha tem os nomes das colunas (cabeçalho)"
            />
            {preview && preview.sample.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="bg-subtle text-muted">
                    <tr>
                      {columns.map((c, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: colunas podem repetir nome
                        <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {preview.sample.map((row, r) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: amostra estática
                      <tr key={r}>
                        {columns.map((_, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: amostra estática
                          <td key={i} className="px-3 py-2 whitespace-nowrap text-fg">
                            {row[i] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Coluna do telefone"
                htmlFor="imp-phone"
                error={choice.phone < 0 ? 'Escolha a coluna com os telefones.' : undefined}
              >
                <Select
                  id="imp-phone"
                  value={choice.phone}
                  onChange={(e) => {
                    const phone = Number(e.target.value);
                    setChoice((c) => ({
                      ...c,
                      phone,
                      extras: c.extras.filter((x) => x !== phone),
                    }));
                  }}
                >
                  <option value={-1}>Escolha…</option>
                  {columns.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: índice é o valor
                    <option key={i} value={i}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Coluna do nome"
                htmlFor="imp-cname"
                optional
                hint="Usada para personalizar a mensagem (“Olá, Ana”)."
              >
                <Select
                  id="imp-cname"
                  value={choice.name}
                  onChange={(e) => {
                    const name = Number(e.target.value);
                    setChoice((c) => ({ ...c, name, extras: c.extras.filter((x) => x !== name) }));
                  }}
                >
                  <option value={-1}>Sem nome</option>
                  {columns.map((c, i) =>
                    i === choice.phone ? null : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: índice é o valor
                      <option key={i} value={i}>
                        {c}
                      </option>
                    ),
                  )}
                </Select>
              </Field>
            </div>
            {columns.length > 2 && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-fg">
                  Outras colunas para usar nas mensagens
                </legend>
                <p className="text-xs text-muted">
                  Marque o que pode entrar no texto do disparo (ex.: cidade, produto, data de
                  vencimento).
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {columns.map((c, i) => {
                    if (i === choice.phone || i === choice.name) return null;
                    const key = attributeKey(c, takenKeys);
                    takenKeys.add(key);
                    return (
                      <Checkbox
                        // biome-ignore lint/suspicious/noArrayIndexKey: índice é a identidade da coluna
                        key={i}
                        checked={choice.extras.includes(i)}
                        onChange={(on) =>
                          setChoice((ch) => ({
                            ...ch,
                            extras: on ? [...ch.extras, i] : ch.extras.filter((x) => x !== i),
                          }))
                        }
                        label={c}
                        description={`Fica disponível como “${key}”`}
                      />
                    );
                  })}
                </div>
              </fieldset>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={choice.phone < 0} loading={busy} onClick={upload}>
                Enviar e analisar
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setStep(1)}>
                Voltar
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>,
  );
}
