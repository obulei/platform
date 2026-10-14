import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  Select,
  StatusBadge,
  Stat,
  Tabs,
  Textarea
} from '../components.js';
import {
  classList,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
  toDateInputValue,
  timeRangeOptions
} from '../utils.js';

type PatientStatus = 'active' | 'inactive' | 'deceased';
type Gender = 'male' | 'female' | 'other';
type NoteType = 'progress' | 'consultation' | 'nursing' | 'procedure' | 'discharge';

/** Fields returned by toDto() in server/src/modules/patients.routes.ts. */
interface PatientDto {
  id: string;
  mrn: string;
  givenName: string;
  familyName: string;
  fullName: string;
  birthDate: string | null;
  gender: Gender | null;
  bloodGroup: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  allergies: string | null;
  chronicConditions: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  status: PatientStatus;
  notes: string | null;
  createdAt: string;
}

/** GET /api/patients/:id — toDto() + age, completedVisits, openAdmission. */
interface PatientRecord extends PatientDto {
  age: number | null;
  completedVisits: number;
  openAdmission: {
    id: string;
    wardId: string;
    wardName: string | null;
    bedLabel: string | null;
    complaint: string;
  } | null;
}

/** GET /api/patients/:id/history — clinicalNotes is [] for non-care roles. */
interface PatientHistory {
  patient: PatientDto & { age: number | null };
  appointments: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    reason: string;
    clinician: string | null;
  }[];
  admissions: {
    id: string;
    admittedAt: string;
    dischargedAt: string | null;
    status: string;
    complaint: string;
    diagnosis: string | null;
    wardName: string | null;
  }[];
  prescriptions: { id: string; createdAt: string; status: string; prescriber: string | null }[];
  labOrders: { id: string; orderedAt: string; status: string; priority: string; orderedBy: string | null }[];
  invoices: { id: string; number: string; status: string; createdAt: string }[];
  clinicalNotes: {
    id: string;
    createdAt: string;
    type: string;
    content: string;
    author: string | null;
  }[];
}

