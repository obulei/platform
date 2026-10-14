import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import { can, useAuth } from '../auth.js';
import { Button, Card, EmptyState, ErrorNote, Input, Loading, Stat } from '../components.js';
import { classList, formatDate, formatMoney, formatTime, relativeDays, toDateInputValue } from '../utils.js';

/* ------------------------------------------------------------------ types
 * Mirrored from the exact shape returned by server/src/modules/dashboard.routes.ts
 * so a field rename on the server shows up as a compile error here. */

interface DashboardToday {
  date: string;
  appointments: number;
  completed: number;
  cancelled: number;
  noShows: number;
  newPatients: number;
  admissions: number;
  discharges: number;
}

interface DashboardOccupancy {
  beds: number;
  occupied: number;
  available: number;
  maintenance: number;
  rate: number;
}

interface DashboardWorkload {
  pendingLabOrders: number;
  urgentLabOrders: number;
  pendingPrescriptions: number;
  lowStockMedicines: number;
  draftInvoices: number;
  unpaidInvoiceTotal: number;
}

interface ClinicianLoad {
  id: string;
  fullName: string;
  specialty: string | null;
  booked: number;
  appointmentIds: string[];
}

interface ActivityEntry {
  id: string;
  action: string;
  entity: string;
  staffName: string | null;
  createdAt: string;
}

interface DashboardSnapshot {
  today: DashboardToday;
  occupancy: DashboardOccupancy;
  workload: DashboardWorkload;
  byClinician: ClinicianLoad[];
  recentActivity: ActivityEntry[];
}

interface OccupancyHistoryDay {
  date: string;
  occupied: number;
  capacity: number;
}

interface OccupancyHistory {
  days: number;
  capacity: number;
  items: OccupancyHistoryDay[];
}

/* ---------------------------------------------------------------- helpers */

/** Move a local YYYY-MM-DD by whole days without drifting across time zones. */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  base.setDate(base.getDate() + days);
  return toDateInputValue(base);
}

function daysFromToday(date: string): number {
  const target = new Date(`${date}T00:00:00`).getTime();
  const today = new Date(`${toDateInputValue()}T00:00:00`).getTime();
  return Math.round((target - today) / 86_400_000);
}

