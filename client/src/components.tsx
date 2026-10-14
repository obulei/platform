import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { classList } from './utils';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={classList('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={classList('card-body', padded && 'padded')}>{children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={classList('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={classList('field', className)}>
      <span className="field-label">
        {label}
        {required && <span className="req"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

const controlClass = 'control';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classList(controlClass, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={classList(controlClass, className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={classList(controlClass, 'textarea', className)} {...rest} />;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  loading,
  empty = 'Nothing to show yet.',
  onRowClick
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  if (loading) return <Loading label="Loading…" />;
  if (!rows.length) return <EmptyState title="No records" hint={empty} />;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={column.width ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'clickable' : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.align === 'right' ? 'num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'clinical'];

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode;
  tone?: (typeof TONES)[number];
}) {
  return <span className={classList('badge', `badge-${tone}`)}>{children}</span>;
}

/** Maps the many status enums in this app onto one of six badge tones. */
const STATUS_TONE: Record<string, (typeof TONES)[number]> = {
  scheduled: 'info',
  confirmed: 'clinical',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
  admitted: 'warning',
  discharged: 'success',
  available: 'success',
  occupied: 'danger',
  maintenance: 'warning',
  pending: 'warning',
  collected: 'info',
  in_progress: 'clinical',
  partially_dispensed: 'info',
  dispensed: 'success',
  draft: 'neutral',
  issued: 'info',
  partial: 'warning',
  paid: 'success',
  void: 'danger',
  urgent: 'danger',
  routine: 'neutral',
  normal: 'success',
  abnormal: 'warning',
  critical: 'danger',
  active: 'success',
  inactive: 'neutral',
  deceased: 'danger'
};

export function statusTone(status: string): (typeof TONES)[number] {
  return STATUS_TONE[status] ?? 'neutral';
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function ErrorNote({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  const details = (error as { details?: { field: string; message: string }[] }).details;

  return (
    <div className="error-note" role="alert">
      <div>
        <strong>Could not complete that.</strong>
        <p>{message}</p>
        {details?.map((detail) => (
          <p key={`${detail.field}-${detail.message}`} className="error-detail">
            {detail.field}: {detail.message}
          </p>
        ))}
      </div>
      {onDismiss && (
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss message">
          Dismiss
        </Button>
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  return (
    <div className={classList('stat', `stat-${tone}`)}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'md'
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={classList('modal', `modal-${width}`)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            Close
          </Button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…'
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search">
      <svg viewBox="0 0 20 20" aria-hidden="true" className="search-icon">
        <path
          d="M8.5 3a5.5 5.5 0 1 0 3.4 9.83l3.44 3.44a1 1 0 0 0 1.42-1.42l-3.44-3.44A5.5 5.5 0 0 0 8.5 3Zm0 2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z"
          fill="currentColor"
        />
      </svg>
      <input
        className="control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value && (
        <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="Clear search">
          ×
        </button>
      )}
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const lastPage = Math.max(0, Math.ceil(total / limit) - 1);
  const page = Math.floor(offset / limit);
  if (total <= limit) return null;

  return (
    <div className="pager">
      <span>
        {page * limit + 1}–{Math.min(total, (page + 1) * limit)} of {total}
      </span>
      <div className="pager-buttons">
        <Button size="sm" disabled={page === 0} onClick={() => onChange(0)}>
          First
        </Button>
        <Button size="sm" disabled={page === 0} onClick={() => onChange(Math.max(0, (page - 1) * limit))}>
          Previous
        </Button>
        <Button
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onChange(Math.min(lastPage, page + 1) * limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={classList('tab', tab.id === active && 'is-active')}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