/** GET /api/patients/:patientId/vitals — toVitalsDto() in inpatient.routes.ts. */
interface VitalsRecord {
  id: string;
  admissionId: string | null;
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

/** GET /api/staff/bookable */
interface BookableClinician {
  id: string;
  fullName: string;
  role: string;
  specialty: string | null;
  department: string | null;
  consultationFee: number;
}

/** POST /api/invoices/from-encounter → buildInvoiceDetail(). */
interface InvoiceDetail {
  id: string;
  number: string;
  status: string;
  subtotal: number;
  balanceDue: number;
}

type TabId =
  | 'appointments'
  | 'admissions'
  | 'notes'
  | 'vitals'
  | 'prescriptions'
  | 'labOrders'
  | 'invoices';

const DURATIONS = [15, 20, 30, 45, 60];
const NOTE_TYPES: NoteType[] = ['progress', 'consultation', 'nursing', 'procedure', 'discharge'];

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function dash(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

interface DemographicsForm {
  givenName: string;
  familyName: string;
  birthDate: string;
  gender: string;
  bloodGroup: string;
  phone: string;
  email: string;
  address: string;
  allergies: string;
  chronicConditions: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  notes: string;
  status: PatientStatus;
}

const TEXT_FIELDS = [
  'givenName',
  'familyName',
  'bloodGroup',
  'phone',
  'email',
  'address',
  'allergies',
  'chronicConditions',
  'emergencyContactName',
  'emergencyContactPhone',
  'notes'
] as const;

type TextField = (typeof TEXT_FIELDS)[number];

function formFromPatient(patient: PatientDto & { status: PatientStatus }): DemographicsForm {
  return {
    givenName: patient.givenName,
    familyName: patient.familyName,
    birthDate: patient.birthDate ? patient.birthDate.slice(0, 10) : '',
    gender: patient.gender ?? '',
    bloodGroup: patient.bloodGroup ?? '',
    phone: patient.phone ?? '',
    email: patient.email ?? '',
    address: patient.address ?? '',
    allergies: patient.allergies ?? '',
    chronicConditions: patient.chronicConditions ?? '',
    emergencyContactName: patient.emergencyContactName ?? '',
    emergencyContactPhone: patient.emergencyContactPhone ?? '',
    notes: patient.notes ?? '',
    status: patient.status
  };
}

/** PATCH bodies must carry only what actually changed. */
function buildPatch(patient: PatientDto, form: DemographicsForm): Record<string, string | null> {
  const patch: Record<string, string | null> = {};

  for (const field of TEXT_FIELDS) {
    const next = blankToNull(form[field]);
    const current = blankToNull(patient[field] ?? '');
    if (next !== current) patch[field] = next;
  }

  const nextBirth = form.birthDate || null;
  const currentBirth = patient.birthDate ? patient.birthDate.slice(0, 10) : null;
  if (nextBirth !== currentBirth) patch.birthDate = nextBirth;

  const nextGender = form.gender || null;
  if (nextGender !== patient.gender) patch.gender = nextGender;

  if (form.status !== patient.status) patch.status = form.status;

  return patch;
}

export function PatientDetailPage() {
  const { patientId } = useParams<{ patientId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [history, setHistory] = useState<PatientHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<TabId>('appointments');

  const [vitals, setVitals] = useState<VitalsRecord[] | null>(null);
  const [vitalsLoading, setVitalsLoading] = useState(false);
  const [vitalsError, setVitalsError] = useState<unknown>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [billBusy, setBillBusy] = useState(false);
  const [billError, setBillError] = useState<unknown>(null);
  const [billNotice, setBillNotice] = useState<string | null>(null);

  const isClinical = can(user, ['doctor', 'nurse']);

  const loadRecord = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    try {
      const [record, longitudinal] = await Promise.all([
        api<PatientRecord>(`/api/patients/${patientId}`),
        api<PatientHistory>(`/api/patients/${patientId}/history`)
      ]);
      setPatient(record);
      setHistory(longitudinal);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void loadRecord();
  }, [loadRecord]);

  // Vitals are not part of the history payload: they live on their own
  // clinical-role route and are fetched when the tab is opened.
  const refreshVitals = useCallback(async () => {
    if (!patientId) return;
    setVitalsLoading(true);
    setVitalsError(null);
    try {
      setVitals(await api<VitalsRecord[]>(`/api/patients/${patientId}/vitals`));
    } catch (caught) {
      setVitals(null);
      setVitalsError(caught);
    } finally {
      setVitalsLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    if (tab === 'vitals' && vitals === null && !vitalsLoading && !isForbidden(vitalsError)) {
      void refreshVitals();
    }
  }, [tab, vitals, vitalsLoading, vitalsError, refreshVitals]);

  const showNotesTab = isClinical || (history?.clinicalNotes.length ?? 0) > 0;

  const tabs = useMemo(() => {
    const list: { id: TabId; label: string; count?: number }[] = [
      { id: 'appointments', label: 'Appointments', count: history?.appointments.length },
      { id: 'admissions', label: 'Admissions', count: history?.admissions.length }
    ];
    if (showNotesTab) list.push({ id: 'notes', label: 'Clinical notes', count: history?.clinicalNotes.length });
    list.push(
      { id: 'vitals', label: 'Vitals', count: vitals?.length },
      { id: 'prescriptions', label: 'Prescriptions', count: history?.prescriptions.length },
      { id: 'labOrders', label: 'Lab orders', count: history?.labOrders.length },
      { id: 'invoices', label: 'Invoices', count: history?.invoices.length }
    );
    return list;
  }, [history, showNotesTab, vitals]);

  useEffect(() => {
    if (!showNotesTab && tab === 'notes') setTab('admissions');
  }, [showNotesTab, tab]);

  if (loading && !patient) {
    return (
      <div className="page">
        <Loading label="Opening the patient record…" />
      </div>
    );
  }

  if (isForbidden(error)) {
    return (
      <div className="page">
        <div className="alert-strip">Your role may not read this patient record.</div>
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div className="page">
        <ErrorNote error={error ?? 'Patient not found.'} />
        <div>
          <Button onClick={() => navigate('/patients')}>Back to patients</Button>
        </div>
      </div>
    );
  }

  const admissionForNotes = patient.openAdmission ?? history?.admissions[0] ?? null;

  return (
    <div className="page">
      {patient.allergies ? (
        <div className="alert-strip danger" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>Allergy on record: {patient.allergies}</span>
        </div>
      ) : null}
      {patient.chronicConditions ? (
        <div className="alert-strip">
          <span>Chronic conditions: {patient.chronicConditions}</span>
        </div>
      ) : null}

      {patient.openAdmission ? (
        <div className="alert-strip" style={{ background: 'var(--info-soft)', borderColor: '#cadff5', color: 'var(--info)' }}>
          <strong>Currently admitted</strong>
          <span>
            {patient.openAdmission.wardName ?? 'Unknown ward'}
            {patient.openAdmission.bedLabel ? ` · bed ${patient.openAdmission.bedLabel}` : ''}
          </span>
          <span className="spacer" />
          <Link to="/wards">Ward board</Link>
        </div>
      ) : null}

      <div className="page-head">
        <div>
          <h2 className="row">
            {patient.fullName}
            <StatusBadge status={patient.status} />
            {patient.bloodGroup ? <Badge tone="clinical">{patient.bloodGroup}</Badge> : null}
          </h2>
          <p>
            <span className="mono">{patient.mrn}</span>
            {' · '}
            {patient.age === null ? 'Age not recorded' : `${patient.age} yrs`}
            {' · '}
            {patient.gender ? patient.gender : 'sex not recorded'}
            {patient.birthDate ? ` · born ${formatDate(patient.birthDate)}` : ''}
          </p>
        </div>
        <div className="row">
          {can(user, ['reception']) ? (
            <Button onClick={() => setEditOpen(true)}>Edit details</Button>
          ) : null}
          {can(user, ['reception', 'doctor', 'nurse']) ? (
            <Button onClick={() => setBookingOpen(true)}>New appointment</Button>
          ) : null}
          {can(user, ['billing', 'reception']) ? (
            <Button
              variant="primary"
              loading={billBusy}
              disabled={!patient.openAdmission}
              onClick={() => void generateBill()}
            >
              Generate bill
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate('/patients')}>
            All patients
          </Button>
        </div>
      </div>

      {billNotice ? <div className="alert-strip" role="status">{billNotice}</div> : null}
      {billError ? (
        <div className="stack-sm stack">
          <ErrorNote error={billError} onDismiss={() => setBillError(null)} />
          <p className="subtle">
            A refusal here is usually deliberate: the server keeps one draft per encounter, so an existing draft must
            be issued or deleted before another roll-up is generated. Open the draft on the billing screen instead of
            re-generating it.
          </p>
        </div>
      ) : null}
      {!patient.openAdmission && can(user, ['billing', 'reception']) ? (
        <p className="subtle">
          Billing from an encounter uses the open admission; this patient is not admitted, so there is nothing to
          roll up here.
        </p>
      ) : null}

      <div className="split split-wide-left">
        <Card title="Clinical timeline" padded={false}>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          <div className="card-body padded">
            {history ? (
              <>
                {tab === 'appointments' && <AppointmentTimeline rows={history.appointments} />}
                {tab === 'admissions' && (
                  <AdmissionsTab
                    rows={history.admissions}
                    canNote={isClinical}
                    selectedAdmissionId={admissionForNotes?.id ?? null}
                    onPosted={() => {
                      setVitals(null);
                      void loadRecord();
                    }}
                  />
                )}
                {tab === 'notes' && <NotesTimeline rows={history.clinicalNotes} />}
                {tab === 'vitals' && (
                  <VitalsTab
                    rows={vitals}
                    loading={vitalsLoading}
                    error={vitalsError}
                    onRetry={() => void refreshVitals()}
                  />
                )}
                {tab === 'prescriptions' && <PrescriptionsTimeline rows={history.prescriptions} />}
                {tab === 'labOrders' && <LabOrdersTimeline rows={history.labOrders} />}
                {tab === 'invoices' && <InvoicesTimeline rows={history.invoices} />}
              </>
            ) : (
              <Loading label="Loading the record…" />
            )}
          </div>
        </Card>

        <div className="stack">
          <Card title="Record summary">
            <div className="stat-grid" style={{ marginBottom: 14 }}>
              <Stat label="Completed visits" value={patient.completedVisits} />
              <Stat
                label="Status"
                value={<span style={{ textTransform: 'capitalize' }}>{patient.status}</span>}
                tone={patient.status === 'deceased' ? 'danger' : 'neutral'}
              />
            </div>
            <div className="detail-list">
              <div className="detail-item">
                <span>MRN</span>
                <strong className="mono">{patient.mrn}</strong>
              </div>
              <div className="detail-item">
                <span>Registered</span>
                <strong>{formatDate(patient.createdAt)}</strong>
              </div>
              <div className="detail-item">
                <span>Phone</span>
                <strong>{dash(patient.phone)}</strong>
              </div>
              <div className="detail-item">
                <span>Email</span>
                <strong className="mono">{dash(patient.email)}</strong>
              </div>
              <div className="detail-item">
                <span>Emergency contact</span>
                <strong>{dash(patient.emergencyContactName)}</strong>
              </div>
              <div className="detail-item">
                <span>Emergency phone</span>
                <strong>{dash(patient.emergencyContactPhone)}</strong>
              </div>
            </div>
            {patient.address ? (
              <p className="subtle" style={{ marginTop: 12 }}>
                Address: {patient.address}
              </p>
            ) : null}
            {patient.notes ? (
              <p className="muted" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                {patient.notes}
              </p>
            ) : null}
          </Card>

          <Card title="Safety flags">
            <div className="stack-sm stack">
              <div className="row">
                <Badge tone={patient.allergies ? 'danger' : 'neutral'}>Allergies</Badge>
                <span className="muted">{dash(patient.allergies)}</span>
              </div>
              <div className="row">
                <Badge tone={patient.chronicConditions ? 'warning' : 'neutral'}>Chronic</Badge>
                <span className="muted">{dash(patient.chronicConditions)}</span>
              </div>
              <div className="row">
                <Badge tone="clinical">Blood group</Badge>
                <span className="muted">{dash(patient.bloodGroup)}</span>
              </div>
            </div>
          </Card>

          <Card title="Open encounter">
            {patient.openAdmission ? (
              <div className="stack-sm stack">
                <strong>{patient.openAdmission.wardName ?? 'Ward unassigned'}</strong>
                <span className="muted">
                  {patient.openAdmission.bedLabel ? `Bed ${patient.openAdmission.bedLabel}` : 'No bed assigned'}
                </span>
                <span className="muted">Complaint: {dash(patient.openAdmission.complaint)}</span>
                <span className="subtle">Admission id: {patient.openAdmission.id}</span>
              </div>
            ) : (
              <EmptyState title="Not admitted" hint="Outpatient activity only; admissions appear in the timeline." />
            )}
          </Card>
        </div>
      </div>

      {editOpen ? (
        <EditDetailsModal
          patient={patient}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            void loadRecord();
          }}
        />
      ) : null}

      {bookingOpen ? (
        <NewAppointmentModal
          patientId={patient.id}
          patientName={patient.fullName}
          onClose={() => setBookingOpen(false)}
          onBooked={() => {
            setBookingOpen(false);
            void loadRecord();
          }}
        />
      ) : null}
    </div>
  );

  async function generateBill() {
    if (!patient?.openAdmission) return;
    setBillBusy(true);
    setBillError(null);
    setBillNotice(null);
    try {
      const invoice = await api<InvoiceDetail>('/api/invoices/from-encounter', {
        method: 'POST',
        body: { admissionId: patient.openAdmission.id }
      });
      setBillNotice(`Draft invoice ${invoice.number} created — ${formatMoney(invoice.balanceDue)} still unpaid.`);
      await loadRecord();
    } catch (caught) {
      setBillError(caught);
    } finally {
      setBillBusy(false);
    }
  }
}

/* ------------------------------------------------------------------ tabs */

function TimelineRow({
  when,
  title,
  badge,
  body
}: {
  when: string;
  title: ReactNode;
  badge?: ReactNode;
  body?: ReactNode;
}) {
  return (
    <div className="timeline-item">
      <span className="timeline-when">{when}</span>
      <div>
        <span className="timeline-title">
          {title}
          {badge}
        </span>
        {body ? <span className="timeline-body">{body}</span> : null}
      </div>
    </div>
  );
}

function AppointmentTimeline({
  rows
}: {
  rows: PatientHistory['appointments'];
}) {
  if (!rows.length) return <EmptyState title="No appointments" hint="Nothing booked for this patient yet." />;
  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={`${formatDateTime(row.startsAt)} → ${formatTime(row.endsAt)}`}
          title={row.clinician ? `With ${row.clinician}` : 'Appointment'}
          badge={<StatusBadge status={row.status} />}
          body={row.reason}
        />
      ))}
    </div>
  );
}