function weekday(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { weekday: 'short' });
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** A stat tile that doubles as a navigation shortcut into the matching module. */
function StatLink({
  to,
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  to: string;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  return (
    <NavLink to={to} style={{ textDecoration: 'none', color: 'inherit' }} title={`Open ${to}`}>
      <Stat label={label} value={value} hint={hint} tone={tone} />
    </NavLink>
  );
}

function Bar({
  fraction,
  color,
  height = 10,
  radius = 999
}: {
  fraction: number;
  color: string;
  height?: number;
  radius?: number | string;
}) {
  const clamped = Math.max(0, Math.min(100, fraction));
  return (
    <div
      style={{
        flex: 1,
        height,
        background: 'var(--border)',
        borderRadius: radius,
        overflow: 'hidden',
        minWidth: 80
      }}
    >
      <div
        style={{ width: `${clamped}%`, height: '100%', background: color, borderRadius: radius }}
        aria-hidden="true"
      />
    </div>
  );
}

/* ------------------------------------------------------------------- page */

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = can(user, []);

  const [date, setDate] = useState(() => toDateInputValue());
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [history, setHistory] = useState<OccupancyHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  /* The selected date is the operational day: changing it re-runs every query. */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const snapshot = await api<DashboardSnapshot>('/api/dashboard', { query: { date } });
        if (cancelled) return;
        setData(snapshot);
      } catch (caught) {
        if (!cancelled) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    (async () => {
      try {
        const trend = await api<OccupancyHistory>('/api/dashboard/occupancy-history', { query: { days: 7 } });
        if (cancelled) return;
        setHistory(trend);
        setHistoryError(null);
      } catch (caught) {
        if (!cancelled) setHistoryError(caught);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [date, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const head = (
    <div className="page-head">
      <div>
        <h2>Operational day</h2>
        <p>
          {formatDate(date)} · {relativeDays(daysFromToday(date))}
          {' · every panel below is scoped to this date'}
        </p>
      </div>
      <div className="toolbar">
        <Button size="sm" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
          ← Day
        </Button>
        <Input
          type="date"
          value={date}
          onChange={(event) => event.target.value && setDate(event.target.value)}
          aria-label="Operational date"
          style={{ width: 'auto' }}
        />
        <Button size="sm" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
          Day →
        </Button>
        <Button size="sm" variant="primary" onClick={() => setDate(toDateInputValue())}>
          Today
        </Button>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
          Refresh
        </Button>
      </div>
    </div>
  );

  if (isForbidden(error)) {
    return (
      <>
        {head}
        <Card title="Permission denied">
          <p className="muted">
            Your account cannot read the operational overview. Ask an administrator to review your role.
          </p>
        </Card>
      </>
    );
  }

  const today = data?.today;
  const occupancy = data?.occupancy;
  const workload = data?.workload;

  const body = data && today && occupancy && workload ? (
    <>
      {/* 1 — the day at a glance */}
      <div className="stat-grid">
        <StatLink to="/appointments" label="Appointments" value={today.appointments} hint={`On ${formatDate(today.date)}`} />
        <StatLink to="/appointments" label="Completed" value={today.completed} tone="success" hint="Seen and closed" />
        <StatLink
          to="/appointments"
          label="Cancelled / no-shows"
          value={`${today.cancelled} / ${today.noShows}`}
          tone={today.noShows > 0 ? 'warning' : 'neutral'}
          hint="Lost slots"
        />
        <StatLink to="/patients" label="New patients" value={today.newPatients} hint="Registered today" />
        <StatLink
          to="/wards"
          label="Current admissions"
          value={occupancy.occupied}
          tone={occupancy.rate >= 90 ? 'danger' : 'neutral'}
          hint={`${occupancy.rate}% of ${occupancy.beds} beds`}
        />
        <StatLink to="/wards" label="Discharges today" value={today.discharges} tone="success" hint="Beds freed" />
      </div>

      {/* 2 — bed occupancy now + the last 7 days of bed-days */}
      <div className="grid-2">
        <Card
          title="Bed occupancy"
          subtitle="Occupied beds come from open admissions, not from bed status"
          actions={
            <NavLink to="/wards" className="btn btn-sm">
              Ward board
            </NavLink>
          }
        >
          <div className="stack">
            <div className="row">
              <strong style={{ fontSize: 24 }}>{occupancy.occupied}</strong>
              <span className="muted">of {occupancy.beds} beds occupied</span>
              <span className="spacer" />
              <span className="mono">{occupancy.rate}%</span>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <Bar fraction={occupancy.rate} color="var(--danger)" height={14} radius="var(--radius-sm)" />
            </div>
            <div className="detail-list">
              <div className="detail-item">
                <span>Available</span>
                <strong>{occupancy.available}</strong>
              </div>
              <div className="detail-item">
                <span>Under maintenance</span>
                <strong>{occupancy.maintenance}</strong>
              </div>
              <div className="detail-item">
                <span>Occupied</span>
                <strong>{occupancy.occupied}</strong>
              </div>
              <div className="detail-item">
                <span>Admitted today</span>
                <strong>{today.admissions}</strong>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="Occupancy trend"
          subtitle="Bed-days occupied per day, oldest first · window ends on the current server day"
        >
          {historyError ? (
            <ErrorNote error={historyError} onDismiss={() => setHistoryError(null)} />
          ) : !history ? (
            <Loading label="Loading occupancy history…" />
          ) : !history.items.length ? (
            <EmptyState title="No occupancy history" hint="There are no admissions overlapping the last 7 days." />
          ) : (
            <div className="stack">
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                {history.items.map((item) => {
                  const pct = item.capacity > 0 ? (item.occupied / item.capacity) * 100 : 0;
                  return (
                    <div
                      key={item.date}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}
                      title={`${item.date}: ${item.occupied} of ${item.capacity} bed-days`}
                    >
                      <span className="mono subtle">{item.occupied}</span>
                      <div style={{ height: 120, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
                        <div
                          style={{
                            width: '100%',
                            maxWidth: 44,
                            height: `${Math.max(pct, 1.5)}%`,
                            background: pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--brand)',
                            borderRadius: '4px 4px 0 0'
                          }}
                        />
                      </div>
                      <span className="subtle nowrap">{weekday(item.date)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="subtle">
                Capacity is {history.capacity} beds across {history.days} days. Bar height is the share of beds held by an
                admission on that day.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* 3 — cross-department workload */}
      <Card
        title="Workload queue"
        subtitle="Everything still waiting on someone, right now"
        actions={
          <div className="card-actions">
            <NavLink to="/lab" className="btn btn-sm">
              Lab
            </NavLink>
            <NavLink to="/pharmacy" className="btn btn-sm">
              Pharmacy
            </NavLink>
            <NavLink to="/billing" className="btn btn-sm">
              Billing
            </NavLink>
          </div>
        }
      >
        <div className="stat-grid">
          <StatLink to="/lab" label="Pending lab orders" value={workload.pendingLabOrders} hint="Awaiting collection or result" />
          <StatLink
            to="/lab"
            label="Urgent lab orders"
            value={workload.urgentLabOrders}
            tone={workload.urgentLabOrders > 0 ? 'danger' : 'neutral'}
            hint={workload.urgentLabOrders > 0 ? 'Needs action now' : 'Nothing escalated'}
          />
          <StatLink to="/pharmacy" label="Pending prescriptions" value={workload.pendingPrescriptions} hint="Not dispensed yet" />
          <StatLink
            to="/pharmacy"
            label="Low-stock medicines"
            value={workload.lowStockMedicines}
            tone={workload.lowStockMedicines > 0 ? 'warning' : 'neutral'}
            hint={workload.lowStockMedicines > 0 ? 'At or under reorder level' : 'Stock levels healthy'}
          />
          <StatLink to="/billing" label="Draft invoices" value={workload.draftInvoices} hint="Not issued" />
          <StatLink
            to="/billing"
            label="Unpaid total"
            value={formatMoney(workload.unpaidInvoiceTotal)}
            tone={workload.unpaidInvoiceTotal > 0 ? 'warning' : 'success'}
            hint="Issued + partial, net of payments"
          />
        </div>
      </Card>

      {/* 4 — clinician load + activity feed */}
      <div className="split">
        <Card
          title={`Clinician bookings · ${formatDate(today.date)}`}
          subtitle="Bar length is relative to the busiest clinician on this day"
          actions={
            <NavLink to="/appointments" className="btn btn-sm">
              Schedule
            </NavLink>
          }
        >
          {!data.byClinician.length ? (
            <EmptyState title="No active clinicians" hint="No doctor accounts are marked active, so nothing can be booked." />
          ) : (
            <div className="stack">
              {(() => {
                const busiest = Math.max(...data.byClinician.map((clinician) => clinician.booked), 1);
                return data.byClinician.map((clinician) => (
                  <div key={clinician.id} className="row" style={{ gap: 12 }}>
                    <div style={{ width: 190, minWidth: 150 }}>
                      <div style={{ fontWeight: 600 }}>{clinician.fullName}</div>
                      <div className="subtle">{clinician.specialty ?? 'No specialty recorded'}</div>
                    </div>
                    <Bar
                      fraction={(clinician.booked / busiest) * 100}
                      color={clinician.booked === 0 ? 'var(--border-strong)' : 'var(--brand)'}
                    />
                    <span className="mono nowrap" style={{ width: 64, textAlign: 'right' }}>
                      {clinician.booked} booked
                    </span>
                  </div>
                ));
              })()}
            </div>
          )}
        </Card>

        <Card
          title="Recent activity"
          subtitle={isAdmin ? 'Click an entry to open it in the audit trail' : 'Latest logged actions'}
          actions={
            isAdmin ? (
              <NavLink to="/audit" className="btn btn-sm">
                Audit trail
              </NavLink>
            ) : undefined
          }
        >
          {!data.recentActivity.length ? (
            <EmptyState title="Nothing logged yet" hint="Actions appear here as soon as staff work in the system." />
          ) : (
            <div className="timeline">
              {data.recentActivity.map((entry) => (
                <div
                  key={entry.id}
                  className={classList('timeline-item', isAdmin && 'clickable')}
                  onClick={
                    isAdmin
                      ? () => navigate(`/audit?action=${encodeURIComponent(entry.action)}`)
                      : undefined
                  }
                >
                  <span className="timeline-when">{formatDate(entry.createdAt)}</span>
                  <div>
                    <div className="timeline-title">
                      <span className="mono">{entry.action}</span>
                      <span className="subtle">{entry.entity}</span>
                    </div>
                    <div className="timeline-body">
                      {entry.staffName ?? 'System'} · {formatTime(entry.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  ) : null;

  return (
    <>
      {head}
      {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
      {loading && !data ? <Loading label="Loading the operational day…" /> : null}
      {body}
      {!loading && !data && !error ? (
        <Card>
          <EmptyState title="No snapshot returned" hint="Use Refresh to try again." />
        </Card>
      ) : null}
    </>
  );
}
