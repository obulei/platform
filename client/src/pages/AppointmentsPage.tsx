import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { can, useAuth } from '../auth.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  Modal,
  SearchInput,
  Select,
  StatusBadge,
  Stat,
  Table,
  Tabs,
  Textarea,
  type Column
} from '../components.js';
import {
  classList,
  combineDateAndTime,
  formatDateTime,
  formatMoney,
  formatTime,
  relativeDays,
  timeRangeOptions,
  toDateInputValue
} from '../utils.js';

// ---------------------------------------------------------------- types (from the server contract)

type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';

/** GET /api/appointments item — toDto() plus patientMrn. */
interface Appointment {
  id: string;
  patientId: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  reason: string;
  notes: string | null;
  fee: number | null;
  patientName?: string;
  patientMrn?: string;
  clinicianName?: string;
  clinicianSpecialty?: string;
}

/** GET /api/appointments/schedule item. */
interface ScheduleClinician {
  id: string;
  fullName: string;
  specialty: string | null;
  consultationFee: number;
  booked: number;
}

/** GET /api/staff/bookable item. */
interface BookableStaff {
  id: string;
  fullName: string;
  roles: string[];
  specialty: string | null;
  department: string | null;
  consultationFee: number;
}

/** Patient row as returned by GET /api/patients (subset we render). */
interface PatientOption {
  id: string;
  mrn: string;
  fullName: string;
  age?: number | null;
  status?: string;
}

type BoardView = 'board' | 'list';

const OPEN_STATUSES: AppointmentStatus[] = ['scheduled', 'confirmed'];
const DURATIONS = [15, 20, 30, 45, 60];
const STATUS_FILTERS: { value: AppointmentStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-shows' }
];

// ---------------------------------------------------------------- helpers

/** Local-midnight-safe day shift for the date input. */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toDateInputValue(d);
}

function daysFromToday(date: string): number {
  const base = new Date(`${date}T00:00:00`).getTime();
  const today = new Date(`${toDateInputValue()}T00:00:00`).getTime();
  return Math.round((base - today) / 86_400_000);
}

function dayHeading(date: string): string {
  const weekday = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
  const rel = relativeDays(daysFromToday(date));
  return `${weekday} · ${rel}`;
}

/** Add minutes to a local `YYYY-MM-DD` + `HH:MM` pair and keep them local. */
function addMinutes(date: string, time: string, minutes: number): string {
  const start = new Date(combineDateAndTime(date, time));
  const end = new Date(start.getTime() + minutes * 60_000);
  const hh = String(end.getHours()).padStart(2, '0');
  const mm = String(end.getMinutes()).padStart(2, '0');
  return `${toDateInputValue(end)}T${hh}:${mm}:00`;
}

function startOf(a: Appointment): number {
  return new Date(a.startsAt).getTime();
}

function overlaps(a: Appointment, fromMs: number, toMs: number): boolean {
  return new Date(a.startsAt).getTime() < toMs && new Date(a.endsAt).getTime() > fromMs;
}

/**
 * First grid time after `time` on `date` where neither the clinician nor the
 * patient already holds an open booking for the requested duration.
 */
