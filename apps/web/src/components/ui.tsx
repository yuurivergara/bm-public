import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from 'react';
import { errorMessage } from '../lib/api';
import type { Label, Tone } from '../lib/labels';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ botões

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-subtle',
  ghost: 'text-fg hover:bg-subtle',
  danger: 'bg-danger text-white hover:opacity-90 shadow-sm dark:text-canvas',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

/** Classes de botão para links (<Link className={buttonClass('secondary')}>). */
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ formulários

const control =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-fg placeholder:text-muted/70 ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor: string;
  optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">(opcional)</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cx(control, 'h-10', invalid && 'border-danger', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Select({
  className,
  invalid,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cx(control, 'h-10 pr-8', invalid && 'border-danger', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(control, 'py-2 leading-relaxed', invalid && 'border-danger', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export function Checkbox({
  label,
  checked,
  onChange,
  description,
  id,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className="flex items-start gap-3">
      <input
        id={cid}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
      />
      <label htmlFor={cid} className="text-sm text-fg">
        {label}
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}

/** Grupo de opções grandes (cartões clicáveis) para escolhas em assistentes. */
export function ChoiceCards<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; title: ReactNode; description?: ReactNode; disabled?: boolean }[];
}) {
  return (
    <div className="grid gap-2">
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        const active = value === o.value;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className={cx(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors',
              active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-subtle',
              o.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={o.value}
              checked={active}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{o.title}</span>
              {o.description && (
                <span className="mt-0.5 block text-sm text-muted">{o.description}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ blocos

export function Card({
  children,
  className,
  title,
  actions,
  description,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="p-4 sm:p-5">{children}</div>}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-6 space-y-2">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

const TONES: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted border-line',
  ok: 'bg-ok-soft text-ok border-ok/20',
  warn: 'bg-warn-soft text-warn border-warn/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/20',
  accent: 'bg-accent-soft text-accent border-accent/25',
};
const DOTS: Record<Tone, string> = {
  neutral: 'bg-muted',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
      )}
    >
      <span className={cx('size-1.5 rounded-full', DOTS[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

export function StatusBadge({ label }: { label: Label }) {
  return (
    <span title={label.hint}>
      <Badge tone={label.tone}>{label.text}</Badge>
    </span>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-xl border px-4 py-3 text-sm', TONES[tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div className="text-fg/90">{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function ErrorAlert({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <Alert
      tone="danger"
      title={errorMessage(error)}
      action={
        retry && (
          <Button size="sm" variant="secondary" onClick={retry}>
            Tentar de novo
          </Button>
        )
      }
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block animate-spin rounded-full border-2 border-current border-r-transparent',
        className ?? 'size-5',
      )}
    />
  );
}

export function Loading({ text = 'Carregando…' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-muted" role="status">
      <Spinner />
      {text}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="text-base font-medium text-fg">{title}</p>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-3 w-full overflow-hidden rounded-full bg-subtle"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      aria-label={label}
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cx(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone && tone !== 'neutral' ? TONES[tone].split(' ')[1] : 'text-fg',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Lista de pares rótulo/valor. */
export function DefinitionList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lista estática
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{k}</dt>
          <dd className="mt-0.5 break-words text-sm text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Indicador de passos dos assistentes. */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li
            key={s}
            className="flex items-center gap-2"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span
              className={cx(
                'flex size-6 items-center justify-center rounded-full text-xs font-semibold',
                state === 'done' && 'bg-accent text-on-accent',
                state === 'current' && 'bg-accent-soft text-accent ring-2 ring-accent',
                state === 'todo' && 'bg-subtle text-muted',
              )}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className={cx(state === 'current' ? 'font-medium text-fg' : 'text-muted')}>
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ tabela responsiva

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  /** Some no cartão (mobile) — use para colunas redundantes. */
  hideOnCard?: boolean;
}

/** Tabela em telas médias/grandes; cartões empilhados no celular. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Texto acessível do botão de abrir (quando onRowClick existe). */
  rowLabel?: (row: T) => string;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-subtle/60 text-xs font-medium text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cx('px-4 py-2.5 font-medium', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={rowKey(r)} className={cx(onRowClick && 'hover:bg-subtle/70')}>
                {columns.map((c, i) => (
                  <td key={c.key} className={cx('px-4 py-3 align-middle', c.className)}>
                    {i === 0 && onRowClick ? (
                      <button
                        type="button"
                        className="text-left font-medium text-accent hover:underline"
                        aria-label={rowLabel?.(r)}
                        onClick={() => onRowClick(r)}
                      >
                        {c.render(r)}
                      </button>
                    ) : (
                      c.render(r)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => {
          const [first, ...others] = columns;
          return (
            <li key={rowKey(r)} className="rounded-xl border border-line bg-surface p-4">
              {onRowClick ? (
                <button
                  type="button"
                  className="text-left font-medium text-accent hover:underline"
                  onClick={() => onRowClick(r)}
                  aria-label={rowLabel?.(r)}
                >
                  {first?.render(r)}
                </button>
              ) : (
                <div className="font-medium text-fg">{first?.render(r)}</div>
              )}
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                {others
                  .filter((c) => !c.hideOnCard)
                  .map((c) => (
                    <div key={c.key} className="min-w-0">
                      {c.header && <dt className="text-xs text-muted">{c.header}</dt>}
                      <dd className="mt-0.5 break-words text-sm text-fg">{c.render(r)}</dd>
                    </div>
                  ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ diálogos

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40',
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="-m-1 rounded-md p-1 text-muted hover:bg-subtle hover:text-fg"
              aria-label="Fechar"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  danger,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmText: string;
  danger?: boolean;
  loading?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Voltar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg">
        <div>{message}</div>
        <ErrorAlert error={error} />
      </div>
    </Modal>
  );
}
