import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
  Pager,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Textarea,
  type Column
} from '../components.js';
import { api, ApiError, type SessionUser } from '../api.js';
import { can, useAuth } from '../auth.js';
import { classList, formatDate, formatDateTime, relativeDays } from '../utils.js';

/* ------------------------------------------------------------------ *
 * Server contract types — mirrored field-for-field from
 * server/src/modules/inpatient.routes.ts
 * ------------------------------------------------------------------ */

/** GET /api/wards — per-ward counts are derived from open admissions only. */
interface Ward {
  id: string;
  name: string;
  unitType: string;
  floor: number;
  isActive: boolean;
  totalBeds: number;
  occupiedBeds: number;
  maintenanceBeds: number;
  availableBeds: number;
  occupancyRate: number;
}

/**
 * GET /api/wards/:id/beds. `status` is only ever 'available' | 'maintenance';
 * occupancy comes from `occupied` (an open admission holding the bed).
 */
interface Bed {
  id: string;
  label: string;
  status: 'available' | 'maintenance';
  occupied: boolean;
  admissionId: string | null;
  admittedAt: string | null;
  patient: { id: string; mrn: string; name: string } | null;
  attendingName: string | null;
}

/** The shared admission projection returned by every /api/admissions route. */
interface Admission {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  wardId: string;
  wardName: string | null;
  bedId: string | null;
  bedLabel: string | null;
  attendingStaffId: string | null;
  attendingName: string | null;
  status: 'admitted' | 'discharged';
  admittingComplaint: string;
  diagnosis: string | null;
  dischargeSummary: string | null;
  admittedAt: string;
  dischargedAt: string | null;
}

const NOTE_TYPES = ['progress', 'consultation', 'nursing', 'procedure', 'discharge'] as const;
type NoteType = (typeof NOTE_TYPES)[number];

interface ClinicalNote {
  id: string;
  type: NoteType;
  content: string;
  createdAt: string;
  authorId: string | null;
  author: string | null;
}

interface Vital {
  id: string;
  patientId: string;
  admissionId: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
  temperatureC: number | null;
  pulse: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  weightKg: number | null;
  heightCm: number | null;
  recordedAt: string;
}

/** notes/vitals are only present for clinical roles; detect the missing keys. */
interface AdmissionDetail extends Admission {
  notes?: ClinicalNote[];
  vitals?: Vital[];
}

interface PatientHit {
  id: string;
  mrn: string;
  fullName: string;
  birthDate: string | null;
  age: number | null;
  gender: string | null;
  bloodGroup: string | null;
  status: string;
}

interface BookableStaff {
  id: string;
  fullName: string;
  roles: string[];
  specialty: string | null;
  department: string | null;
}

interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 20;

const UNIT_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'clinical'> = {
  icu: 'danger',
  coronary: 'warning',
  emergency: 'warning',
  isolation: 'danger',
  pediatric: 'info',
  maternity: 'info',
  surgical: 'clinical',
  general: 'neutral'
};

function occupancyTone(rate: number): 'neutral' | 'warning' | 'danger' {
  if (rate > 95) return 'danger';
  if (rate > 85) return 'warning';
  return 'neutral';
}

function isFree(bed: Bed): boolean {
  return !bed.occupied && bed.status === 'available';
}

