import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, session } from '../api.js';
import { can, useAuth } from '../auth.js';
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Pager,
  SearchInput,
  Select,
  Table
} from '../components.js';
import type { Column } from '../components.js';
import { formatDateTime } from '../utils.js';
/* ------------------------------------------------------------------ types
 * Exactly the columns selected by `trailSelect()` in server/src/modules/audit.routes.ts. */

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  method: string | null;
  path: string | null;
  data: unknown;
  staffId: string | null;
  staffName: string | null;
  staffEmail: string | null;
  createdAt: string;
}

interface AuditListResult {
  items: AuditEntry[];
  total: number;
  offset: number;
  limit: number;
}

interface StaffOption {
  id: string;
  fullName: string;
  email: string;
}

/* Entities the server will accept in the `entity` filter. */
const ENTITIES = [
  'patient',
  'staff',
  'appointment',
  'admission',
  'note',
  'prescription',
  'medicine',
  'lab_order',
  'lab_result',
  'invoice',
  'payment'
] as const;

const PAGE_SIZE = 50;
const MAX_EXPORT_DAYS = 92;

interface Filters {
  q: string;
  entity: string;
  staffId: string;
  action: string;
  from: string;
  to: string;
}

function initialFilters(actionFromUrl: string | null): Filters {
  return { q: '', entity: '', staffId: '', action: actionFromUrl ?? '', from: '', to: '' };
}

/** Inclusive local-day bounds; the server coerces these with `new Date(...)`. */
function fromIso(date: string): string | undefined {
  return date ? `${date}T00:00:00` : undefined;
}

function toIso(date: string): string | undefined {
  return date ? `${date}T23:59:59.999` : undefined;
}

