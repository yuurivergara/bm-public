import { cx } from './ui';

/** Balão de mensagem para pré-visualizar o modelo (neutro, sem imitar a marca do WhatsApp). */
export function MessagePreview({
  header,
  body,
  footer,
  buttons = [],
  className,
}: {
  header?: string;
  body: string;
  footer?: string;
  buttons?: string[];
  className?: string;
}) {
  return (
    <div className={cx('rounded-2xl bg-subtle p-4', className)}>
      <div className="max-w-sm rounded-2xl rounded-tl-sm border border-line bg-surface px-3.5 py-2.5 text-sm shadow-xs">
        {header && <p className="mb-1 font-semibold text-fg">{header}</p>}
        <p className="whitespace-pre-wrap break-words text-fg">{body || '…'}</p>
        {footer && <p className="mt-1.5 text-xs text-muted">{footer}</p>}
        {buttons.length > 0 && (
          <div className="-mx-3.5 mt-2.5 divide-y divide-line border-t border-line">
            {buttons.map((b) => (
              <p key={b} className="py-2 text-center text-sm font-medium text-accent">
                {b}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