/** "2 days" — the thing a nurse reads off the board for every occupied bed. */
function lengthOfStay(iso: string | null, now: number): string {
  if (!iso) return '—';
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return '—';
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function daysAgo(iso: string | null, now: number): string {
  if (!iso) return '';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  return relativeDays(-Math.max(0, Math.round((now - at) / 86_400_000)));
}

const VITAL_LABELS = {
  temperatureC: 'Temperature (°C)',
  pulse: 'Pulse (bpm)',
  respiratoryRate: 'Respiratory rate (/min)',
  spo2: 'SpO₂ (%)',
  bpSystolic: 'Systolic BP (mmHg)',
  bpDiastolic: 'Diastolic BP (mmHg)',
  weightKg: 'Weight (kg)',
  heightCm: 'Height (cm)'
} as const;

const VITAL_RANGES = {
  temperatureC: '25 – 45',
  pulse: '10 – 300',
  respiratoryRate: '5 – 80',
  spo2: '0 – 100',
  bpSystolic: '40 – 300',
  bpDiastolic: '20 – 200',
  weightKg: '0.5 – 400',
  heightCm: '20 – 272'
} as const;

type VitalKey = keyof typeof VITAL_LABELS;
const VITAL_KEYS = Object.keys(VITAL_LABELS) as VitalKey[];

type VitalForm = Record<VitalKey, string>;

const EMPTY_VITAL_FORM: VitalForm = {
  temperatureC: '',
  pulse: '',
  respiratoryRate: '',
  spo2: '',
  bpSystolic: '',
  bpDiastolic: '',
  weightKg: '',
  heightCm: ''
};

function isBlank(raw: string): boolean {
  return raw.trim() === '';
}

function toNumber(raw: string): number {
  return Number(raw.trim());
}

function isConflict(caught: unknown): boolean {
  return caught instanceof ApiError && (caught.status === 409 || caught.code === 'conflict');
}

function isForbidden(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 403;
}

/* ------------------------------------------------------------------ *
 * Bed options shared by the admit form and the transfer form: occupied
 * and maintenance beds stay visible but disabled, so the nurse sees why
 * a bed cannot be picked.
 * ------------------------------------------------------------------ */

function BedOptions({ beds }: { beds: Bed[] }) {
  return (
    <>
      <option value="">No bed yet — ward holding</option>
      {beds.map((bed) =>
        isFree(bed) ? (
          <option key={bed.id} value={bed.id}>
            {bed.label} — free
          </option>
        ) : (
          <option key={bed.id} value={bed.id} disabled>
            {bed.label} — {bed.occupied ? `occupied · ${bed.patient?.name ?? 'active admission'}` : 'maintenance'}
          </option>
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Bed tile
 * ------------------------------------------------------------------ */

function BedTile({
  bed,
  now,
  canAdmit,
  onOpen,
  onAdmit
}: {
  bed: Bed;
  now: number;
  canAdmit: boolean;
  onOpen: (admissionId: string) => void;
  onAdmit: (bedId: string) => void;
}) {
  const state = bed.occupied ? 'occupied' : bed.status === 'maintenance' ? 'maintenance' : 'available';

  return (
    <button
      type="button"
      className={classList('bed', state === 'occupied' && 'bed-occupied', state === 'maintenance' && 'bed-maintenance')}
      disabled={state === 'maintenance' || (state === 'available' && !canAdmit)}
      title={
        state === 'occupied'
          ? 'Open admission'
          : state === 'available'
            ? canAdmit
              ? 'Admit a patient to this bed'
              : 'Your role can view but not admit'
            : 'Bed under maintenance'
      }
      onClick={() => {
        if (state === 'occupied' && bed.admissionId) onOpen(bed.admissionId);
        else if (state === 'available' && canAdmit) onAdmit(bed.id);
      }}
    >
      <span className="bed-label">
        {bed.label}
        <span className={classList('dot', `dot-${state}`)} aria-hidden="true" />
      </span>
      {state === 'occupied' && (
        <>
          <span className="bed-patient">{bed.patient?.name ?? 'Occupied'}</span>
          <span className="bed-meta mono">{bed.patient?.mrn ?? '—'}</span>
          <span className="bed-meta">{lengthOfStay(bed.admittedAt, now)} admitted</span>
          {bed.attendingName && <span className="bed-meta">{bed.attendingName}</span>}
        </>
      )}
      {state === 'available' && <span className="bed-meta">{canAdmit ? 'Free · tap to admit' : 'Free'}</span>}
      {state === 'maintenance' && <span className="bed-meta">Under maintenance</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Admit modal
 * ------------------------------------------------------------------ */

function AdmitModal({
  wards,
  initial,
  onClose,
  onAdmitted
}: {
  wards: Ward[];
  initial: { wardId: string; bedId?: string };
  onClose: () => void;
  onAdmitted: () => void;
}) {
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);

  const [wardId, setWardId] = useState(initial.wardId);
  const [bedId, setBedId] = useState(initial.bedId ?? '');
  const [beds, setBeds] = useState<Bed[]>([]);
  const [bedsLoading, setBedsLoading] = useState(false);
  const [bedsError, setBedsError] = useState<unknown>(null);

  const [doctors, setDoctors] = useState<BookableStaff[]>([]);
  const [doctorsError, setDoctorsError] = useState<unknown>(null);
  const [attending, setAttending] = useState('');
  const [complaint, setComplaint] = useState('');
  const [diagnosis, setDiagnosis] = useState('');

  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<BookableStaff[]>('/api/staff/bookable', { query: { role: 'doctor' } })
      .then((rows) => !cancelled && setDoctors(rows))
      .catch((caught) => !cancelled && setDoctorsError(caught));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<Page<PatientHit>>('/api/patients', { query: { q: term, limit: 8, status: 'active' } })
        .then((page) => !cancelled && setResults(page.items))
        .catch((caught) => !cancelled && setSearchError(caught))
        .finally(() => !cancelled && setSearching(false));
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const loadBeds = useCallback(async (ward: string) => {
    if (!ward) {
      setBeds([]);
      return;
    }
    setBedsLoading(true);
    try {
      setBeds(await api<Bed[]>(`/api/wards/${ward}/beds`));
      setBedsError(null);
    } catch (caught) {
      setBedsError(caught);
    } finally {
      setBedsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBeds(wardId);
  }, [wardId, loadBeds]);

  // Drop a selection that is no longer valid in the freshly loaded bed list:
  // this is what makes a just-taken bed visibly disappear from the picker.
  useEffect(() => {
    if (!bedId || !beds.length) return;
    const chosen = beds.find((bed) => bed.id === bedId);
    if (!chosen || !isFree(chosen)) setBedId('');
  }, [beds, bedId]);

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    setConflictMessage(null);
    if (!patient) {
      setValidation('Search for the patient and select them before admitting.');
      return;
    }
    if (complaint.trim().length < 3) {
      setValidation('Admitting complaint is required (at least 3 characters).');
      return;
    }
    setValidation(null);
    setSaving(true);
    setError(null);
    try {
      await api<Admission>('/api/admissions', {
        method: 'POST',
        body: {
          patientId: patient.id,
          wardId,
          bedId: bedId || undefined,
          attendingStaffId: attending || undefined,
          admittingComplaint: complaint.trim(),
          diagnosis: diagnosis.trim() || undefined
        }
      });
      onAdmitted();
      onClose();
    } catch (caught) {
      if (isConflict(caught)) {
        // Bed taken under us, or the patient is already admitted. Keep everything
        // typed and re-pull the bed list so the taken bed shows as occupied.
        setConflictMessage(
          caught instanceof ApiError
            ? caught.message
            : 'That bed or patient is already in use. Pick another bed.'
        );
        await loadBeds(wardId);
      } else {
        setError(caught);
      }
      setSaving(false);
    } finally {
      setSaving(false);
    }
  }

  const selectedWard = wards.find((ward) => ward.id === wardId);

  return (
    <Modal
      title="Admit to ward"
      subtitle={selectedWard ? `${selectedWard.name} · Floor ${selectedWard.floor}` : undefined}
      width="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!patient || complaint.trim().length < 3} onClick={submit}>
            Admit patient
          </Button>
        </>
      }
    >
      <div className="split">
        <div className="stack">
          <Field label="Patient" required hint="Search by name, MRN or phone.">
            <SearchInput value={query} onChange={setQuery} placeholder="Patient name or MRN…" />
          </Field>

          {searching && <Loading label="Searching patients…" />}
          <ErrorNote error={searchError} onDismiss={() => setSearchError(null)} />

          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <EmptyState title="No matching active patients" hint="Check the spelling or register the patient first." />
          )}

          {!searching && results.length > 0 && !patient && (
            <div className="stack stack-sm">
              {results.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  className="bed"
                  onClick={() => {
                    setPatient(row);
                    setResults([]);
                    setQuery('');
                  }}
                >
                  <span className="bed-label">
                    {row.fullName}
                    <span className="bed-meta mono">{row.mrn}</span>
                  </span>
                  <span className="bed-meta">
                    {row.age !== null ? `${row.age} yrs` : 'age unknown'} · {row.gender ?? '—'} ·{' '}
                    {row.bloodGroup ?? 'no blood group'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {patient && (
            <div className="detail-list">
              <div className="detail-item">
                <span>Patient</span>
                <strong>{patient.fullName}</strong>
              </div>
              <div className="detail-item">
                <span>MRN</span>
                <strong className="mono">{patient.mrn}</strong>
              </div>
              <div className="detail-item">
                <span>Age</span>
                <strong>{patient.age !== null ? `${patient.age}` : '—'}</strong>
              </div>
              <div className="detail-item">
                <span>Status</span>
                <strong>
                  <StatusBadge status={patient.status} />
                </strong>
              </div>
              <div className="detail-item">
                <span>Change</span>
                <strong>
                  <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                    Pick another patient
                  </Button>
                </strong>
              </div>
            </div>
          )}

          <div className="grid-2">
            <Field label="Ward" required>
              <Select
                value={wardId}
                onChange={(event) => {
                  setWardId(event.target.value);
                  setBedId('');
                  setConflictMessage(null);
                }}
              >
                {wards.map((ward) => (
                  <option key={ward.id} value={ward.id}>
                    {ward.name} ({ward.availableBeds} free)
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Bed" hint={bedsLoading ? 'Loading beds…' : 'Occupied and maintenance beds are shown but unavailable.'}>
              <Select value={bedId} onChange={(event) => setBedId(event.target.value)} disabled={bedsLoading && !beds.length}>
                <BedOptions beds={beds} />
              </Select>
            </Field>
          </div>

          <ErrorNote error={bedsError} onDismiss={() => setBedsError(null)} />

          <Field label="Admitting complaint" required error={validation ?? undefined} hint="Presenting complaint in the patient's own terms.">
            <Textarea
              rows={3}
              value={complaint}
              onChange={(event) => setComplaint(event.target.value)}
              placeholder="e.g. Three days of fever and right-sided chest pain"
            />
          </Field>

          <Field label="Diagnosis (optional)" hint="Can be added later from the admission panel.">
            <Textarea rows={2} value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} />
          </Field>
        </div>

        <div className="stack">
          <Field label="Attending clinician" hint="Active doctors only.">
            <Select value={attending} onChange={(event) => setAttending(event.target.value)}>
              <option value="">Not assigned yet</option>
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                  {doctor.specialty ? ` · ${doctor.specialty}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <ErrorNote error={doctorsError} onDismiss={() => setDoctorsError(null)} />

          {selectedWard && (
            <div className="detail-list">
              <div className="detail-item">
                <span>Unit</span>
                <strong>
                  <Badge tone={UNIT_TONE[selectedWard.unitType] ?? 'neutral'}>{selectedWard.unitType}</Badge>
                </strong>
              </div>
              <div className="detail-item">
                <span>Occupancy</span>
                <strong>{selectedWard.occupancyRate}%</strong>
              </div>
              <div className="detail-item">
                <span>Free beds</span>
                <strong>{selectedWard.availableBeds}</strong>
              </div>
              <div className="detail-item">
                <span>Maintenance</span>
                <strong>{selectedWard.maintenanceBeds}</strong>
              </div>
            </div>
          )}

          {conflictMessage && (
            <div className="alert-strip danger" role="alert">
              <span>{conflictMessage}</span>
            </div>
          )}
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <p className="muted">
            Admissions are recorded against your name and audited. The bed is only reserved once this form
            succeeds — if another station takes it first, the server will reject it and the board refreshes here.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Admission panel
 * ------------------------------------------------------------------ */

function AdmissionPanel({
  admissionId,
  wards,
  user,
  now,
  onClose,
  onBoardChanged,
  onDischarge
}: {
  admissionId: string;
  wards: Ward[];
  user: SessionUser | null;
  now: number;
  onClose: () => void;
  onBoardChanged: () => void;
  onDischarge: (admission: Admission) => void;
}) {
  const [detail, setDetail] = useState<AdmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState(false);

  const [action, setAction] = useState<'none' | 'note' | 'vitals' | 'transfer'>('none');
  const [noteType, setNoteType] = useState<NoteType>('progress');
  const [noteContent, setNoteContent] = useState('');
  const [noteError, setNoteError] = useState<unknown>(null);
  const [noteBusy, setNoteBusy] = useState(false);

  const [vitals, setVitalsForm] = useState<VitalForm>(EMPTY_VITAL_FORM);
  const [vitalsError, setVitalsError] = useState<unknown>(null);
  const [vitalsBusy, setVitalsBusy] = useState(false);

  const [transferWardId, setTransferWardId] = useState('');
  const [transferBedId, setTransferBedId] = useState('');
  const [transferBeds, setTransferBeds] = useState<Bed[]>([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<unknown>(null);
  const [transferConflict, setTransferConflict] = useState<string | null>(null);

  const canClinical = can(user, ['doctor', 'nurse']);
  const canTransfer = can(user, ['doctor', 'nurse']);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api<AdmissionDetail>(`/api/admissions/${admissionId}`));
      setDenied(false);
    } catch (caught) {
      if (isForbidden(caught)) setDenied(true);
      else setError(caught);
    } finally {
      setLoading(false);
    }
  }, [admissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (action !== 'transfer' || !transferWardId) return;
    let cancelled = false;
    setTransferBusy(true);
    api<Bed[]>(`/api/wards/${transferWardId}/beds`)
      .then((rows) => !cancelled && setTransferBeds(rows))
      .catch((caught) => !cancelled && setTransferError(caught))
      .finally(() => !cancelled && setTransferBusy(false));
    return () => {
      cancelled = true;
    };
  }, [action, transferWardId]);

  async function submitNote(event: FormEvent) {
    event.preventDefault();
    if (noteContent.trim().length < 3) {
      setNoteError(new Error('Note content needs at least 3 characters.'));
      return;
    }
    setNoteBusy(true);
    setNoteError(null);
    try {
      await api(`/api/admissions/${admissionId}/notes`, {
        method: 'POST',
        body: { type: noteType, content: noteContent.trim() }
      });
      setNoteContent('');
      setAction('none');
      await load();
    } catch (caught) {
      if (isForbidden(caught)) setNoteError(new Error('Only care roles may add clinical notes.'));
      else setNoteError(caught);
    } finally {
      setNoteBusy(false);
    }
  }

  async function submitVitals(event: FormEvent) {
    event.preventDefault();
    setVitalsError(null);
    const readings: Partial<Record<VitalKey, number>> = {};
    for (const key of VITAL_KEYS) {
      const raw = vitals[key];
      if (isBlank(raw)) continue;
      const value = toNumber(raw);
      if (!Number.isFinite(value)) {
        setVitalsError(new Error(`${VITAL_LABELS[key]} must be a number.`));
        return;
      }
      readings[key] = value;
    }
    if (Object.keys(readings).length === 0) {
      setVitalsError(new Error('Record at least one vital sign.'));
      return;
    }
    if (!detail) return;

    setVitalsBusy(true);
    try {
      await api(`/api/patients/${detail.patientId}/vitals`, {
        method: 'POST',
        body: { ...readings, admissionId: detail.id }
      });
      setVitalsForm(EMPTY_VITAL_FORM);
      setAction('none');
      await load();
    } catch (caught) {
      // Keep the form open with the server's range message next to the fields.
      setVitalsError(caught);
    } finally {
      setVitalsBusy(false);
    }
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (!detail || !transferWardId) return;
    setTransferBusy(true);
    setTransferError(null);
    setTransferConflict(null);
    try {
      await api(`/api/admissions/${detail.id}`, {
        method: 'PATCH',
        body: { wardId: transferWardId, bedId: transferBedId || null }
      });
      setAction('none');
      setTransferBedId('');
      await load();
      onBoardChanged();
    } catch (caught) {
      if (isConflict(caught)) {
        setTransferConflict(caught instanceof ApiError ? caught.message : 'That bed was just taken.');
        if (transferWardId) {
          try {
            setTransferBeds(await api<Bed[]>(`/api/wards/${transferWardId}/beds`));
          } catch {
            /* the refreshed list is best-effort; the conflict message still stands */
          }
        }
      } else {
        setTransferError(caught);
      }
    } finally {
      setTransferBusy(false);
    }
  }

  const clinicalVisible = detail ? 'notes' in detail || 'vitals' in detail : false;
  const isOpen = !!detail && !detail.dischargedAt && detail.status === 'admitted';

  const vitalColumns: Column<Vital>[] = [
    { key: 'recordedAt', header: 'Recorded', render: (row) => formatDateTime(row.recordedAt) },
    { key: 'temp', header: 'Temp', render: (row) => (row.temperatureC === null ? '—' : `${row.temperatureC}°`) },
    { key: 'pulse', header: 'Pulse', render: (row) => row.pulse ?? '—' },
    { key: 'rr', header: 'RR', render: (row) => row.respiratoryRate ?? '—' },
    { key: 'spo2', header: 'SpO₂', render: (row) => (row.spo2 === null ? '—' : `${row.spo2}%`) },
    {
      key: 'bp',
      header: 'BP',
      render: (row) =>
        row.bpSystolic === null && row.bpDiastolic === null ? '—' : `${row.bpSystolic ?? '—'}/${row.bpDiastolic ?? '—'}`
    },
    {
      key: 'body',
      header: 'Wt / Ht',
      render: (row) => `${row.weightKg ?? '—'} / ${row.heightCm ?? '—'}`
    },
    { key: 'by', header: 'By', render: (row) => row.recordedByName ?? '—' }
  ];

  return (
    <Modal
      title="Admission"
      subtitle={detail ? `${detail.patientName} · ${detail.patientMrn}` : undefined}
      width="lg"
      onClose={onClose}
      footer={
        detail ? (
          <>
            {canClinical && isOpen && (
              <Button size="sm" variant={action === 'note' ? 'primary' : 'secondary'} onClick={() => setAction(action === 'note' ? 'none' : 'note')}>
                Add note
              </Button>
            )}
            {canClinical && isOpen && (
              <Button size="sm" variant={action === 'vitals' ? 'primary' : 'secondary'} onClick={() => setAction(action === 'vitals' ? 'none' : 'vitals')}>
                Record vitals
              </Button>
            )}
            {canTransfer && isOpen && (
              <Button size="sm" variant={action === 'transfer' ? 'primary' : 'secondary'} onClick={() => setAction(action === 'transfer' ? 'none' : 'transfer')}>
                Transfer
              </Button>
            )}
            {canTransfer && isOpen && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onClose();
                  onDischarge(detail);
                }}
              >
                Discharge
              </Button>
            )}
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {loading && <Loading label="Loading admission…" />}
      {denied && (
        <Card title="Not permitted">
          <p className="muted">Your role cannot read this admission. Ask a care-role colleague or an administrator.</p>
        </Card>
      )}
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {detail && (
        <div className="stack">
          <div className="detail-list">
            <div className="detail-item">
              <span>Patient</span>
              <strong>{detail.patientName}</strong>
            </div>
            <div className="detail-item">
              <span>MRN</span>
              <strong className="mono">{detail.patientMrn}</strong>
            </div>
            <div className="detail-item">
              <span>Ward / bed</span>
              <strong>
                {detail.wardName ?? '—'} · {detail.bedLabel ?? 'ward holding'}
              </strong>
            </div>
            <div className="detail-item">
              <span>Status</span>
              <strong>
                <StatusBadge status={detail.status} /> · {lengthOfStay(detail.admittedAt, now)}
              </strong>
            </div>
            <div className="detail-item">
              <span>Admitted</span>
              <strong>{formatDateTime(detail.admittedAt)}</strong>
            </div>
            <div className="detail-item">
              <span>Attending</span>
              <strong>{detail.attendingName ?? 'Not assigned'}</strong>
            </div>
            <div className="detail-item">
              <span>Admitting complaint</span>
              <strong>{detail.admittingComplaint}</strong>
            </div>
            <div className="detail-item">
              <span>Diagnosis</span>
              <strong>{detail.diagnosis ?? 'Not recorded'}</strong>
            </div>
            {detail.dischargedAt && (
              <div className="detail-item">
                <span>Discharged</span>
                <strong>{formatDateTime(detail.dischargedAt)}</strong>
              </div>
            )}
          </div>

          {detail.dischargeSummary && (
            <div className="stack stack-sm">
              <strong className="subtle">Discharge summary</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{detail.dischargeSummary}</p>
            </div>
          )}

          {action === 'note' && (
            <form className="stack" onSubmit={submitNote}>
              <div className="grid-2">
                <Field label="Note type" required>
                  <Select value={noteType} onChange={(event) => setNoteType(event.target.value as NoteType)}>
                    {NOTE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Author" hint="Recorded as you.">
                  <Input value={user?.fullName ?? ''} readOnly />
                </Field>
              </div>
              <Field label="Content" required hint="Minimum 3 characters. Visible to care roles.">
                <Textarea rows={4} value={noteContent} onChange={(event) => setNoteContent(event.target.value)} />
              </Field>
              <ErrorNote error={noteError} onDismiss={() => setNoteError(null)} />
              <div className="row">
                <Button type="submit" variant="primary" loading={noteBusy}>
                  Save note
                </Button>
                <Button onClick={() => setAction('none')}>Cancel</Button>
              </div>
            </form>
          )}

          {action === 'vitals' && (
            <form className="stack" onSubmit={submitVitals}>
              <div className="grid-2">
                {VITAL_KEYS.map((key) => (
                  <Field key={key} label={VITAL_LABELS[key]} hint={`Allowed ${VITAL_RANGES[key]}`}>
                    <Input
                      type="number"
                      step="0.1"
                      inputMode="decimal"
                      value={vitals[key]}
                      onChange={(event) => setVitalsForm((form) => ({ ...form, [key]: event.target.value }))}
                    />
                  </Field>
                ))}
              </div>
              <p className="subtle">All fields optional — record at least one reading.</p>
              <ErrorNote error={vitalsError} onDismiss={() => setVitalsError(null)} />
              <div className="row">
                <Button type="submit" variant="primary" loading={vitalsBusy}>
                  Save vitals
                </Button>
                <Button onClick={() => setAction('none')}>Cancel</Button>
              </div>
            </form>
          )}

          {action === 'transfer' && (
            <form className="stack" onSubmit={submitTransfer}>
              <div className="grid-2">
                <Field label="Target ward" required>
                  <Select
                    value={transferWardId}
                    onChange={(event) => {
                      setTransferWardId(event.target.value);
                      setTransferBedId('');
                      setTransferConflict(null);
                    }}
                  >
                    <option value="">Select a ward…</option>
                    {wards.map((ward) => (
                      <option key={ward.id} value={ward.id}>
                        {ward.name} ({ward.availableBeds} free)
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Free bed" hint={transferBusy ? 'Loading beds…' : 'Leave empty to move to the ward holding.'}>
                  <Select
                    value={transferBedId}
                    onChange={(event) => setTransferBedId(event.target.value)}
                    disabled={!transferWardId}
                  >
                    <BedOptions beds={transferBeds} />
                  </Select>
                </Field>
              </div>
              {transferConflict && (
                <div className="alert-strip danger" role="alert">
                  <span>{transferConflict}</span>
                </div>
              )}
              <ErrorNote error={transferError} onDismiss={() => setTransferError(null)} />
              <div className="row">
                <Button type="submit" variant="primary" loading={transferBusy} disabled={!transferWardId}>
                  Confirm transfer
                </Button>
                <Button onClick={() => setAction('none')}>Cancel</Button>
              </div>
            </form>
          )}

          <div className="stack">
            <strong className="subtle">Clinical notes</strong>
            {clinicalVisible ? (
              detail.notes && detail.notes.length ? (
                <div className="stack stack-sm">
                  {detail.notes.map((note) => (
                    <div className="detail-item" key={note.id}>
                      <span>
                        <Badge tone="clinical">{note.type}</Badge> {formatDateTime(note.createdAt)} · {note.author ?? '—'}
                      </span>
                      <strong style={{ fontWeight: 500, whiteSpace: 'pre-wrap' }}>{note.content}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No notes yet" hint="Progress, consultation, nursing, procedure and discharge notes appear here." />
              )
            ) : (
              <p className="muted">Clinical detail is limited to care roles.</p>
            )}
          </div>

          <div className="stack">
            <strong className="subtle">Vitals</strong>
            {clinicalVisible ? (
              <Table
                columns={vitalColumns}
                rows={detail.vitals ?? []}
                empty="No vitals recorded for this admission yet."
              />
            ) : (
              <p className="muted">Clinical detail is limited to care roles.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Discharge confirmation
 * ------------------------------------------------------------------ */

function DischargeModal({
  admission,
  onClose,
  onDone
}: {
  admission: Admission;
  onClose: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [diagnosis, setDiagnosis] = useState(admission.diagnosis ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admissions/${admission.id}/discharge`, {
        method: 'POST',
        body: {
          dischargeSummary: summary.trim() || null,
          diagnosis: diagnosis.trim() || null
        }
      });
      onDone();
      onClose();
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Discharge patient"
      subtitle={`${admission.patientName} · ${admission.patientMrn}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep admitted
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Confirm discharge
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="alert-strip danger" role="alert">
          <span>
            This frees {admission.bedLabel ? `bed ${admission.bedLabel}` : 'the admission'} immediately — the next
            station can take the bed the moment you confirm. Discharge cannot be undone from this screen.
          </span>
        </div>

        <div className="detail-list">
          <div className="detail-item">
            <span>Ward</span>
            <strong>{admission.wardName ?? '—'}</strong>
          </div>
          <div className="detail-item">
            <span>Bed</span>
            <strong>{admission.bedLabel ?? 'ward holding'}</strong>
          </div>
          <div className="detail-item">
            <span>Admitted</span>
            <strong>{formatDateTime(admission.admittedAt)}</strong>
          </div>
          <div className="detail-item">
            <span>Complaint</span>
            <strong>{admission.admittingComplaint}</strong>
          </div>
        </div>

        <Field label="Final diagnosis (optional)">
          <Textarea rows={2} value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} />
        </Field>
        <Field label="Discharge summary (optional)" hint="Condition on discharge, follow-up and medication advice.">
          <Textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} />
        </Field>
        <ErrorNote error={error} onDismiss={() => setError(null)} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

type TabId = 'board' | 'current' | 'discharged';

export function WardsPage() {
  const { user } = useAuth();
  const canAdmit = can(user, ['doctor', 'nurse', 'reception']);

  const [wards, setWards] = useState<Ward[]>([]);
  const [bedsByWard, setBedsByWard] = useState<Record<string, Bed[]>>({});
  const [census, setCensus] = useState<Admission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());

  const [tab, setTab] = useState<TabId>('board');
  const [wardFilter, setWardFilter] = useState('all');
  const [onlyFree, setOnlyFree] = useState(false);
  const [censusOffset, setCensusOffset] = useState(0);

  const [discharged, setDischarged] = useState<Admission[]>([]);
  const [dischargedTotal, setDischargedTotal] = useState(0);
  const [dischargedOffset, setDischargedOffset] = useState(0);
  const [dischargedLoading, setDischargedLoading] = useState(false);
  const [dischargedError, setDischargedError] = useState<unknown>(null);

  const [admitTarget, setAdmitTarget] = useState<{ wardId: string; bedId?: string } | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [dischargeTarget, setDischargeTarget] = useState<Admission | null>(null);

  const loadBoard = useCallback(async (first: boolean) => {
    if (first) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [wardList, current] = await Promise.all([
        api<Ward[]>('/api/wards'),
        api<Admission[]>('/api/admissions/current')
      ]);
      const entries = await Promise.all(
        wardList.map(async (ward) => [ward.id, await api<Bed[]>(`/api/wards/${ward.id}/beds`)] as const)
      );
      setWards(wardList);
      setCensus(current);
      setBedsByWard(Object.fromEntries(entries));
      setDenied(false);
      setUpdatedAt(Date.now());
    } catch (caught) {
      if (isForbidden(caught)) setDenied(true);
      else setError(caught);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadDischarged = useCallback(async (offset: number) => {
    setDischargedLoading(true);
    setDischargedError(null);
    try {
      const page = await api<Page<Admission>>('/api/admissions', {
        query: { status: 'discharged', limit: PAGE_SIZE, offset }
      });
      setDischarged(page.items);
      setDischargedTotal(page.total);
    } catch (caught) {
      if (isForbidden(caught)) setDenied(true);
      else setDischargedError(caught);
    } finally {
      setDischargedLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBoard(true);
  }, [loadBoard]);

  useEffect(() => {
    if (tab === 'discharged') void loadDischarged(dischargedOffset);
  }, [tab, dischargedOffset, loadDischarged]);

  const totals = useMemo(() => {
    const sum = (pick: (ward: Ward) => number) => wards.reduce((acc, ward) => acc + pick(ward), 0);
    const totalBeds = sum((ward) => ward.totalBeds);
    const occupied = sum((ward) => ward.occupiedBeds);
    return {
      totalBeds,
      occupied,
      available: sum((ward) => ward.availableBeds),
      maintenance: sum((ward) => ward.maintenanceBeds),
      rate: totalBeds ? Math.round((occupied / totalBeds) * 1000) / 10 : 0
    };
  }, [wards]);

  const hotWards = useMemo(
    () => wards.filter((ward) => ward.totalBeds > 0 && ward.occupancyRate > 85),
    [wards]
  );

  const visibleWards = useMemo(
    () =>
      wards.filter(
        (ward) =>
          (wardFilter === 'all' || ward.id === wardFilter) && (!onlyFree || ward.availableBeds > 0)
      ),
    [wards, wardFilter, onlyFree]
  );

  const censusRows = useMemo(
    () => (wardFilter === 'all' ? census : census.filter((row) => row.wardId === wardFilter)),
    [census, wardFilter]
  );

  // After a refresh or a ward filter change, keep the census page in range.
  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(censusRows.length / PAGE_SIZE - 1) * PAGE_SIZE);
    if (censusOffset > lastPage) setCensusOffset(lastPage);
  }, [censusRows.length, censusOffset]);

  function refresh() {
    void loadBoard(false);
    if (tab === 'discharged') void loadDischarged(dischargedOffset);
  }

  const censusColumns: Column<Admission>[] = [
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <div className="stack stack-sm">
          <strong>{row.patientName}</strong>
          <span className="bed-meta mono">{row.patientMrn}</span>
        </div>
      )
    },
    { key: 'ward', header: 'Ward', render: (row) => row.wardName ?? '—' },
    { key: 'bed', header: 'Bed', render: (row) => row.bedLabel ?? 'holding' },
    {
      key: 'admitted',
      header: 'Admitted',
      render: (row) => (
        <div className="stack stack-sm">
          <span>{formatDateTime(row.admittedAt)}</span>
          <span className="bed-meta">{lengthOfStay(row.admittedAt, updatedAt)} in</span>
        </div>
      )
    },
    { key: 'complaint', header: 'Complaint', render: (row) => row.admittingComplaint },
    { key: 'attending', header: 'Attending', render: (row) => row.attendingName ?? 'Not assigned' }
  ];

  const dischargedColumns: Column<Admission>[] = [
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <div className="stack stack-sm">
          <strong>{row.patientName}</strong>
          <span className="bed-meta mono">{row.patientMrn}</span>
        </div>
      )
    },
    { key: 'ward', header: 'Last ward', render: (row) => row.wardName ?? '—' },
    { key: 'bed', header: 'Last bed', render: (row) => row.bedLabel ?? '—' },
    { key: 'admitted', header: 'Admitted', render: (row) => formatDate(row.admittedAt) },
    {
      key: 'discharged',
      header: 'Discharged',
      render: (row) => (
        <div className="stack stack-sm">
          <span>{formatDateTime(row.dischargedAt)}</span>
          <span className="bed-meta">{daysAgo(row.dischargedAt, updatedAt)}</span>
        </div>
      )
    },
    { key: 'diagnosis', header: 'Diagnosis', render: (row) => row.diagnosis ?? '—' }
  ];

  if (denied) {
    return (
      <>
        <div className="page-head">
          <div>
            <h2>Wards and beds</h2>
            <p>Restricted screen.</p>
          </div>
          <Button onClick={refresh} loading={refreshing}>
            Refresh
          </Button>
        </div>
        <Card title="No ward access">
          <p className="muted">
            Your role is not allowed to read the inpatient board. Ask an administrator to grant ward access.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Ward and bed board</h2>
          <p>
            Shared live view · updated {formatDateTime(new Date(updatedAt).toISOString())}
            {refreshing ? ' · refreshing…' : ''}
          </p>
        </div>
        <div className="toolbar">
          <Button onClick={refresh} loading={refreshing}>
            Refresh
          </Button>
          {canAdmit && (
            <Button
              variant="primary"
              disabled={!wards.some((ward) => ward.availableBeds > 0)}
              onClick={() => {
                const ward = visibleWards.find((row) => row.availableBeds > 0) ?? wards.find((row) => row.availableBeds > 0);
                if (ward) setAdmitTarget({ wardId: ward.id });
              }}
            >
              Admit patient
            </Button>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Total beds" value={totals.totalBeds} hint={`${wards.length} wards`} />
        <Stat label="Occupied" value={totals.occupied} tone={totals.rate > 85 ? 'warning' : 'neutral'} />
        <Stat label="Available" value={totals.available} tone="success" />
        <Stat label="Maintenance" value={totals.maintenance} tone={totals.maintenance > 0 ? 'warning' : 'neutral'} />
        <Stat
          label="Occupancy"
          value={`${totals.rate}%`}
          tone={occupancyTone(totals.rate)}
          hint={totals.rate > 95 ? 'Critical — no spare capacity' : totals.rate > 85 ? 'Running high' : 'Normal'}
        />
        <Stat label="Current admissions" value={census.length} hint="Open inpatient episodes" />
      </div>

      {hotWards.length > 0 && (
        <div className={classList('alert-strip', hotWards.some((ward) => ward.occupancyRate > 95) && 'danger')} role="status">
          <span>
            High occupancy: {hotWards.map((ward) => `${ward.name} ${ward.occupancyRate}% (${ward.availableBeds} free)`).join(' · ')}
          </span>
        </div>
      )}

      <div className="legend" aria-label="Bed status legend">
        <span>
          <i className="dot dot-available" aria-hidden="true" /> Available
        </span>
        <span>
          <i className="dot dot-occupied" aria-hidden="true" /> Occupied
        </span>
        <span>
          <i className="dot dot-maintenance" aria-hidden="true" /> Maintenance
        </span>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'board', label: 'Bed board' },
          { id: 'current', label: 'Admitted patients', count: census.length },
          { id: 'discharged', label: 'Discharged', count: dischargedTotal }
        ]}
      />

      <div className="toolbar">
        <Field label="Ward" className="nowrap">
          <Select value={wardFilter} onChange={(event) => setWardFilter(event.target.value)}>
            <option value="all">All wards</option>
            {wards.map((ward) => (
              <option key={ward.id} value={ward.id}>
                {ward.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="sm"
          variant={onlyFree ? 'primary' : 'secondary'}
          aria-pressed={onlyFree}
          onClick={() => setOnlyFree((value) => !value)}
        >
          Only wards with free beds
        </Button>
        {!canAdmit && <span className="subtle">Your role can view the board but not admit patients.</span>}
      </div>

      {tab === 'board' && (
        <>
          {loading && <Loading label="Loading ward layout…" />}
          {!loading && visibleWards.length === 0 && (
            <EmptyState
              title="No wards match"
              hint={onlyFree ? 'Every ward is full or under maintenance. Try clearing the free-bed filter.' : 'Wards are configured by an administrator.'}
            />
          )}
          {!loading && (
            <div className="stack">
              {visibleWards.map((ward) => {
                const beds = bedsByWard[ward.id];
                return (
                  <div className="ward-section" key={ward.id}>
                    <Card
                      title={
                        <span className="row">
                          {ward.name}
                          <Badge tone={UNIT_TONE[ward.unitType] ?? 'neutral'}>{ward.unitType}</Badge>
                          {!ward.isActive && <Badge tone="neutral">closed</Badge>}
                        </span>
                      }
                      subtitle={`Floor ${ward.floor} · ${ward.occupiedBeds}/${ward.totalBeds} occupied · ${ward.availableBeds} free`}
                      actions={
                        <Badge tone={occupancyTone(ward.occupancyRate) === 'neutral' ? 'success' : occupancyTone(ward.occupancyRate)}>
                          {ward.occupancyRate}% full
                        </Badge>
                      }
                    >
                      {!beds ? (
                        <Loading label="Loading beds…" />
                      ) : beds.length === 0 ? (
                        <EmptyState title="No beds in this ward" hint="An administrator or nurse must add beds before admissions." />
                      ) : (
                        <div className="bed-grid">
                          {beds.map((bed) => (
                            <BedTile
                              key={bed.id}
                              bed={bed}
                              now={updatedAt}
                              canAdmit={canAdmit}
                              onOpen={(admissionId) => setPanelId(admissionId)}
                              onAdmit={(bedId) => setAdmitTarget({ wardId: ward.id, bedId })}
                            />
                          ))}
                        </div>
                      )}
                    </Card>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'current' && (
        <Card title="Current census" subtitle="Every still-open admission, newest first." padded={false}>
          <Table
            columns={censusColumns}
            rows={censusRows.slice(censusOffset, censusOffset + PAGE_SIZE)}
            loading={loading}
            empty="No patient is admitted right now."
            onRowClick={(row) => setPanelId(row.id)}
          />
          <div style={{ padding: '0 16px 14px' }}>
            <Pager total={censusRows.length} limit={PAGE_SIZE} offset={censusOffset} onChange={setCensusOffset} />
          </div>
        </Card>
      )}

      {tab === 'discharged' && (
        <Card title="Discharged admissions" subtitle="Server-paged history, newest discharge first." padded={false}>
          <ErrorNote error={dischargedError} onDismiss={() => setDischargedError(null)} />
          <Table
            columns={dischargedColumns}
            rows={discharged}
            loading={dischargedLoading}
            empty="No discharged admissions recorded yet."
            onRowClick={(row) => setPanelId(row.id)}
          />
          <div style={{ padding: '0 16px 14px' }}>
            <Pager total={dischargedTotal} limit={PAGE_SIZE} offset={dischargedOffset} onChange={setDischargedOffset} />
          </div>
        </Card>
      )}

      {admitTarget && (
        <AdmitModal
          wards={wards}
          initial={admitTarget}
          onClose={() => setAdmitTarget(null)}
          onAdmitted={refresh}
        />
      )}

      {panelId && (
        <AdmissionPanel
          admissionId={panelId}
          wards={wards}
          user={user}
          now={updatedAt}
          onClose={() => setPanelId(null)}
          onBoardChanged={() => void loadBoard(false)}
          onDischarge={(admission) => setDischargeTarget(admission)}
        />
      )}

      {dischargeTarget && (
        <DischargeModal
          admission={dischargeTarget}
          onClose={() => setDischargeTarget(null)}
          onDone={() => {
            setPanelId(null);
            refresh();
          }}
        />
      )}
    </>
  );
}
