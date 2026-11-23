import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { IconSend } from '../components/icons';
import { Alert, Button, Field, Input, Loading } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { consumeExpiredFlag, ME_KEY, useAuth } from '../lib/auth';
import type { LoginResponse } from '../lib/types';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string; otpauthUri?: string };

/** Chave do autenticador para digitar à mão (quando a câmera não lê o QR). */
function secretFromUri(uri: string): string | null {
  try {
    const s = new URL(uri).searchParams.get('secret');
    return s ? (s.match(/.{1,4}/g)?.join(' ') ?? s) : null;
  } catch {
    return null;
  }
}

function QrCode({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(undefined));
    return () => {
      alive = false;
    };
  }, [uri]);
  const secret = secretFromUri(uri);
  return (
    <div className="space-y-3">
      <div className="flex justify-center rounded-xl border border-line bg-white p-3">
        {src ? (
          <img src={src} alt="QR code para o app autenticador" width={220} height={220} />
        ) : (
          <div className="flex size-[220px] items-center justify-center">
            <Loading text="Gerando QR code…" />
          </div>
        )}
      </div>
      {secret && (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">Não consegue escanear? Digite a chave</summary>
          <p className="mt-2 rounded-lg bg-subtle px-3 py-2 font-mono text-xs tracking-wider text-fg">
            {secret}
          </p>
        </details>
      )}
    </div>
  );
}

export function LoginPage() {
  const { me, loading } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [expired] = useState(consumeExpiredFlag);
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (loading) return <Loading />;
  if (me && !busy) return <Navigate to={from && from !== '/login' ? from : '/'} replace />;

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const r = await api.post<LoginResponse>('/auth/login', { email, password });
      setPassword('');
      setCode('');
      setStep({ kind: 'code', challenge: r.challengeToken, otpauthUri: r.otpauthUri });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code') return;
    setError(undefined);
    setBusy(true);
    try {
      await api.post('/auth/totp', { challengeToken: step.challenge, code });
      await qc.refetchQueries({ queryKey: ME_KEY });
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'challenge_invalid') {
        setStep({ kind: 'password' });
        setError('O tempo para digitar o código acabou. Entre com a senha de novo.');
      } else {
        setError(errorMessage(err));
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-sm">
            <IconSend className="size-6" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-fg">BM Pública</h1>
            <p className="text-sm text-muted">Painel de disparos pela API oficial do WhatsApp</p>
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {expired && step.kind === 'password' && !error && (
            <Alert tone="warn">Sua sessão expirou. Entre novamente para continuar.</Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}

          {step.kind === 'password' ? (
            <form onSubmit={submitPassword} className="space-y-4">
              <Field label="E-mail" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Senha" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" size="lg" className="w-full" loading={busy}>
                Continuar
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4">
              {step.otpauthUri ? (
                <div className="space-y-3">
                  <h2 className="text-base font-semibold text-fg">
                    Primeiro acesso: configure o autenticador
                  </h2>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                    <li>
                      Abra o <strong className="text-fg">Google Authenticator</strong> ou o{' '}
                      <strong className="text-fg">Authy</strong> no celular.
                    </li>
                    <li>Toque em “adicionar” e escaneie o QR code abaixo.</li>
                    <li>Digite o código de 6 números que aparecer no app.</li>
                  </ol>
                  <QrCode uri={step.otpauthUri} />
                </div>
              ) : (
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-fg">Código do autenticador</h2>
                  <p className="text-sm text-muted">
                    Abra o app autenticador no celular e digite o código de 6 números.
                  </p>
                </div>
              )}
              <Field label="Código de 6 números" htmlFor="code">
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  autoFocus
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </Field>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={busy}
                disabled={code.length !== 6}
              >
                Entrar
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-muted hover:text-fg"
                onClick={() => {
                  setStep({ kind: 'password' });
                  setError(undefined);
                }}
              >
                Voltar
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