function windowDays(from: string, to: string): number | null {
  if (!from || !to) return null;
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T23:59:59.999`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(header ?? '');
  return match?.[1] ?? fallback;
}

function prettyPayload(data: unknown): string {
  try {
    return JSON.stringify(data ?? null, null, 2);
  } catch {
    return String(data);
  }
}

/* ------------------------------------------------------------------- page */

export function AuditPage() {
  const { user } = useAuth();
  const isAdmin = can(user, []);
  const [params] = useSearchParams();

  const [filters, setFilters] = useState<Filters>(() => initialFilters(params.get('action')));
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<AuditListResult | null>(null);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState<unknown>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [exportTruncated, setExportTruncated] = useState(false);

  /* One lookup so the "Staff" filter is a name picker rather than a uuid paste. */
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api<StaffOption[]>('/api/staff')
      .then((rows) => {
        if (!cancelled) setStaffOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setStaffOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const loadList = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const response = await api<AuditListResult>('/api/audit', {
        query: {
          q: filters.q.trim() || undefined,
          entity: filters.entity || undefined,
          staffId: filters.staffId || undefined,
          action: filters.action.trim() || undefined,
          from: fromIso(filters.from),
          to: toIso(filters.to),
          limit: PAGE_SIZE,
          offset
        }
      });
      setResult(response);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [filters, isAdmin, offset]);

  /* Debounced so typing a search term does not spam the trail (each read is logged). */
  useEffect(() => {
    if (!isAdmin) return;
    const handle = window.setTimeout(() => void loadList(), 300);
    return () => window.clearTimeout(handle);
  }, [loadList, isAdmin]);

  const update = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
    setOffset(0);
    setExportTruncated(false);
  };

  const days = windowDays(filters.from, filters.to);
  const windowTooWide = days !== null && days > MAX_EXPORT_DAYS;
  const windowInvalid = days !== null && days < 0;
  const exportReady = Boolean(filters.from && filters.to) && !windowTooWide && !windowInvalid && !exportBusy;

  async function exportCsv() {
    if (!exportReady) return;
    setExportBusy(true);
    setExportError(null);
    setExportTruncated(false);
    try {
      const query = new URLSearchParams({
        from: fromIso(filters.from) as string,
        to: toIso(filters.to) as string,
        format: 'csv'
      });
      const token = session.token();
      /* api() parses JSON, and a CSV must arrive as bytes — so this one call uses
         fetch directly with the bearer header, then hands the blob to the browser. */
      const response = await fetch(`/api/audit/export?${query.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new ApiError(payload?.message ?? `Export failed with status ${response.status}.`, response.status);
      }
      if (response.headers.get('X-Truncated') === 'true') setExportTruncated(true);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFromDisposition(
        response.headers.get('Content-Disposition'),
        `audit-${filters.from}-to-${filters.to}.csv`
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(caught);
    } finally {
      setExportBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <Card title="Administrator access only">
        <p className="muted">
          The audit trail is the compliance record for the whole hospital, so only administrators may read or export it.
        </p>
      </Card>
    );
  }

  const columns: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '170px',
      render: (row) => <span className="muted nowrap">{formatDateTime(row.createdAt)}</span>
    },
    {
      key: 'staff',
      header: 'Staff',
      width: '20%',
      render: (row) =>
        row.staffName ? (
          <div>
            <div>{row.staffName}</div>
            <div className="subtle">{row.staffEmail}</div>
          </div>
        ) : (
          <span className="subtle">System / unknown</span>
        )
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => <span className="mono">{row.action}</span>
    },
    { key: 'entity', header: 'Entity', render: (row) => <span className="nowrap">{row.entity}</span> },
    {
      key: 'entityId',
      header: 'Entity id',
      render: (row) => (row.entityId ? <span className="mono subtle">{row.entityId.slice(0, 8)}</span> : <span className="subtle">—</span>)
    },
    {
      key: 'data',
      header: 'Payload',
      width: '22%',
      render: (row) => (
        <span className="subtle">{expandedId === row.id ? 'Hide JSON' : 'Show JSON'}</span>
      )
    }
  ];

  const items = result?.items ?? [];
  const pageIsFull = !loading && items.length >= PAGE_SIZE;
  const isForbidden = error instanceof ApiError && error.status === 403;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Audit trail</h2>
          <p>
            Every logged mutation, newest first
            {result ? ` · ${result.total.toLocaleString()} matching entries` : ''}. Reading this list is itself recorded.
          </p>
        </div>
      </div>

      <Card title="Filters">
        <div className="stack">
          <div className="toolbar">
            <SearchInput value={filters.q} onChange={(value) => update({ q: value })} placeholder="Search action, entity or path…" />
            <Select value={filters.entity} onChange={(event) => update({ entity: event.target.value })} style={{ width: 170 }}>
              <option value="">All entities</option>
              {ENTITIES.map((entity) => (
                <option key={entity} value={entity}>
                  {entity.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <Select value={filters.staffId} onChange={(event) => update({ staffId: event.target.value })} style={{ width: 210 }}>
              <option value="">Any staff member</option>
              {staffOptions.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </Select>
          </div>

          <div className="form-grid form-grid-3">
            <Field label="Action pattern" hint="Wildcard supported with %, e.g. appointment.% or %.created">
              <Input
                value={filters.action}
                onChange={(event) => update({ action: event.target.value })}
                placeholder="appointment.%"
                className="mono"
              />
            </Field>
            <Field label="From (date)">
              <Input type="date" value={filters.from} onChange={(event) => update({ from: event.target.value })} />
            </Field>
            <Field label="To (date)">
              <Input type="date" value={filters.to} onChange={(event) => update({ to: event.target.value })} />
            </Field>
          </div>

          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => { setFilters(initialFilters(null)); setOffset(0); }}>
              Clear all filters
            </Button>
            <span className="spacer" />
            <span className="subtle">
              Export needs both dates and a window of at most {MAX_EXPORT_DAYS} days.
              {days !== null && ` Current window: ${days} day(s).`}
            </span>
            <Button variant="primary" onClick={exportCsv} disabled={!exportReady} loading={exportBusy}>
              Export CSV
            </Button>
          </div>

          {windowTooWide && (
            <div className="alert-strip danger">
              That window is {days} days. The server rejects exports longer than {MAX_EXPORT_DAYS} days — pick a narrower
              range.
            </div>
          )}
          {windowInvalid && <div className="alert-strip">The end date must be on or after the start date.</div>}
          <ErrorNote error={exportError} onDismiss={() => setExportError(null)} />

          {exportTruncated && (
            <div className="alert-strip danger">
              The export hit the server row cap, so the CSV is incomplete. Narrow the date range and export again.
            </div>
          )}
          {pageIsFull && (
            <div className="alert-strip">
              A full page of {PAGE_SIZE} entries was returned and more rows may exist. Page through, or narrow the date
              range and filters.
            </div>
          )}
        </div>
      </Card>

      {isForbidden ? (
        <Card title="Permission denied">
          <p className="muted">
            Your account is not allowed to read the audit trail. The session may have changed roles — sign out and back
            in.
          </p>
        </Card>
      ) : (
      <Card padded={false}>
        <div style={{ padding: 16, paddingBottom: 0 }}>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
        <Table
          columns={columns}
          rows={items}
          loading={loading}
          empty={
            filters.q || filters.entity || filters.staffId || filters.action || filters.from || filters.to
              ? 'No audit entries match these filters.'
              : 'The audit trail is empty.'
          }
          onRowClick={(row) => setExpandedId((current) => (current === row.id ? null : row.id))}
        />
        {expandedId &&
          (() => {
            const entry = items.find((row) => row.id === expandedId);
            if (!entry) return null;
            return (
              <div style={{ padding: '0 16px 16px' }}>
                <div className="stack stack-sm">
                  <div className="row">
                    <strong className="mono">{entry.action}</strong>
                    <span className="subtle">
                      {entry.method ?? '—'} {entry.path ?? ''}
                    </span>
                  </div>
                  {/* Rendered as text content, never innerHTML, so payload strings cannot execute. */}
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 12,
                      background: 'var(--surface-alt)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      maxHeight: 320,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}
                  >
                    {prettyPayload(entry.data)}
                  </pre>
                </div>
              </div>
            );
          })()}
        {!loading && items.length > 0 && result && (
          <Pager
            total={result.total}
            limit={result.limit || PAGE_SIZE}
            offset={result.offset}
            onChange={(next) => {
              setOffset(next);
              setExpandedId(null);
            }}
          />
        )}
      </Card>
      )}
    </>
  );
}