function suggestNextStart(
  appointments: Appointment[],
  staffId: string,
  patientId: string | null,
  date: string,
  time: string,
  duration: number
): string | null {
  const times = timeRangeOptions();
  const from = times.indexOf(time);
  const blockers = appointments.filter(
    (a) =>
      OPEN_STATUSES.includes(a.status) &&
      toDateInputValue(new Date(a.startsAt)) === date &&
      (a.staffId === staffId || (!!patientId && a.patientId === patientId))
  );
  for (let i = Math.max(from, -1) + 1; i < times.length; i += 1) {
    const candidate = times[i];
    const start = new Date(combineDateAndTime(date, candidate));
    const end = new Date(start.getTime() + duration * 60_000);
    if (toDateInputValue(end) !== date) break; // past the last slot of the day
    if (!blockers.some((a) => overlaps(a, start.getTime(), end.getTime()))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------- page

export function AppointmentsPage() {
  const { user } = useAuth();
  const canWrite = can(user, ['reception', 'doctor', 'nurse']);

  const [date, setDate] = useState(() => toDateInputValue());
  const [view, setView] = useState<BoardView>('board');
  const [clinicians, setClinicians] = useState<ScheduleClinician[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [bookable, setBookable] = useState<BookableStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [boardError, setBoardError] = useState<unknown>(null);
  const [forbidden, setForbidden] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | ''>('');
  const [clinicianFilter, setClinicianFilter] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setBoardError(null);
    setForbidden(false);
    try {
      const [schedule, appts, staff] = await Promise.all([
        api<ScheduleClinician[]>('/api/appointments/schedule', { query: { date } }),
        api<Appointment[]>('/api/appointments', { query: { date, limit: 500 } }),
        api<BookableStaff[]>('/api/staff/bookable', { query: { role: 'doctor' } })
      ]);
      setClinicians(schedule);
      setAppointments(appts);
      setBookable(staff);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setForbidden(true);
      } else {
        setBoardError(error);
      }
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = useMemo(
    () => appointments.find((a) => a.id === selectedId) ?? null,
    [appointments, selectedId]
  );

  const summary = useMemo(() => {
    const count = (status: AppointmentStatus) => appointments.filter((a) => a.status === status).length;
    return {
      total: appointments.length,
      confirmed: count('confirmed'),
      completed: count('completed'),
      cancelled: count('cancelled'),
      noShow: count('no_show')
    };
  }, [appointments]);

  const appointmentsByClinician = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appointment of appointments) {
      const list = map.get(appointment.staffId) ?? [];
      list.push(appointment);
      map.set(appointment.staffId, list);
    }
    for (const list of map.values()) list.sort((a, b) => startOf(a) - startOf(b));
    return map;
  }, [appointments]);

  // Clinicians the schedule endpoint knows about, plus anyone who has a
  // booking today but is missing from the schedule (e.g. deactivated staff),
  // so the board never hides appointments.
  const columns = useMemo(() => {
    const seen = new Set<string>();
    const built: (ScheduleClinician & { appointments: Appointment[] })[] = clinicians.map((c) => {
      seen.add(c.id);
      return { ...c, appointments: appointmentsByClinician.get(c.id) ?? [] };
    });
    for (const [staffId, list] of appointmentsByClinician) {
      if (seen.has(staffId)) continue;
      const first = list[0];
      built.push({
        id: staffId,
        fullName: first?.clinicianName ?? 'Unknown clinician',
        specialty: first?.clinicianSpecialty ?? null,
        consultationFee: 0,
        booked: 0,
        appointments: list
      });
    }
    return built;
  }, [clinicians, appointmentsByClinician]);

  const filteredList = useMemo(
    () =>
      appointments.filter(
        (a) =>
          (!statusFilter || a.status === statusFilter) &&
          (!clinicianFilter || a.staffId === clinicianFilter)
      ),
    [appointments, statusFilter, clinicianFilter]
  );

  if (forbidden) {
    return (
      <div className="page">
        <Card title="Not available for your role">
          <EmptyState
            title="Appointments are restricted"
            hint="Your account is not allowed to view the appointment board. Ask an administrator if you need access."
          />
        </Card>
      </div>
    );
  }

  const listColumns: Column<Appointment>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '150px',
      render: (row) => (
        <span className="mono nowrap">
          {formatTime(row.startsAt)} – {formatTime(row.endsAt)}
        </span>
      )
    },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <div className="stack stack-sm">
          <span>{row.patientName ?? '—'}</span>
          <span className="mono subtle">{row.patientMrn}</span>
        </div>
      )
    },
    {
      key: 'clinician',
      header: 'Clinician',
      render: (row) => (
        <div className="stack stack-sm">
          <span>{row.clinicianName ?? '—'}</span>
          {row.clinicianSpecialty && <span className="subtle">{row.clinicianSpecialty}</span>}
        </div>
      )
    },
    { key: 'reason', header: 'Reason', render: (row) => <span className="muted">{row.reason}</span> },
    { key: 'status', header: 'Status', width: '120px', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'fee',
      header: 'Fee',
      align: 'right',
      width: '110px',
      render: (row) => (row.fee === null ? '—' : formatMoney(row.fee))
    }
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Appointments — day board</h2>
          <p>{dayHeading(date)}</p>
        </div>
        <div className="toolbar">
          <Button size="sm" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
            ◀
          </Button>
          <Input
            type="date"
            value={date}
            onChange={(event) => event.target.value && setDate(event.target.value)}
            aria-label="Board date"
          />
          <Button size="sm" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
            ▶
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDate(toDateInputValue())}>
            Today
          </Button>
          {canWrite && (
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              New appointment
            </Button>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Booked" value={summary.total} hint={`for ${dayHeading(date)}`} />
        <Stat label="Confirmed" value={summary.confirmed} tone="success" />
        <Stat label="Completed" value={summary.completed} />
        <Stat label="Cancelled" value={summary.cancelled} tone="warning" />
        <Stat label="No-shows" value={summary.noShow} tone="danger" />
      </div>

      <ErrorNote error={boardError} onDismiss={() => setBoardError(null)} />

      <Tabs<BoardView>
        tabs={[
          { id: 'board', label: 'Board', count: columns.length },
          { id: 'list', label: 'List', count: appointments.length }
        ]}
        active={view}
        onChange={setView}
      />

      {loading ? (
        <Loading label="Loading the day…" />
      ) : view === 'board' ? (
        columns.length === 0 ? (
          <EmptyState title="No clinicians on the schedule" hint="No active doctors or nurses to book against." />
        ) : (
          <div className="day-grid">
            {columns.map((column) => (
              <ClinicianColumn
                key={column.id}
                clinician={column}
                onSelect={(appointment) => setSelectedId(appointment.id)}
              />
            ))}
          </div>
        )
      ) : (
        <Card
          title="All appointments"
          subtitle={`${filteredList.length} of ${appointments.length} shown`}
          padded={false}
          actions={
            <div className="toolbar">
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as AppointmentStatus | '')}
                aria-label="Filter by status"
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Select
                value={clinicianFilter}
                onChange={(event) => setClinicianFilter(event.target.value)}
                aria-label="Filter by clinician"
              >
                <option value="">All clinicians</option>
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.fullName}
                  </option>
                ))}
              </Select>
            </div>
          }
        >
          <Table
            columns={listColumns}
            rows={filteredList}
            empty="No appointments match these filters on this day."
            onRowClick={(row) => setSelectedId(row.id)}
          />
        </Card>
      )}

      {newOpen && (
        <NewAppointmentModal
          defaultDate={date}
          bookable={bookable}
          existing={appointments}
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            setNewOpen(false);
            void reload();
          }}
        />
      )}

      {selected && (
        <AppointmentDetailModal
          appointment={selected}
          clinicians={columns.map(({ id, fullName }) => ({ id, fullName }))}
          canWrite={canWrite}
          existing={appointments}
          onClose={() => setSelectedId(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- board column

function ClinicianColumn({
  clinician,
  onSelect
}: {
  clinician: ScheduleClinician & { appointments: Appointment[] };
  onSelect: (appointment: Appointment) => void;
}) {
  return (
    <div className="clinician-col">
      <div className="clinician-col-head">
        <div className="stack stack-sm">
          <strong>{clinician.fullName}</strong>
          <span className="subtle">
            {clinician.specialty ?? '—'} · {formatMoney(clinician.consultationFee)}
          </span>
        </div>
        <Badge tone={clinician.booked > 0 ? 'info' : 'neutral'}>{clinician.booked} booked</Badge>
      </div>
      {clinician.appointments.length === 0 ? (
        <EmptyState title="No bookings" hint="This clinician is free all day." />
      ) : (
        clinician.appointments.map((appointment) => {
          const done = appointment.status === 'completed' || appointment.status === 'cancelled';
          return (
            <div
              key={appointment.id}
              className={classList('slot', done && 'slot-done')}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(appointment)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(appointment);
                }
              }}
            >
              <span className="slot-time">
                {formatTime(appointment.startsAt)} – {formatTime(appointment.endsAt)}
              </span>
              <span className="slot-patient">
                {appointment.patientName ?? 'Patient'}{' '}
                <span className="mono subtle">{appointment.patientMrn}</span>
              </span>
              <span className="slot-reason">{appointment.reason}</span>
              <StatusBadge status={appointment.status} />
            </div>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------- patient picker

function PatientPicker({
  patient,
  onSelect
}: {
  patient: PatientOption | null;
  onSelect: (patient: PatientOption | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError(null);
    const timer = window.setTimeout(() => {
      api<{ items: PatientOption[] }>('/api/patients', { query: { q: term, limit: 8 } })
        .then((page) => {
          if (!cancelled) setResults(page.items);
        })
        .catch((caught) => {
          if (!cancelled) setError(caught);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (patient) {
    return (
      <div className="row">
        <span>
          <strong>{patient.fullName}</strong> <span className="mono subtle">{patient.mrn}</span>
          {patient.age != null && <span className="subtle"> · {patient.age} yrs</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="stack stack-sm">
      <SearchInput value={query} onChange={setQuery} placeholder="Search patient by name, MRN or phone…" />
      {searching && <span className="subtle">Searching…</span>}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {!searching && query.trim().length >= 2 && results.length === 0 && !error && (
        <span className="subtle">No patients match “{query.trim()}”.</span>
      )}
      {results.map((option) => (
        <button
          key={option.id}
          type="button"
          className="btn btn-secondary"
          style={{ justifyContent: 'flex-start' }}
          onClick={() => onSelect(option)}
        >
          <span>{option.fullName}</span>
          <span className="mono subtle">{option.mrn}</span>
          {option.age != null && <span className="subtle">{option.age} yrs</span>}
          {option.status && option.status !== 'active' && <Badge tone="warning">{option.status}</Badge>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- new appointment modal

function NewAppointmentModal({
  defaultDate,
  bookable,
  existing,
  onClose,
  onCreated
}: {
  defaultDate: string;
  bookable: BookableStaff[];
  existing: Appointment[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [staffId, setStaffId] = useState(bookable[0]?.id ?? '');
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(30);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'scheduled' | 'confirmed'>('scheduled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const times = useMemo(() => timeRangeOptions(), []);
  const canSubmit = !!patient && !!staffId && reason.trim().length >= 3;

  async function submit() {
    if (!patient || !staffId || !canSubmit) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setSuggestion(null);
    try {
      await api<Appointment>('/api/appointments', {
        method: 'POST',
        body: {
          patientId: patient.id,
          staffId,
          startsAt: combineDateAndTime(date, time),
          endsAt: addMinutes(date, time, duration),
          reason: reason.trim(),
          notes: notes.trim() ? notes.trim() : null,
          status
        }
      });
      onCreated();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // Keep the form and everything typed intact; surface the exact
        // server-written conflict plus a computed way out of it.
        setConflict(caught);
        setSuggestion(suggestNextStart(existing, staffId, patient.id, date, time, duration));
      } else {
        setError(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New appointment"
      subtitle="Overlaps are refused by the server — the board refreshes on success."
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Discard
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
            Book appointment
          </Button>
        </>
      }
    >
      <Field label="Patient" required hint="Search by name, MRN or phone — pick the right person.">
        <PatientPicker patient={patient} onSelect={setPatient} />
      </Field>

      <div className="form-grid">
        <Field label="Clinician" required>
          <Select value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            {bookable.length === 0 && <option value="">No bookable clinicians</option>}
            {bookable.map((staff) => (
              <option key={staff.id} value={staff.id}>
                {staff.fullName}
                {staff.specialty ? ` — ${staff.specialty}` : ''} · {formatMoney(staff.consultationFee)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(event) => setStatus(event.target.value as 'scheduled' | 'confirmed')}>
            <option value="scheduled">Scheduled</option>
            <option value="confirmed">Confirmed</option>
          </Select>
        </Field>
        <Field label="Date" required>
          <Input type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
        </Field>
        <Field label="Start time" required>
          <Select value={time} onChange={(event) => setTime(event.target.value)}>
            {times.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Duration" required>
          <Select value={String(duration)} onChange={(event) => setDuration(Number(event.target.value))}>
            {DURATIONS.map((option) => (
              <option key={option} value={option}>
                {option} minutes
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ends at">
          <Input readOnly value={formatDateTime(addMinutes(date, time, duration))} />
        </Field>
      </div>

      <Field label="Reason" required hint="At least 3 characters — visible on the board.">
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} />
      </Field>
      <Field label="Notes">
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
      </Field>

      {conflict && (
        <div className="stack stack-sm">
          <ErrorNote error={conflict} onDismiss={() => setConflict(null)} />
          {suggestion ? (
            <div className="banner">
              Next free slot for this clinician and patient: <strong className="mono">{suggestion}</strong>{' '}
              <Button
                size="sm"
                onClick={() => {
                  setTime(suggestion);
                  setConflict(null);
                  setSuggestion(null);
                }}
              >
                Use {suggestion}
              </Button>
            </div>
          ) : (
            <p className="subtle">No later slot on this date is free for that clinician — try another day or clinician.</p>
          )}
        </div>
      )}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- detail modal

function AppointmentDetailModal({
  appointment,
  clinicians,
  canWrite,
  existing,
  onClose,
  onChanged
}: {
  appointment: Appointment;
  clinicians: { id: string; fullName: string }[];
  canWrite: boolean;
  existing: Appointment[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const durationMinutes = Math.max(
    5,
    Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000)
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const rescheduleOpen = OPEN_STATUSES.includes(appointment.status);
  const apptDate = toDateInputValue(new Date(appointment.startsAt));
  const apptTime = `${String(new Date(appointment.startsAt).getHours()).padStart(2, '0')}:${String(
    new Date(appointment.startsAt).getMinutes()
  ).padStart(2, '0')}`;
  const [resDate, setResDate] = useState(apptDate);
  const [resTime, setResTime] = useState(apptTime);
  const [resStaffId, setResStaffId] = useState(appointment.staffId);
  const [resConflict, setResConflict] = useState<ApiError | null>(null);
  const [resSuggestion, setResSuggestion] = useState<string | null>(null);

  const times = useMemo(() => {
    const options = timeRangeOptions();
    return options.includes(apptTime) ? options : [...options, apptTime].sort();
  }, [apptTime]);

  const staffChoices = useMemo(() => {
    const map = new Map(clinicians.map((c) => [c.id, c.fullName]));
    if (appointment.clinicianName) map.set(appointment.staffId, appointment.clinicianName);
    return [...map.entries()];
  }, [clinicians, appointment.staffId, appointment.clinicianName]);

  async function patchStatus(status: AppointmentStatus, reason?: string) {
    setBusy(status);
    setError(null);
    try {
      await api<Appointment>(`/api/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        body: { status, ...(reason ? { cancelReason: reason } : {}) }
      });
      setCancelling(false);
      setCancelReason('');
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setError(caught);
      else setError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function reschedule() {
    setBusy('reschedule');
    setError(null);
    setResConflict(null);
    setResSuggestion(null);
    try {
      await api<Appointment>(`/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        body: {
          startsAt: combineDateAndTime(resDate, resTime),
          endsAt: addMinutes(resDate, resTime, durationMinutes),
          staffId: resStaffId !== appointment.staffId ? resStaffId : undefined
        }
      });
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setResConflict(caught);
        setResSuggestion(
          suggestNextStart(existing, resStaffId, appointment.patientId, resDate, resTime, durationMinutes)
        );
      } else {
        setError(caught);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Appointment details"
      subtitle={
        <span className="row nowrap">
          {appointment.patientName ?? 'Patient'}{' '}
          <span className="mono subtle">{appointment.patientMrn}</span>
          <StatusBadge status={appointment.status} />
        </span>
      }
      onClose={onClose}
      footer={
        canWrite && (
          <>
            <span className="spacer" />
            {appointment.status === 'scheduled' && (
              <Button
                variant="secondary"
                loading={busy === 'confirmed'}
                onClick={() => void patchStatus('confirmed')}
              >
                Confirm
              </Button>
            )}
            {OPEN_STATUSES.includes(appointment.status) && (
              <>
                <Button
                  variant="primary"
                  loading={busy === 'completed'}
                  onClick={() => void patchStatus('completed')}
                >
                  Complete
                </Button>
                {!cancelling && (
                  <Button variant="danger" onClick={() => setCancelling(true)}>
                    Cancel
                  </Button>
                )}
              </>
            )}
          </>
        )
      }
    >
      <div className="detail-list">
        <div className="detail-item">
          <span>When</span>
          <strong>
            {formatDateTime(appointment.startsAt)} – {formatTime(appointment.endsAt)}
          </strong>
        </div>
        <div className="detail-item">
          <span>Clinician</span>
          <strong>
            {appointment.clinicianName ?? '—'}
            {appointment.clinicianSpecialty ? ` · ${appointment.clinicianSpecialty}` : ''}
          </strong>
        </div>
        <div className="detail-item">
          <span>Consultation fee</span>
          <strong>{appointment.fee === null ? '—' : formatMoney(appointment.fee)}</strong>
        </div>
        <div className="detail-item">
          <span>Patient ID</span>
          <strong className="mono">{appointment.patientId}</strong>
        </div>
        <div className="detail-item">
          <span>Reason</span>
          <strong>{appointment.reason}</strong>
        </div>
        <div className="detail-item">
          <span>Notes</span>
          <strong>{appointment.notes || '—'}</strong>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {cancelling && (
        <div className="stack stack-sm">
          <Field label="Cancellation reason" required hint="Recorded on the appointment and shown after reload.">
            <Textarea
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              maxLength={300}
              placeholder="Patient called in — clinician away…"
            />
          </Field>
          <div className="row">
            <Button variant="ghost" size="sm" onClick={() => setCancelling(false)}>
              Never mind
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'cancelled'}
              disabled={cancelReason.trim().length === 0}
              onClick={() => void patchStatus('cancelled', cancelReason.trim())}
            >
              Confirm cancellation
            </Button>
          </div>
        </div>
      )}

      {canWrite && rescheduleOpen && (
        <Card title="Reschedule" subtitle="Move this still-open appointment to another time or clinician.">
          <div className="form-grid form-grid-3">
            <Field label="New date" required>
              <Input type="date" value={resDate} onChange={(event) => event.target.value && setResDate(event.target.value)} />
            </Field>
            <Field label="New start" required>
              <Select value={resTime} onChange={(event) => setResTime(event.target.value)}>
                {times.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="New clinician" required>
              <Select value={resStaffId} onChange={(event) => setResStaffId(event.target.value)}>
                {staffChoices.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="row">
            <span className="subtle">
              {durationMinutes}-minute appointment · now {formatDateTime(appointment.startsAt)}
            </span>
            <span className="spacer" />
            <Button size="sm" variant="secondary" loading={busy === 'reschedule'} onClick={() => void reschedule()}>
              Apply reschedule
            </Button>
          </div>
          {resConflict && (
            <div className="stack stack-sm">
              <ErrorNote error={resConflict} />
              {resSuggestion && (
                <div className="banner">
                  Next free slot: <strong className="mono">{resSuggestion}</strong>{' '}
                  <Button
                    size="sm"
                    onClick={() => {
                      setResTime(resSuggestion);
                      setResConflict(null);
                      setResSuggestion(null);
                    }}
                  >
                    Use {resSuggestion}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </Modal>
  );
}