function AdmissionsTab({
  rows,
  canNote,
  selectedAdmissionId,
  onPosted
}: {
  rows: PatientHistory['admissions'];
  canNote: boolean;
  selectedAdmissionId: string | null;
  onPosted: () => void;
}) {
  const [admissionId, setAdmissionId] = useState(selectedAdmissionId ?? '');
  const [type, setType] = useState<NoteType>('progress');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!admissionId && selectedAdmissionId) setAdmissionId(selectedAdmissionId);
  }, [admissionId, selectedAdmissionId]);

  // The only note-writing endpoint is POST /api/admissions/:id/notes, so a
  // clinical note always belongs to an admission — outpatients have none.
  const composerOpen = rows.length > 0 && canNote && admissionId !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!admissionId || content.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admissions/${admissionId}/notes`, {
        method: 'POST',
        body: { type, content: content.trim() }
      });
      setContent('');
      onPosted();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {rows.length === 0 ? (
        <EmptyState
          title="Never admitted"
          hint="This patient has only outpatient activity, so there is no admission to attach a clinical note to."
        />
      ) : (
        <div className="timeline">
          {rows.map((row) => (
            <TimelineRow
              key={row.id}
              when={`${formatDateTime(row.admittedAt)}${row.dischargedAt ? ` → ${formatDate(row.dischargedAt)}` : ''}`}
              title={`${row.wardName ?? 'Ward unassigned'}${row.dischargedAt ? ' (discharged)' : ' (open)'}`}
              badge={<StatusBadge status={row.status} />}
              body={
                <>
                  Complaint: {dash(row.complaint)}
                  <br />
                  Diagnosis: {dash(row.diagnosis)}
                </>
              }
            />
          ))}
        </div>
      )}

      {rows.length > 0 && canNote ? (
        <Card title="Add clinical note" subtitle="Notes are attached to the admission you pick here.">
          <form className="stack" onSubmit={submit}>
            {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
            <div className="form-grid">
              <Field label="Admission">
                <Select value={admissionId} onChange={(event) => setAdmissionId(event.target.value)}>
                  {rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {(row.wardName ?? 'Ward') + ' · ' + formatDateTime(row.admittedAt)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note type">
                <Select value={type} onChange={(event) => setType(event.target.value as NoteType)}>
                  {NOTE_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Content"
                required
                className="form-span-2"
                hint={composerOpen ? 'Visible to care roles only.' : 'Select an admission first.'}
              >
                <Textarea
                  rows={4}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Observations, assessment, plan…"
                />
              </Field>
            </div>
            <div className="row">
              <span className="spacer" />
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={content.trim().length < 3 || !admissionId}
              >
                Save note
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {rows.length > 0 && !canNote ? (
        <p className="subtle">
          Clinical free-text is written by doctors and nurses and is not exposed to this role.
        </p>
      ) : null}
    </div>
  );
}

function NotesTimeline({ rows }: { rows: PatientHistory['clinicalNotes'] }) {
  if (!rows.length) {
    return <EmptyState title="No notes" hint="No clinical note has been filed for this patient." />;
  }
  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={formatDateTime(row.createdAt)}
          title={row.author ? `${row.type} · ${row.author}` : `${row.type}`}
          badge={<Badge tone="clinical">{row.type}</Badge>}
          body={row.content}
        />
      ))}
    </div>
  );
}

function VitalsTab({
  rows,
  loading,
  error,
  onRetry
}: {
  rows: VitalsRecord[] | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading) return <Loading label="Loading vitals…" />;
  if (isForbidden(error)) {
    return <div className="alert-strip">Vitals are clinical data and are restricted to care roles.</div>;
  }
  if (error) {
    return (
      <div className="stack">
        <ErrorNote error={error} />
        <div>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!rows) return <Loading label="Loading vitals…" />;
  if (!rows.length) return <EmptyState title="No vitals" hint="Nothing recorded for this patient yet." />;

  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={formatDateTime(row.recordedAt)}
          title={row.recordedByName ? `Recorded by ${row.recordedByName}` : 'Vitals'}
          body={
            <span className={classList('row')}>
              <Vital label="Temp" value={row.temperatureC === null ? null : `${row.temperatureC} °C`} />
              <Vital label="Pulse" value={row.pulse === null ? null : `${row.pulse}/min`} />
              <Vital label="RR" value={row.respiratoryRate === null ? null : `${row.respiratoryRate}/min`} />
              <Vital label="SpO₂" value={row.spo2 === null ? null : `${row.spo2}%`} />
              <Vital
                label="BP"
                value={
                  row.bpSystolic === null || row.bpDiastolic === null
                    ? null
                    : `${row.bpSystolic}/${row.bpDiastolic}`
                }
              />
              <Vital label="Weight" value={row.weightKg === null ? null : `${row.weightKg} kg`} />
              <Vital label="Height" value={row.heightCm === null ? null : `${row.heightCm} cm`} />
            </span>
          }
        />
      ))}
    </div>
  );
}

function Vital({ label, value }: { label: string; value: string | null }) {
  return (
    <Badge tone={value === null ? 'neutral' : 'info'}>
      {label} {value ?? '—'}
    </Badge>
  );
}

function PrescriptionsTimeline({ rows }: { rows: PatientHistory['prescriptions'] }) {
  if (!rows.length) return <EmptyState title="No prescriptions" hint="Nothing dispensed or issued for this patient." />;
  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={formatDateTime(row.createdAt)}
          title={row.prescriber ? `Prescribed by ${row.prescriber}` : 'Prescription'}
          badge={<StatusBadge status={row.status} />}
          body="Open the pharmacy screen for the drug list."
        />
      ))}
    </div>
  );
}

function LabOrdersTimeline({ rows }: { rows: PatientHistory['labOrders'] }) {
  if (!rows.length) return <EmptyState title="No lab orders" hint="This patient has no laboratory history." />;
  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={formatDateTime(row.orderedAt)}
          title={row.orderedBy ? `Ordered by ${row.orderedBy}` : 'Lab order'}
          badge={
            <>
              <StatusBadge status={row.status} />
              <Badge tone={row.priority === 'urgent' ? 'danger' : 'neutral'}>{row.priority}</Badge>
            </>
          }
        />
      ))}
    </div>
  );
}

function InvoicesTimeline({ rows }: { rows: PatientHistory['invoices'] }) {
  if (!rows.length) return <EmptyState title="No invoices" hint="Nothing billed to this patient yet." />;
  return (
    <div className="timeline">
      {rows.map((row) => (
        <TimelineRow
          key={row.id}
          when={formatDateTime(row.createdAt)}
          title={<span className="mono">{row.number}</span>}
          badge={<StatusBadge status={row.status} />}
          body="Amounts and payment history live on the billing screen."
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- modals */

function EditDetailsModal({
  patient,
  onClose,
  onSaved
}: {
  patient: PatientRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DemographicsForm>(() => formFromPatient(patient));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function update<K extends keyof DemographicsForm>(key: K, value: DemographicsForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const patch = buildPatch(patient, form);
  const changedKeys = Object.keys(patch);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changedKeys.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<PatientDto>(`/api/patients/${patient.id}`, { method: 'PATCH', body: patch });
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit patient details"
      subtitle={
        changedKeys.length
          ? `${changedKeys.length} field${changedKeys.length === 1 ? '' : 's'} will be updated.`
          : 'Nothing has changed yet.'
      }
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!changedKeys.length}>
            Save changes
          </Button>
        </>
      }
    >
      {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

      <form className="stack" onSubmit={save}>
      <div className="form-grid">
        <Field label="Given name" required>
          <Input value={form.givenName} onChange={(event) => update('givenName', event.target.value)} />
        </Field>
        <Field label="Family name" required>
          <Input value={form.familyName} onChange={(event) => update('familyName', event.target.value)} />
        </Field>
        <Field label="Birth date" hint="YYYY-MM-DD or blank.">
          <Input
            type="date"
            max={toDateInputValue()}
            value={form.birthDate}
            onChange={(event) => update('birthDate', event.target.value)}
          />
        </Field>
        <Field label="Sex">
          <Select value={form.gender} onChange={(event) => update('gender', event.target.value)}>
            <option value="">Not recorded</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Blood group">
          <Input value={form.bloodGroup} onChange={(event) => update('bloodGroup', event.target.value)} />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(event) => update('status', event.target.value as PatientStatus)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="deceased">Deceased</option>
          </Select>
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(event) => update('phone', event.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} />
        </Field>
        <Field label="Address" className="form-span-2">
          <Textarea rows={2} value={form.address} onChange={(event) => update('address', event.target.value)} />
        </Field>
      </div>

      <div className="card" style={{ background: 'var(--danger-soft)', borderColor: '#f0c6c6' }}>
        <div className="card-body padded stack-sm">
          <div className="row">
            <Badge tone="danger">Clinical alerts</Badge>
            <span className="subtle">Anything here appears as a red warning on the patient record.</span>
          </div>
          <div className="form-grid">
            <Field label="Allergies">
              <Textarea rows={2} value={form.allergies} onChange={(event) => update('allergies', event.target.value)} />
            </Field>
            <Field label="Chronic conditions">
              <Textarea
                rows={2}
                value={form.chronicConditions}
                onChange={(event) => update('chronicConditions', event.target.value)}
              />
            </Field>
          </div>
        </div>
      </div>

      <div className="form-grid">
        <Field label="Emergency contact name">
          <Input
            value={form.emergencyContactName}
            onChange={(event) => update('emergencyContactName', event.target.value)}
          />
        </Field>
        <Field label="Emergency contact phone">
          <Input
            value={form.emergencyContactPhone}
            onChange={(event) => update('emergencyContactPhone', event.target.value)}
          />
        </Field>
        <Field label="Administrative notes" className="form-span-2">
          <Textarea rows={2} value={form.notes} onChange={(event) => update('notes', event.target.value)} />
        </Field>
      </div>
      </form>
    </Modal>
  );
}

function NewAppointmentModal({
  patientId,
  patientName,
  onClose,
  onBooked
}: {
  patientId: string;
  patientName: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [clinicians, setClinicians] = useState<BookableClinician[] | null>(null);
  const [clinicianError, setClinicianError] = useState<unknown>(null);
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(toDateInputValue());
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState('30');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<BookableClinician[]>('/api/staff/bookable', { query: { role: 'doctor' } })
      .then((rows) => {
        if (!cancelled) setClinicians(rows);
      })
      .catch((caught) => {
        if (!cancelled) setClinicianError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const slots = useMemo(() => timeRangeOptions(15), []);
  const start = new Date(`${date}T${time || '00:00'}:00`);
  const end = new Date(start.getTime() + Number(duration) * 60_000);
  const timingValid = !Number.isNaN(start.getTime()) && end.getTime() - start.getTime() >= 5 * 60_000;
  const canSubmit = Boolean(staffId) && reason.trim().length >= 3 && timingValid && !busy;

  async function book(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    // The server answers a clash with a human sentence; keep the form open so
    // reception can move the slot without retyping anything.
    try {
      await api('/api/appointments', {
        method: 'POST',
        body: {
          patientId,
          staffId,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          reason: reason.trim(),
          notes: blankToNull(notes)
        }
      });
      onBooked();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New appointment"
      subtitle={`Book ${patientName} with a clinician.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={book} loading={busy} disabled={!canSubmit}>
            Book visit
          </Button>
        </>
      }
    >
      {error ? (
        <div className="stack-sm stack">
          <ErrorNote error={error} />
          {error instanceof ApiError && error.status === 409 ? (
            <p className="subtle">
              The clinician or this patient is already booked over part of that window. Pick another start time or
              another clinician — your entries above are still here.
            </p>
          ) : null}
        </div>
      ) : null}

      {clinicianError ? <ErrorNote error={clinicianError} /> : null}

      <form className="stack" onSubmit={book}>
      <div className="form-grid">
        <Field label="Clinician" required className="form-span-2">
          {clinicians === null && !clinicianError ? (
            <Loading label="Loading bookable clinicians…" />
          ) : (
            <Select value={staffId} onChange={(event) => setStaffId(event.target.value)}>
              <option value="">Select a doctor…</option>
              {clinicians?.map((clinician) => (
                <option key={clinician.id} value={clinician.id}>
                  {clinician.fullName}
                  {clinician.specialty ? ` — ${clinician.specialty}` : ''} ({formatMoney(clinician.consultationFee)})
                </option>
              ))}
            </Select>
          )}
          {clinicians !== null && clinicians.length === 0 ? (
            <span className="subtle">No active doctor is available for booking.</span>
          ) : null}
        </Field>
        <Field label="Date" required>
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Start time" required>
          <Select value={time} onChange={(event) => setTime(event.target.value)}>
            {slots.map((slot) => (
              <option key={slot} value={slot}>
                {slot}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Duration"
          hint={
            Number.isNaN(start.getTime())
              ? 'Pick a date and start time.'
              : `Runs ${formatTime(start.toISOString())} → ${formatTime(end.toISOString())}`
          }
        >
          <Select value={duration} onChange={(event) => setDuration(event.target.value)}>
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {minutes} min
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Reason"
          required
          className="form-span-2"
          error={reason.trim().length > 0 && reason.trim().length < 3 ? 'Use at least 3 characters.' : undefined}
        >
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Follow-up review" />
        </Field>
        <Field label="Notes" className="form-span-2">
          <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
      </form>
    </Modal>
  );
}
