import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.js';
import { brandFor } from './branding.js';
import {
  Badge,
  Button,
  ErrorNote,
  Field,
  Input,
  Loading,
  Modal,
  SearchInput,
  Select,
  Table,
  Textarea
} from './components.js';
import type { Column } from './components.js';
import { formatDate, formatDateTime } from './utils.js';

function dashOr(value: string | number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

/* ------------------------------------------------------------------ types
 * Mirrors the two shapes returned by server/src/modules/reports.routes.ts. */

export interface ReportIndexRow {
  id: string;
  patientId: string;
  patientName: string;
  mrn: string;
  appointmentId: string | null;
  admissionId: string | null;
  title: string;
  createdAt: string;
  authorName: string | null;
}

interface ReportPatient {
  id: string;
  mrn: string;
  fullName: string;
  birthDate: string | null;
  age: number | null;
  gender: string | null;
  bloodGroup: string | null;
  allergies: string | null;
  chronicConditions: string | null;
  phone: string | null;
}

interface ReportVital {
  id: string;
  recordedAt: string;
  recordedBy: string | null;
  temperatureC: number | null;
  pulse: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  weightKg: number | null;
  heightCm: number | null;
}

interface ReportLabResult {
  id: string;
  testName: string;
  testCode: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  referenceText: string | null;
  flag: string | null;
  comment: string | null;
  resultedAt: string;
  verifiedBy: string | null;
}

interface ReportMedicineItem {
  id: string;
  medicineName: string;
  genericName: string | null;
  form: string;
  strength: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  instructions: string | null;
}

interface ReportPrescription {
  id: string;
  prescribedAt: string;
  status: string;
  prescriber: string | null;
  notes: string | null;
  items: ReportMedicineItem[];
}

export interface ReportDocument {
  id: string;
  patientId: string;
  appointmentId: string | null;
  admissionId: string | null;
  authorId: string;
  title: string;
  findings: string;
  diagnosis: string;
  plan: string | null;
  advice: string | null;
  createdAt: string;
  updatedAt: string;
  author: { fullName: string; email: string; department: string | null; specialty: string | null } | null;
  patient: ReportPatient;
  appointment: {
    id: string;
    startsAt: string;
    endsAt: string | null;
    status: string;
    reason: string | null;
    clinician: string | null;
  } | null;
  admission: {
    id: string;
    admittedAt: string;
    dischargedAt: string | null;
    status: string;
    complaint: string | null;
    diagnosis: string | null;
    wardName: string | null;
    bedLabel: string | null;
    attending: string | null;
  } | null;
  vitals: ReportVital[];
  labResults: ReportLabResult[];
  prescriptions: ReportPrescription[];
}

interface PatientOption {
  id: string;
  mrn: string;
  fullName: string;
  status: string;
  age: number | null;
}

interface EncounterHistory {
  appointments: { id: string; startsAt: string; status: string; reason: string | null; clinician: string | null }[];
  admissions: {
    id: string;
    admittedAt: string;
    dischargedAt: string | null;
    status: string;
    wardName: string | null;
    bedLabel: string | null;
    complaint: string | null;
  }[];
}

/** A report answers one encounter, so the two are picked from one control. */
type EncounterChoice = '' | 'appointment' | 'admission';

/* ------------------------------------------------------------------ form */

interface ReportDraft {
  title: string;
  findings: string;
  diagnosis: string;
  plan: string;
  advice: string;
}

const EMPTY_DRAFT: ReportDraft = { title: '', findings: '', diagnosis: '', plan: '', advice: '' };

function validateDraft(draft: ReportDraft): string | null {
  if (draft.title.trim().length < 3) return 'Give the report a title of at least 3 characters.';
  if (draft.title.trim().length > 160) return 'Keep the title under 160 characters.';
  if (draft.findings.trim().length < 3) return 'Record what you found — history, examination and observations.';
  if (draft.findings.trim().length > 8000) return 'Findings must stay under 8,000 characters.';
  if (draft.diagnosis.trim().length < 2) return 'Enter the diagnosis you are signing.';
  if (draft.diagnosis.trim().length > 600) return 'Keep the diagnosis under 600 characters.';
  if (draft.plan.length > 6000 || draft.advice.length > 6000) return 'Treatment plan and advice must stay under 6,000 characters each.';
  return null;
}

function bodyFrom(draft: ReportDraft, encounter: EncounterChoice, encounterId: string) {
  return {
    appointmentId: encounter === 'appointment' ? encounterId : null,
    admissionId: encounter === 'admission' ? encounterId : null,
    title: draft.title.trim(),
    findings: draft.findings.trim(),
    diagnosis: draft.diagnosis.trim(),
    plan: draft.plan.trim() || null,
    advice: draft.advice.trim() || null
  };
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Writes or amends a signed report. `lockedPatientId` is set when the form is
 * opened from a patient record, so the clinician cannot drift onto another
 * chart mid-write.
 */
export function ReportFormModal({
  lockedPatientId,
  lockedPatientLabel,
  reportId,
  initialEncounter,
  onClose,
  onSaved
}: {
  lockedPatientId?: string;
  lockedPatientLabel?: string;
  reportId?: string;
  /** Set when the form is opened from a specific visit or admission panel. */
  initialEncounter?: { kind: Exclude<EncounterChoice, ''>; value: string };
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [patient, setPatient] = useState<PatientOption | null>(
    lockedPatientId ? { id: lockedPatientId, mrn: '', fullName: lockedPatientLabel ?? '', status: 'active', age: null } : null
  );
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_DRAFT);
  const [encounter, setEncounter] = useState<EncounterChoice>(initialEncounter?.kind ?? '');
  const [encounterId, setEncounterId] = useState(initialEncounter?.value ?? '');
  const [history, setHistory] = useState<EncounterHistory | null>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!reportId);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const patientId = patient?.id ?? '';

  // An amendment starts from the signed text, never from a blank page.
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    api<ReportDocument>(`/api/reports/${reportId}`)
      .then((doc) => {
        if (cancelled) return;
        setPatient({ id: doc.patient.id, mrn: doc.patient.mrn, fullName: doc.patient.fullName, status: 'active', age: doc.patient.age });
        setDraft({
          title: doc.title,
          findings: doc.findings,
          diagnosis: doc.diagnosis,
          plan: doc.plan ?? '',
          advice: doc.advice ?? ''
        });
        setEncounter(doc.appointmentId ? 'appointment' : doc.admissionId ? 'admission' : '');
        setEncounterId(doc.appointmentId ?? doc.admissionId ?? '');
      })
      .catch((caught) => !cancelled && setError(caught))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  useEffect(() => {
    if (!patientId) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryError(null);
    api<EncounterHistory>(`/api/patients/${patientId}/history`)
      .then((result) => !cancelled && setHistory(result))
      .catch((caught) => !cancelled && setHistoryError(caught));
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  async function submit() {
    if (!patientId) {
      setFieldError('Pick the patient this report is about.');
      return;
    }
    if (encounter && !encounterId) {
      setFieldError('Choose the appointment or admission, or set the encounter back to “Not attached”.');
      return;
    }
    const invalid = validateDraft(draft);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      const body = bodyFrom(draft, encounter, encounterId);
      if (reportId) {
        await api<ReportIndexRow>(`/api/reports/${reportId}`, { method: 'PATCH', body });
      } else {
        await api<ReportIndexRow>('/api/reports', { method: 'POST', body: { ...body, patientId } });
      }
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const encounters = useMemo(() => {
    if (!history) return [] as { value: string; label: string; kind: Exclude<EncounterChoice, ''> }[];
    const rows = history.appointments.map((row) => ({
      kind: 'appointment' as const,
      value: row.id,
      label: `Visit ${formatDateTime(row.startsAt)} · ${row.clinician ?? 'unassigned'}`
    }));
    const stays = history.admissions.map((row) => ({
      kind: 'admission' as const,
      value: row.id,
      label: `Admission ${formatDate(row.admittedAt)} · ${row.wardName ?? 'ward unset'}${row.bedLabel ? ` bed ${row.bedLabel}` : ''}`
    }));
    return [...rows, ...stays];
  }, [history]);

  const shown = encounters.filter((row) => row.kind === encounter);

  return (
    <Modal
      width="lg"
      title={reportId ? 'Amend clinical report' : 'New clinical report'}
      subtitle={
        reportId
          ? 'Amendments keep the original author and are recorded in the audit trail.'
          : 'The diagnosis you sign here is what the printed document carries.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={busy || loading}>
            {reportId ? 'Save amendments' : 'Sign report'}
          </Button>
        </>
      }
    >
      {loading ? (
        <Loading label="Loading report…" />
      ) : (
        <div className="stack">
          {lockedPatientId ? (
            <p className="subtle">
              Patient: <strong>{lockedPatientLabel ?? patient?.fullName}</strong>
            </p>
          ) : (
            <PatientSearch picked={patient} onPick={setPatient} disabled={busy} />
          )}

          <div className="form-grid">
            <Field label="Report title" required hint="e.g. “Day-care review” or “Discharge summary”.">
              <Input
                value={draft.title}
                disabled={busy}
                onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Follow-up after chest infection"
              />
            </Field>
            <Field label="Encounter" hint="One report answers one visit or one admission." error={fieldError ?? undefined}>
              <Select
                value={encounter}
                disabled={busy || !patientId}
                onChange={(event) => {
                  setEncounter(event.target.value as EncounterChoice);
                  setEncounterId('');
                }}
              >
                <option value="">Not attached</option>
                <option value="appointment">Clinic visit</option>
                <option value="admission">Admission</option>
              </Select>
            </Field>
          </div>

          {!!encounter && (
            <Field label={encounter === 'appointment' ? 'Which visit' : 'Which admission'}>
              <Select value={encounterId} disabled={busy} onChange={(event) => setEncounterId(event.target.value)}>
                <option value="">Choose…</option>
                {shown.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
              </Select>
              {!!historyError && <ErrorNote error={historyError} onDismiss={() => setHistoryError(null)} />}
            </Field>
          )}

          <Field label="Findings" required hint="History, examination and the observations that led to the diagnosis.">
            <Textarea
              rows={7}
              value={draft.findings}
              disabled={busy}
              onChange={(event) => setDraft((prev) => ({ ...prev, findings: event.target.value }))}
            />
          </Field>

          <Field label="Diagnosis" required>
            <Textarea
              rows={2}
              value={draft.diagnosis}
              disabled={busy}
              onChange={(event) => setDraft((prev) => ({ ...prev, diagnosis: event.target.value }))}
              placeholder="Acute bronchitis"
            />
          </Field>

          <div className="form-grid">
            <Field label="Treatment plan">
              <Textarea
                rows={4}
                value={draft.plan}
                disabled={busy}
                onChange={(event) => setDraft((prev) => ({ ...prev, plan: event.target.value }))}
              />
            </Field>
            <Field label="Advice to the patient">
              <Textarea
                rows={4}
                value={draft.advice}
                disabled={busy}
                onChange={(event) => setDraft((prev) => ({ ...prev, advice: event.target.value }))}
              />
            </Field>
          </div>

          <p className="subtle">
            Medicines prescribed for this encounter are printed with the report automatically — prescribe on the
            patient record, not here.
          </p>

          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </Modal>
  );
}

function PatientSearch({
  picked,
  onPick,
  disabled
}: {
  picked: PatientOption | null;
  onPick: (patient: PatientOption | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PatientOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const debounced = useDebounced(query);

  useEffect(() => {
    if (!debounced.trim()) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ items: PatientOption[] }>('/api/patients', { query: { q: debounced.trim(), limit: 8 } })
      .then((result) => !cancelled && setOptions(result.items))
      .catch((caught) => !cancelled && setError(caught))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  if (picked) {
    return (
      <div className="row">
        <span>
          <strong>{picked.fullName}</strong> <span className="mono subtle">{picked.mrn}</span>
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onPick(null)}>
          Change patient
        </Button>
      </div>
    );
  }

  return (
    <div className="stack-sm">
      <SearchInput value={query} onChange={setQuery} placeholder="Search patient name, MRN or phone…" />
      {loading && <Loading label="Searching patients…" />}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {!!options.length && (
        <div className="stack-sm">
          {options.map((patient) => (
            <Button
              key={patient.id}
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                setOptions([]);
                onPick(patient);
              }}
            >
              {patient.fullName} · <span className="mono">{patient.mrn}</span>
              {patient.age !== null ? ` · ${patient.age}y` : ''}
            </Button>
          ))}
        </div>
      )}
      {!loading && !!debounced.trim() && !options.length && !error && (
        <p className="subtle">No patient matches “{debounced.trim()}”.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ document */

function labValue(row: ReportLabResult): string {
  if (row.valueNumeric !== null) return `${row.valueNumeric}${row.unit ? ` ${row.unit}` : ''}`;
  return dashOr(row.valueText);
}

function bloodPressure(row: ReportVital): string {
  if (row.bpSystolic === null || row.bpDiastolic === null) return '—';
  return `${row.bpSystolic}/${row.bpDiastolic}`;
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="report-section">
      <h3>{heading}</h3>
      {children}
    </section>
  );
}

/**
 * The printed artefact. Everything inside stays when the app chrome is hidden.
 *
 * A report leaves the clinic in a patient's hands, so it carries the issuing
 * hospital's own name, mark, heading line and footnote — all from the signed-in
 * session and its registry row, never from `branding.ts`, which is deliberately
 * anonymous now that several hospitals share this build.
 */
export function ReportDocumentView({ doc }: { doc: ReportDocument }) {
  const { user } = useAuth();
  const brand = brandFor(user);
  return (
    <article className="report-doc">
      <header className="report-head">
        <div className="brand-line">
          <span className="brand-mark" aria-hidden="true">
            {brand.mark}
          </span>
          <div>
            <strong>{brand.name}</strong>
            <span>{brand.reportCaption}</span>
          </div>
        </div>
        <div className="report-ref">
          <span>Report {doc.id.slice(0, 8)}</span>
          <span>Issued {formatDateTime(doc.createdAt)}</span>
          {doc.updatedAt !== doc.createdAt && <span>Amended {formatDateTime(doc.updatedAt)}</span>}
        </div>
      </header>

      <h2 className="report-title">{doc.title}</h2>

      <Section heading="Patient">
        <dl className="report-facts">
          <div>
            <dt>Name</dt>
            <dd>{doc.patient.fullName}</dd>
          </div>
          <div>
            <dt>MRN</dt>
            <dd className="mono">{doc.patient.mrn}</dd>
          </div>
          <div>
            <dt>Age / sex</dt>
            <dd>
              {doc.patient.age !== null ? `${doc.patient.age} yrs` : '—'} · {dashOr(doc.patient.gender)}
            </dd>
          </div>
          <div>
            <dt>Blood group</dt>
            <dd>{dashOr(doc.patient.bloodGroup)}</dd>
          </div>
          <div>
            <dt>Allergies</dt>
            <dd className={doc.patient.allergies ? 'report-alert' : undefined}>
              {doc.patient.allergies ? doc.patient.allergies : 'None recorded'}
            </dd>
          </div>
          <div>
            <dt>Long-standing conditions</dt>
            <dd>{dashOr(doc.patient.chronicConditions, 'None recorded')}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd className="mono">{dashOr(doc.patient.phone)}</dd>
          </div>
          <div>
            <dt>Date of birth</dt>
            <dd>{formatDate(doc.patient.birthDate)}</dd>
          </div>
        </dl>
      </Section>

      <Section heading="Encounter">
        {doc.appointment ? (
          <dl className="report-facts">
            <div>
              <dt>Clinic visit</dt>
              <dd>{formatDateTime(doc.appointment.startsAt)}</dd>
            </div>
            <div>
              <dt>Seen by</dt>
              <dd>{dashOr(doc.appointment.clinician)}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{dashOr(doc.appointment.reason)}</dd>
            </div>
            <div>
              <dt>Visit status</dt>
              <dd>{doc.appointment.status.replace(/_/g, ' ')}</dd>
            </div>
          </dl>
        ) : doc.admission ? (
          <dl className="report-facts">
            <div>
              <dt>Admitted</dt>
              <dd>{formatDateTime(doc.admission.admittedAt)}</dd>
            </div>
            <div>
              <dt>Discharged</dt>
              <dd>{formatDateTime(doc.admission.dischargedAt)}</dd>
            </div>
            <div>
              <dt>Ward / bed</dt>
              <dd>
                {dashOr(doc.admission.wardName)}
                {doc.admission.bedLabel ? ` · bed ${doc.admission.bedLabel}` : ''}
              </dd>
            </div>
            <div>
              <dt>Attending</dt>
              <dd>{dashOr(doc.admission.attending)}</dd>
            </div>
            <div>
              <dt>Complaint on admission</dt>
              <dd>{dashOr(doc.admission.complaint)}</dd>
            </div>
            <div>
              <dt>Working diagnosis</dt>
              <dd>{dashOr(doc.admission.diagnosis)}</dd>
            </div>
          </dl>
        ) : (
          <p className="report-empty">Written without attaching a visit or admission.</p>
        )}
      </Section>

      <Section heading="Findings">
        <p className="report-text">{doc.findings}</p>
      </Section>

      <Section heading="Diagnosis">
        <p className="report-diagnosis">{doc.diagnosis}</p>
      </Section>

      {doc.plan && (
        <Section heading="Treatment plan">
          <p className="report-text">{doc.plan}</p>
        </Section>
      )}
      {doc.advice && (
        <Section heading="Advice to the patient">
          <p className="report-text">{doc.advice}</p>
        </Section>
      )}

      {!!doc.vitals.length && (
        <Section heading="Observations">
          <table className="report-table">
            <thead>
              <tr>
                <th>Recorded</th>
                <th>By</th>
                <th>Temp °C</th>
                <th>Pulse</th>
                <th>RR</th>
                <th>SpO₂</th>
                <th>BP</th>
                <th>Weight</th>
              </tr>
            </thead>
            <tbody>
              {doc.vitals.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.recordedAt)}</td>
                  <td>{dashOr(row.recordedBy)}</td>
                  <td>{row.temperatureC ?? '—'}</td>
                  <td>{row.pulse ?? '—'}</td>
                  <td>{row.respiratoryRate ?? '—'}</td>
                  <td>{row.spo2 === null ? '—' : `${row.spo2}%`}</td>
                  <td>{bloodPressure(row)}</td>
                  <td>{row.weightKg ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {!!doc.labResults.length && (
        <Section heading="Laboratory results (countersigned)">
          <table className="report-table">
            <thead>
              <tr>
                <th>Resulted</th>
                <th>Test</th>
                <th>Value</th>
                <th>Reference</th>
                <th>Flag</th>
                <th>Verified by</th>
              </tr>
            </thead>
            <tbody>
              {doc.labResults.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.resultedAt)}</td>
                  <td>
                    {row.testName} <span className="mono subtle">{row.testCode}</span>
                  </td>
                  <td>{labValue(row)}</td>
                  <td>{dashOr(row.referenceText)}</td>
                  <td>{dashOr(row.flag)}</td>
                  <td>{dashOr(row.verifiedBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {!!doc.prescriptions.length && (
        <Section heading="Prescriptions from this encounter">
          {doc.prescriptions.map((rx) => (
            <div key={rx.id} className="report-rx">
              <div className="report-rx-head">
                <strong>{formatDateTime(rx.prescribedAt)}</strong>
                <span>{dashOr(rx.prescriber)}</span>
                <Badge tone={rx.status === 'dispensed' ? 'success' : 'neutral'}>{rx.status.replace(/_/g, ' ')}</Badge>
              </div>
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Dose</th>
                    <th>Frequency</th>
                    <th>Days</th>
                    <th>Qty</th>
                    <th>Instructions</th>
                  </tr>
                </thead>
                <tbody>
                  {rx.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.medicineName}
                        {item.strength ? ` ${item.strength}` : ''}
                        <span className="subtle">
                          {' '}
                          ({item.form}
                          {item.genericName ? ` · ${item.genericName}` : ''})
                        </span>
                      </td>
                      <td>{item.dosage}</td>
                      <td>{item.frequency}</td>
                      <td>{item.durationDays}</td>
                      <td>{item.quantity}</td>
                      <td>{dashOr(item.instructions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rx.notes && <p className="report-text subtle">{rx.notes}</p>}
            </div>
          ))}
        </Section>
      )}

      <footer className="report-sign">
        <div className="report-sign-box">
          <span />
          <em>Authorised signature</em>
        </div>
        <div className="report-sign-who">
          <strong>{doc.author?.fullName ?? 'Author no longer on the roster'}</strong>
          <span>
            {dashOr(doc.author?.specialty, 'Clinician')}
            {doc.author?.department ? ` · ${doc.author.department}` : ''}
          </span>
          <span className="mono">{dashOr(doc.author?.email)}</span>
        </div>
        <p className="report-foot-note">{brand.reportFootnote}</p>
      </footer>
    </article>
  );
}

/** Opens one report, prints it, and hands amendments back to the form. */
export function ReportDocumentModal({
  reportId,
  onClose,
  onChanged
}: {
  reportId: string;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<ReportDocument | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [amending, setAmending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDoc(await api<ReportDocument>(`/api/reports/${reportId}`));
    } catch (caught) {
      setError(caught);
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mayAmend = !!user && (user.role === 'admin' || doc?.authorId === user.id);

  if (amending && doc) {
    return (
      <ReportFormModal
        reportId={doc.id}
        lockedPatientId={doc.patientId}
        lockedPatientLabel={`${doc.patient.fullName} · ${doc.patient.mrn}`}
        onClose={() => setAmending(false)}
        onSaved={async () => {
          await load();
          await onChanged();
        }}
      />
    );
  }

  return (
    <Modal
      width="lg"
      title={doc?.title ?? 'Clinical report'}
      subtitle={doc ? `${doc.patient.fullName} · ${doc.patient.mrn}` : undefined}
      onClose={onClose}
      footer={
        <div className="report-actions">
          <Button onClick={onClose}>Close</Button>
          {doc && (
            <Button variant="primary" onClick={() => window.print()}>
              Print / save as PDF
            </Button>
          )}
          {doc && mayAmend && (
            <Button variant="secondary" onClick={() => setAmending(true)}>
              Amend
            </Button>
          )}
        </div>
      }
    >
      {!!error && <ErrorNote error={error} onDismiss={() => setError(null)} />}
      {!doc && !error && <Loading label="Loading report…" />}
      {doc && <ReportDocumentView doc={doc} />}
    </Modal>
  );
}

/* ---------------------------------------------------------------- list */

export function ReportsTable({ rows, onOpen }: { rows: ReportIndexRow[]; onOpen: (row: ReportIndexRow) => void }) {
  const columns: Column<ReportIndexRow>[] = [
    {
      key: 'title',
      header: 'Report',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.title}</div>
          <span className="subtle">{row.authorName ?? 'author removed'}</span>
        </div>
      ),
      width: '30%'
    },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <div>
          <div>{row.patientName}</div>
          <span className="mono subtle">{row.mrn}</span>
        </div>
      )
    },
    {
      key: 'encounter',
      header: 'Encounter',
      render: (row) =>
        row.appointmentId ? (
          <Badge tone="info">clinic visit</Badge>
        ) : row.admissionId ? (
          <Badge tone="warning">admission</Badge>
        ) : (
          <span className="subtle">not attached</span>
        )
    },
    { key: 'issued', header: 'Issued', render: (row) => <span className="muted nowrap">{formatDateTime(row.createdAt)}</span> },
    {
      key: 'open',
      header: '',
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="secondary" onClick={() => onOpen(row)}>
          Open
        </Button>
      ),
      width: '90px'
    }
  ];

  return (
    <Table
      columns={columns}
      rows={rows}
      empty="No clinical reports here yet. A doctor signs one after examining the patient."
      onRowClick={onOpen}
    />
  );
}
