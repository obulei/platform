import { useCallback, useEffect, useState } from 'react';
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
import { formatDateTime, formatMoney } from '../utils.js';

/* ------------------------------------------------------------------ *
 * Types mirrored from server/src/modules/lab.routes.ts DTOs.
 * ------------------------------------------------------------------ */

type OrderStatus = 'pending' | 'collected' | 'in_progress' | 'completed' | 'cancelled';
type Priority = 'routine' | 'urgent';
type Flag = 'normal' | 'abnormal' | 'critical';
type Specimen = 'blood' | 'urine' | 'stool' | 'sputum' | 'swab' | 'tissue' | 'other';

const ORDER_STATUSES: OrderStatus[] = ['pending', 'collected', 'in_progress', 'completed', 'cancelled'];
const BENCH_STATUSES: OrderStatus[] = ['pending', 'collected', 'in_progress'];
const SPECIMENS: Specimen[] = ['blood', 'urine', 'stool', 'sputum', 'swab', 'tissue', 'other'];
const FLAGS: Flag[] = ['normal', 'abnormal', 'critical'];

/** testDto() in the route file. */
interface LabTest {
  id: string;
  code: string;
  name: string;
  specimen: Specimen;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  price: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** mapOrder() in the route file. */
interface LabOrder {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  admissionId: string | null;
  wardName: string | null;
  orderingStaffId: string;
  orderingStaffName: string;
  status: OrderStatus;
  priority: Priority;
  notes: string | null;
  orderedAt: string;
  collectedAt: string | null;
  completedAt: string | null;
  testCount: number;
  testNames: string;
}

interface LabOrderListResult {
  items: LabOrder[];
  total: number;
}

/** itemDto(): the joined test catalogue plus its optional result. */
interface LabOrderItem {
  id: string;
  labOrderId: string;
  test: {
    id: string;
    code: string;
    name: string;
    specimen: Specimen;
    unit: string | null;
    referenceLow: number | null;
    referenceHigh: number | null;
    referenceText: string | null;
    price: number;
  };
  result: {
    id: string;
    valueNumeric: number | null;
    valueText: string | null;
    unit: string | null;
    flag: Flag | null;
    comment: string | null;
    resultedAt: string | null;
    resultedByName: string | null;
    verifiedByName: string | null;
  } | null;
}

interface LabOrderDetail extends LabOrder {
  items: LabOrderItem[];
}

/** POST /api/lab/items/:itemId/result response — the only place flagSource exists. */
interface ResultResponse {
  id: string;
  labOrderId: string;
  labOrderItemId: string;
  testCode: string;
  testName: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  flag: Flag;
  flagSource: 'computed' | 'manual';
  computedFlag: Flag;
  comment: string | null;
  resultedBy: string;
  resultedAt: string;
  verifiedBy: string | null;
  isCorrection: boolean;
  allItemsResulted: boolean;
}

/**
 * PATCH status and POST cancel return the raw lab_orders row — no joined
 * patient or staff names — so callers reload the order instead of trusting it.
 */
interface LabOrderRow {
  id: string;
  status: OrderStatus;
  priority: Priority;
  collectedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface PatientOption {
  id: string;
  mrn: string;
  fullName: string;
  status: string;
  age: number | null;
}

interface AdmissionOption {
  id: string;
  patientId: string;
  status: string;
  wardName: string | null;
  bedLabel: string | null;
  admittingComplaint: string;
  admittedAt: string;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function referenceLabel(test: LabOrderItem['test'] | LabTest): string {
  const unit = test.unit ? ` ${test.unit}` : '';
  if (test.referenceLow !== null && test.referenceHigh !== null)
    return `${test.referenceLow}–${test.referenceHigh}${unit}`;
  if (test.referenceLow !== null) return `≥ ${test.referenceLow}${unit}`;
  if (test.referenceHigh !== null) return `≤ ${test.referenceHigh}${unit}`;
  if (test.referenceText) return test.referenceText;
  return 'no range set';
}

function PermissionNotice({ error }: { error: unknown }) {
  return (
    <Card title="Not available for your role">
      <div className="stack">
        <p className="muted">{messageOf(error, 'Your role may not read this data.')}</p>
        <div className="alert-strip danger">
          The server grants this tab per role. Ask an administrator if you need access.
        </div>
      </div>
    </Card>
  );
}

function PriorityBadge({ priority }: { priority: Priority }) {
  return priority === 'urgent' ? <Badge tone="danger">URGENT</Badge> : <Badge tone="neutral">routine</Badge>;
}

/* ------------------------------------------------------------------ *
 * Pickers
 * ------------------------------------------------------------------ */

function PatientPicker({
  picked,
  onPick
}: {
  picked: PatientOption | null;
  onPick: (patient: PatientOption | null) => void;
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
    api<{ items: PatientOption[]; total: number }>('/api/patients', {
      query: { q: debounced.trim(), limit: 8 }
    })
      .then((result) => !cancelled && setOptions(result.items))
      .catch((caught) => !cancelled && setError(caught))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  if (picked) {
    return (
      <div className="stack-sm">
        <div className="row">
          <span>
            <strong>{picked.fullName}</strong> <span className="mono subtle">{picked.mrn}</span>{' '}
            <Badge tone={picked.status === 'active' ? 'success' : 'neutral'}>{picked.status}</Badge>
            {picked.age !== null && <span className="subtle"> · {picked.age}y</span>}
          </span>
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => onPick(null)}>
            Change
          </Button>
        </div>
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

/* ------------------------------------------------------------------ *
 * New lab order
 * ------------------------------------------------------------------ */

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (order: LabOrderDetail) => void }) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [testsLoading, setTestsLoading] = useState(true);
  const [testsError, setTestsError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [priority, setPriority] = useState<Priority>('routine');
  const [notes, setNotes] = useState('');
  const [admissions, setAdmissions] = useState<AdmissionOption[]>([]);
  const [admissionId, setAdmissionId] = useState('');
  const [admissionError, setAdmissionError] = useState<unknown>(null);
  const [formError, setFormError] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<LabTest[]>('/api/lab/tests', { query: { active: 'true' } })
      .then(setTests)
      .catch((caught) => setTestsError(caught))
      .finally(() => setTestsLoading(false));
  }, []);

  // An order may hang off an open admission; only look once a patient is chosen.
  useEffect(() => {
    if (!patient) {
      setAdmissions([]);
      setAdmissionId('');
      return;
    }
    let cancelled = false;
    setAdmissionError(null);
    api<{ items: AdmissionOption[]; total: number }>('/api/admissions', {
      query: { patientId: patient.id, status: 'admitted', limit: 5 }
    })
      .then((result) => {
        if (cancelled) return;
        setAdmissions(result.items);
        setAdmissionId(result.items[0]?.id ?? '');
      })
      .catch((caught) => !cancelled && setAdmissionError(caught));
    return () => {
      cancelled = true;
    };
  }, [patient]);

  const chosen = tests.filter((test) => selected[test.id]);
  const runningTotal = chosen.reduce((sum, test) => sum + test.price, 0);
  const visible = filter.trim()
    ? tests.filter((test) => {
        const term = filter.trim().toLowerCase();
        return (
          test.name.toLowerCase().includes(term) ||
          test.code.toLowerCase().includes(term) ||
          test.specimen.toLowerCase().includes(term)
        );
      })
    : tests;

  async function submit() {
    if (!patient) {
      setFormError('Choose a patient first.');
      return;
    }
    if (!chosen.length) {
      setFormError('Tick at least one test.');
      return;
    }
    setFormError('');
    setBusy(true);
    setError(null);
    try {
      // The server de-duplicates testIds, so free selection is safe here.
      const order = await api<LabOrderDetail>('/api/lab/orders', {
        method: 'POST',
        body: {
          patientId: patient.id,
          testIds: chosen.map((test) => test.id),
          priority,
          notes: notes.trim() || null,
          admissionId: admissionId || null
        }
      });
      onCreated(order);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New lab order"
      subtitle="Raises a pending request for the bench to work."
      width="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Create order
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        {formError && <div className="alert-strip danger">{formError}</div>}

        <Field label="Patient" required>
          <PatientPicker picked={patient} onPick={setPatient} />
        </Field>

        {patient && (
          <div className="stack-sm">
            <Field label="Admission link" hint="Optional — only open admissions for this patient are listed.">
              {admissions.length ? (
                <Select value={admissionId} onChange={(event) => setAdmissionId(event.target.value)}>
                  <option value="">None (outpatient order)</option>
                  {admissions.map((admission) => (
                    <option key={admission.id} value={admission.id}>
                      {admission.wardName ?? 'ward not named'}
                      {admission.bedLabel ? ` · bed ${admission.bedLabel}` : ''} ·{' '}
                      {formatDateTime(admission.admittedAt)}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="subtle">This patient has no open admission, so the order stays outpatient.</span>
              )}
            </Field>
            <ErrorNote error={admissionError} onDismiss={() => setAdmissionError(null)} />
          </div>
        )}

        <Field label="Tests" required hint={`${chosen.length} selected · ${formatMoney(runningTotal)}`}>
          <SearchInput value={filter} onChange={setFilter} placeholder="Filter the catalogue by name or code…" />
        </Field>

        {testsLoading && <Loading label="Loading test catalogue…" />}
        <ErrorNote error={testsError} onDismiss={() => setTestsError(null)} />
        {!testsLoading && !testsError && (
          <div className="stack-sm">
            {!visible.length && <EmptyState title="No matching test" hint="Try a different search term." />}
            {visible.map((test) => (
              <label className="checkline" key={test.id}>
                <input
                  type="checkbox"
                  checked={!!selected[test.id]}
                  onChange={(event) =>
                    setSelected((current) => ({ ...current, [test.id]: event.target.checked }))
                  }
                />
                <span>
                  <strong>{test.name}</strong> <span className="mono subtle">{test.code}</span> ·{' '}
                  {test.specimen} · {formatMoney(test.price)}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="row">
          <strong>Running total</strong>
          <span className="spacer" />
          <span className="mono">{formatMoney(runningTotal)}</span>
          <span className="subtle">
            for {chosen.length} test(s)
          </span>
        </div>

        <Field label="Priority" required hint="Urgent orders jump the bench queue.">
          <Select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            <option value="routine">routine</option>
            <option value="urgent">urgent</option>
          </Select>
        </Field>
        <Field label="Notes" hint="Optional, up to 1000 characters.">
          <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Result entry
 * ------------------------------------------------------------------ */

function ResultEntryForm({
  item,
  amend,
  onSaved,
  onCancel
}: {
  item: LabOrderItem;
  amend: boolean;
  onSaved: (response: ResultResponse) => void;
  onCancel: () => void;
}) {
  const [numeric, setNumeric] = useState(
    item.result && item.result.valueNumeric !== null ? String(item.result.valueNumeric) : ''
  );
  const [text, setText] = useState(item.result?.valueText ?? '');
  const [unit, setUnit] = useState(item.result?.unit ?? item.test.unit ?? '');
  const [comment, setComment] = useState(item.result?.comment ?? '');
  const [flag, setFlag] = useState<'' | Flag>('');
  const [errors, setErrors] = useState<{ value?: string; numeric?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const hasNumeric = numeric.trim() !== '';
    const hasText = text.trim() !== '';
    const next: { value?: string; numeric?: string } = {};
    // Mirror the server's refine(): at least one of valueNumeric / valueText.
    if (!hasNumeric && !hasText)
      next.value = 'Enter a numeric value or a text value — one of the two is required.';
    if (hasNumeric && !Number.isFinite(Number(numeric))) next.numeric = 'That is not a number.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      const response = await api<ResultResponse>(`/api/lab/items/${item.id}/result`, {
        method: 'POST',
        body: {
          valueNumeric: hasNumeric ? Number(numeric) : null,
          valueText: hasText ? text.trim() : null,
          unit: unit.trim() || null,
          comment: comment.trim() || null,
          flag: flag || undefined
        }
      });
      onSaved(response);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm">
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <div className="form-grid">
        <Field label="Numeric value" error={errors.numeric} hint={errors.value}>
          <Input
            type="number"
            step="any"
            value={numeric}
            onChange={(event) => setNumeric(event.target.value)}
            placeholder={item.test.referenceLow !== null || item.test.referenceHigh !== null ? 'e.g. 4.2' : 'e.g. 130'}
          />
        </Field>
        <Field label="Text value" hint="For qualitative or morphology results.">
          <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="e.g. no growth" />
        </Field>
        <Field label="Unit" hint={`Defaults to the catalogue unit: ${item.test.unit ?? 'none'}`}>
          <Input value={unit} onChange={(event) => setUnit(event.target.value)} />
        </Field>
        <Field
          label="Flag override"
          hint="Leave blank and the server derives the flag from the reference range."
        >
          <Select value={flag} onChange={(event) => setFlag(event.target.value as '' | Flag)}>
            <option value="">auto (from reference range)</option>
            {FLAGS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Comment" className="form-span-2" hint="Optional, shown with the result.">
          <Input value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
      </div>
      <div className="row">
        <Button variant="primary" size="sm" loading={busy} onClick={submit}>
          {amend ? 'Save corrected result' : 'Save result'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {amend && (
          <span className="subtle">A correction overwrites the previous value and drops its verification sign-off.</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Order detail
 * ------------------------------------------------------------------ */

function OrderDetailModal({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<LabOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [amending, setAmending] = useState<Record<string, boolean>>({});
  const [flagSources, setFlagSources] = useState<Record<string, ResultResponse>>({});
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();

  const mayWork = can(user, ['lab_technician', 'nurse', 'doctor']);
  const mayResult = can(user, ['lab_technician', 'doctor']);
  const mayCancel = can(user, ['lab_technician', 'doctor']);
  const mayVerify = can(user, ['doctor']);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<LabOrderDetail>(`/api/lab/orders/${orderId}`)
      .then(setDetail)
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(load, [load]);

  const missing = detail ? detail.items.filter((item) => !item.result).length : 0;
  const allResulted = !!detail && detail.items.length > 0 && missing === 0;

  async function setStatus(status: OrderStatus, label: string) {
    setBusy(true);
    setActionError(null);
    setNotice('');
    try {
      await api<LabOrderRow>(`/api/lab/orders/${detail!.id}/status`, { method: 'PATCH', body: { status } });
      setNotice(`${label}.`);
      onChanged();
      load();
    } catch (caught) {
      // The server refuses a completion with missing results; show its words.
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function verify(resultId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api<unknown>(`/api/lab/results/${resultId}/verify`, { method: 'POST' });
      setNotice('Result signed off.');
      load();
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={detail ? `${detail.patientName} — lab order` : 'Lab order'}
      subtitle={
        detail ? (
          <>
            <span className="mono">{detail.patientMrn}</span> · ordered by {detail.orderingStaffName} ·{' '}
            {formatDateTime(detail.orderedAt)}
            {detail.wardName ? ` · ${detail.wardName}` : ''}
          </>
        ) : undefined
      }
      width="lg"
      onClose={onClose}
      footer={
        <>
          {mayWork && detail?.status === 'pending' && (
            <Button loading={busy} onClick={() => setStatus('collected', 'Specimen marked collected')}>
              Mark collected
            </Button>
          )}
          {mayWork && detail?.status === 'collected' && (
            <Button loading={busy} onClick={() => setStatus('in_progress', 'Order started')}>
              Start testing
            </Button>
          )}
          {mayResult && detail?.status === 'in_progress' && (
            <Button variant="primary" loading={busy} onClick={() => setStatus('completed', 'Order completed')}>
              Complete order
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading && <Loading label="Loading order…" />}
      {isForbidden(error) && <PermissionNotice error={error} />}
      {!!error && !isForbidden(error) && <ErrorNote error={error} />}
      {!loading && detail && (
        <div className="stack">
          <div className="row">
            <StatusBadge status={detail.status} />
            <PriorityBadge priority={detail.priority} />
            <span className="subtle">
              {detail.testCount} test(s) · {missing} awaiting a result
            </span>
            {detail.admissionId && <Badge tone="clinical">inpatient order</Badge>}
          </div>
          {detail.notes && <div className="muted">{detail.notes}</div>}
          {notice && <div className="alert-strip">{notice}</div>}
          <ErrorNote error={actionError} onDismiss={() => setActionError(null)} />

          {allResulted && detail.status !== 'completed' && detail.status !== 'cancelled' && (
            <div className="alert-strip">
              All tests resulted — you can complete the order.
              {mayResult ? '' : ' Only laboratory or clinician roles can close it.'}
            </div>
          )}
          {detail.status === 'in_progress' && !allResulted && mayResult && (
            <p className="subtle">
              Completion is refused while {missing} test(s) have no result; the server checks this, so just try
              the button.
            </p>
          )}

          {detail.items.map((item) => {
            const saved = flagSources[item.id];
            const showForm = mayResult && (amending[item.id] || !item.result);
            return (
              <div className="card" key={item.id}>
                <div className="card-body padded stack-sm">
                  <div className="row">
                    <strong>
                      {item.test.name} <span className="mono subtle">{item.test.code}</span>
                    </strong>
                    <Badge tone="neutral">{item.test.specimen}</Badge>
                    <span className="spacer" />
                    <span className="subtle nowrap">
                      reference <strong>{referenceLabel(item.test)}</strong>
                    </span>
                  </div>

                  {item.result ? (
                    <div className="stack-sm">
                      <div className="row">
                        <span>
                          <strong className="mono">
                            {item.result.valueNumeric !== null
                              ? `${item.result.valueNumeric}${item.result.unit ? ` ${item.result.unit}` : ''}`
                              : (item.result.valueText ?? '—')}
                          </strong>
                        </span>
                        {item.result.flag && <StatusBadge status={item.result.flag} />}
                        {saved && (
                          <Badge tone={saved.flagSource === 'manual' ? 'warning' : 'info'}>
                            flag {saved.flagSource}
                          </Badge>
                        )}
                        <span className="spacer" />
                        {mayResult && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setAmending((current) => ({ ...current, [item.id]: !current[item.id] }))}
                          >
                            {amending[item.id] ? 'Close editor' : 'Amend result'}
                          </Button>
                        )}
                        {mayVerify && !item.result.verifiedByName && (
                          <Button size="sm" onClick={() => verify(item.result!.id)}>
                            Sign off
                          </Button>
                        )}
                      </div>
                      <div className="detail-list">
                        <div className="detail-item">
                          <span>Resulted</span>
                          <strong>{formatDateTime(item.result.resultedAt)}</strong>
                        </div>
                        <div className="detail-item">
                          <span>By</span>
                          <strong>{item.result.resultedByName ?? '—'}</strong>
                        </div>
                        <div className="detail-item">
                          <span>Verified by</span>
                          <strong>{item.result.verifiedByName ?? 'not signed off'}</strong>
                        </div>
                        <div className="detail-item">
                          <span>Comment</span>
                          <strong>{item.result.comment ?? '—'}</strong>
                        </div>
                      </div>
                      {saved && (
                        <p className="subtle">
                          Server computed “{saved.computedFlag}”{saved.flagSource === 'manual' ? ' but your manual override applied ' : ' and applied '}
                          “{saved.flag}”.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="subtle">No result yet.</p>
                  )}

                  {showForm && (
                    <ResultEntryForm
                      item={item}
                      amend={!!item.result}
                      onCancel={() => setAmending((current) => ({ ...current, [item.id]: false }))}
                      onSaved={(response) => {
                        setFlagSources((current) => ({ ...current, [item.id]: response }));
                        setAmending((current) => ({ ...current, [item.id]: false }));
                        setNotice(
                          response.allItemsResulted
                            ? 'All tests resulted — you can complete the order.'
                            : `Result recorded for ${response.testName}.`
                        );
                        onChanged();
                        load();
                      }}
                    />
                  )}

                  {!mayResult && !item.result && (
                    <p className="subtle">Only laboratory staff or a clinician can enter this result.</p>
                  )}
                </div>
              </div>
            );
          })}

          {!detail.items.length && (
            <EmptyState title="No tests" hint="This order has no items on it." />
          )}

          {mayCancel && detail.status !== 'completed' && detail.status !== 'cancelled' && (
            <CancelOrderBar
              orderId={detail.id}
              onDone={() => {
                onChanged();
                onClose();
              }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function CancelOrderBar({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (reason.trim().length < 3) {
      setFormError('A reason of at least 3 characters is required — it is written to the audit trail.');
      return;
    }
    setFormError('');
    setBusy(true);
    setError(null);
    try {
      await api<LabOrderRow>(`/api/lab/orders/${orderId}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() }
      });
      onDone();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm">
      <h3 className="card-title">Cancel this order</h3>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {formError && <div className="alert-strip danger">{formError}</div>}
      <Field label="Reason" required hint="Required; kept in the audit log — lab orders store no reason column.">
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="row">
        <Button variant="danger" size="sm" loading={busy} onClick={submit}>
          Cancel order for good
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 25;

function WorklistTab({
  user,
  revision,
  onChanged,
  onOpen
}: {
  user: ReturnType<typeof useAuth>['user'];
  revision: number;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<LabOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [priority, setPriority] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState('');

  const mayWork = can(user, ['lab_technician', 'nurse', 'doctor']);
  const mayResult = can(user, ['lab_technician', 'doctor']);
  const mayCancel = can(user, ['lab_technician', 'doctor']);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<LabOrder[]>('/api/lab/orders/worklist', {
      query: {
        // The endpoint takes a comma-separated status list; empty means the
        // server default of pending, collected and in_progress.
        status: statusFilter || undefined,
        priority: priority || undefined,
        limit: 200
      }
    })
      .then((result) => setRows(result))
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, [statusFilter, priority]);

  useEffect(() => {
    load();
  }, [load, revision]);

  async function setStatus(row: LabOrder, status: OrderStatus) {
    setBusyId(row.id);
    setActionError(null);
    try {
      await api<LabOrderRow>(`/api/lab/orders/${row.id}/status`, { method: 'PATCH', body: { status } });
      load();
      onChanged();
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusyId('');
    }
  }

  const columns: Column<LabOrder>[] = [
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => <PriorityBadge priority={row.priority} />
    },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <span>
          <strong>{row.patientName}</strong> <span className="mono subtle">{row.patientMrn}</span>
          {row.wardName && <span className="subtle"> · {row.wardName}</span>}
        </span>
      )
    },
    {
      key: 'tests',
      header: 'Tests',
      render: (row) => (
        <span>
          {row.testNames || <span className="subtle">no tests</span>}{' '}
          <span className="subtle">({row.testCount})</span>
        </span>
      )
    },
    { key: 'orderedBy', header: 'Ordered by', render: (row) => row.orderingStaffName },
    {
      key: 'orderedAt',
      header: 'Ordered',
      render: (row) => <span className="nowrap">{formatDateTime(row.orderedAt)}</span>
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        // stopPropagation: the row itself opens the order detail.
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => onOpen(row.id)}>
            Open
          </Button>
          {mayWork && row.status === 'pending' && (
            <Button size="sm" loading={busyId === row.id} onClick={() => setStatus(row, 'collected')}>
              Collected
            </Button>
          )}
          {mayWork && row.status === 'collected' && (
            <Button size="sm" loading={busyId === row.id} onClick={() => setStatus(row, 'in_progress')}>
              Start
            </Button>
          )}
          {/* Completion is a lab/clinician act; nurses may not close an order. */}
          {mayResult && row.status === 'in_progress' && (
            <Button size="sm" variant="primary" loading={busyId === row.id} onClick={() => setStatus(row, 'completed')}>
              Complete
            </Button>
          )}
          {mayCancel && row.status !== 'completed' && row.status !== 'cancelled' && (
            <Button size="sm" variant="danger" onClick={() => onOpen(row.id)}>
              Cancel
            </Button>
          )}
        </span>
      )
    }
  ];

  const urgentCount = rows.filter((row) => row.priority === 'urgent').length;

  return (
    <Card
      title="Bench worklist"
      subtitle="Live orders only — urgent first, then oldest."
      actions={
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="stack">
        <div className="toolbar">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Status filter">
            <option value="">pending, collected, in progress</option>
            {BENCH_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')} only
              </option>
            ))}
          </Select>
          <Select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Priority filter">
            <option value="">Any priority</option>
            <option value="urgent">urgent only</option>
            <option value="routine">routine only</option>
          </Select>
          <span className="spacer" />
          <Badge tone={urgentCount ? 'danger' : 'neutral'}>{urgentCount} urgent</Badge>
        </div>

        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <ErrorNote error={actionError} onDismiss={() => setActionError(null)} />
            <Table
              columns={columns}
              rows={rows}
              loading={loading}
              empty="The bench is clear — nothing pending, collected or in progress."
              onRowClick={(row) => onOpen(row.id)}
            />
          </>
        )}
      </div>
    </Card>
  );
}

function OrdersTab({ revision, onOpen }: { revision: number; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<LabOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [candidates, setCandidates] = useState<PatientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const debounced = useDebounced(query);

  // /api/lab/orders filters by patientId only, so resolve the typed name first.
  useEffect(() => {
    if (!debounced.trim() || patient) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    api<{ items: PatientOption[]; total: number }>('/api/patients', {
      query: { q: debounced.trim(), limit: 6 }
    })
      .then((result) => !cancelled && setCandidates(result.items))
      .catch(() => !cancelled && setCandidates([]));
    return () => {
      cancelled = true;
    };
  }, [debounced, patient]);

  function load() {
    setLoading(true);
    setError(null);
    api<LabOrderListResult>('/api/lab/orders', {
      query: {
        status: status || undefined,
        priority: priority || undefined,
        patientId: patient?.id,
        limit: PAGE_SIZE,
        offset
      }
    })
      .then((result) => {
        setRows(result.items);
        setTotal(result.total);
      })
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }

  useEffect(load, [status, priority, patient, offset, revision]);

  const columns: Column<LabOrder>[] = [
    {
      key: 'orderedAt',
      header: 'Ordered',
      render: (row) => <span className="nowrap">{formatDateTime(row.orderedAt)}</span>
    },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <span>
          <strong>{row.patientName}</strong> <span className="mono subtle">{row.patientMrn}</span>
        </span>
      )
    },
    {
      key: 'tests',
      header: 'Tests',
      render: (row) => (
        <span>
          {row.testNames || <span className="subtle">—</span>} <span className="subtle">({row.testCount})</span>
        </span>
      )
    },
    { key: 'orderingStaffName', header: 'Ordered by', render: (row) => row.orderingStaffName },
    { key: 'priority', header: 'Priority', render: (row) => <PriorityBadge priority={row.priority} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'completedAt',
      header: 'Closed',
      render: (row) => (row.completedAt ? formatDateTime(row.completedAt) : <span className="subtle">—</span>)
    }
  ];

  return (
    <Card title="All lab orders" subtitle={`${total} order(s) match.`}>
      <div className="stack">
        <div className="toolbar">
          <SearchInput
            value={query}
            onChange={(value) => {
              setQuery(value);
              setOffset(0);
            }}
            placeholder="Search patient to filter…"
          />
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
            aria-label="Status filter"
          >
            <option value="">Any status</option>
            {ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value);
              setOffset(0);
            }}
            aria-label="Priority filter"
          >
            <option value="">Any priority</option>
            <option value="urgent">urgent</option>
            <option value="routine">routine</option>
          </Select>
          {patient && <Badge tone="info">{patient.fullName}</Badge>}
          {patient && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPatient(null);
                setQuery('');
                setOffset(0);
              }}
            >
              Clear patient
            </Button>
          )}
        </div>

        {!!candidates.length && !patient && (
          <div className="stack-sm">
            <p className="subtle">Pick a patient to filter every order by them:</p>
            <div className="row">
              {candidates.map((candidate) => (
                <Button
                  key={candidate.id}
                  size="sm"
                  onClick={() => {
                    setPatient(candidate);
                    setCandidates([]);
                    setOffset(0);
                  }}
                >
                  {candidate.fullName} · <span className="mono">{candidate.mrn}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <Table
              columns={columns}
              rows={rows}
              loading={loading}
              empty="No lab orders for this filter."
              onRowClick={(row) => onOpen(row.id)}
            />
            <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Tests catalogue
 * ------------------------------------------------------------------ */

interface TestDraft {
  code: string;
  name: string;
  specimen: Specimen;
  unit: string;
  referenceLow: string;
  referenceHigh: string;
  referenceText: string;
  price: string;
  isActive: boolean;
}

function testDraftFrom(test: LabTest | null): TestDraft {
  return {
    code: test?.code ?? '',
    name: test?.name ?? '',
    specimen: test?.specimen ?? 'blood',
    unit: test?.unit ?? '',
    referenceLow: test && test.referenceLow !== null ? String(test.referenceLow) : '',
    referenceHigh: test && test.referenceHigh !== null ? String(test.referenceHigh) : '',
    referenceText: test?.referenceText ?? '',
    price: test ? String(test.price) : '',
    isActive: test?.isActive ?? true
  };
}

function TestFormModal({
  test,
  onClose,
  onSaved
}: {
  test: LabTest | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TestDraft>(testDraftFrom(test));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof TestDraft>(key: K, value: TestDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function numericField(raw: string): number | null {
    return raw.trim() === '' ? null : Number(raw);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (draft.code.trim().length < 2) next.code = 'At least 2 characters (stored upper-cased).';
    if (draft.name.trim().length < 2) next.name = 'At least 2 characters.';
    const low = numericField(draft.referenceLow);
    const high = numericField(draft.referenceHigh);
    if (low !== null && !Number.isFinite(low)) next.referenceLow = 'Not a number.';
    if (high !== null && !Number.isFinite(high)) next.referenceHigh = 'Not a number.';
    if (low !== null && high !== null && low > high) next.referenceHigh = 'Must be at or above the lower bound.';
    const price = draft.price.trim() === '' ? 0 : Number(draft.price);
    if (!Number.isFinite(price) || price < 0) next.price = 'Enter 0 or more.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    const body = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      specimen: draft.specimen,
      unit: draft.unit.trim() || null,
      referenceLow: low,
      referenceHigh: high,
      referenceText: draft.referenceText.trim() || null,
      price
    };
    try {
      if (test) {
        await api<LabTest>(`/api/lab/tests/${test.id}`, {
          method: 'PATCH',
          body: { ...body, isActive: draft.isActive }
        });
      } else {
        await api<LabTest>('/api/lab/tests', { method: 'POST', body });
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={test ? `Edit ${test.code}` : 'Add lab test'}
      subtitle="Catalogue entry used for ordering and for flagging results."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {test ? 'Save changes' : 'Create test'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="form-grid">
          <Field label="Code" required error={errors.code} hint="Unique; the server rejects a duplicate and names it above.">
            <Input value={draft.code} onChange={(event) => set('code', event.target.value)} placeholder="FBC" />
          </Field>
          <Field label="Name" required error={errors.name}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="Full blood count" />
          </Field>
          <Field label="Specimen" required>
            <Select value={draft.specimen} onChange={(event) => set('specimen', event.target.value as Specimen)}>
              {SPECIMENS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit" hint="e.g. g/L, 10^9/L.">
            <Input value={draft.unit} onChange={(event) => set('unit', event.target.value)} />
          </Field>
          <Field label="Reference low" error={errors.referenceLow}>
            <Input
              type="number"
              step="any"
              value={draft.referenceLow}
              onChange={(event) => set('referenceLow', event.target.value)}
            />
          </Field>
          <Field label="Reference high" error={errors.referenceHigh}>
            <Input
              type="number"
              step="any"
              value={draft.referenceHigh}
              onChange={(event) => set('referenceHigh', event.target.value)}
            />
          </Field>
          <Field label="Textual reference" className="form-span-2" hint="For qualitative tests, e.g. 'negative'.">
            <Input value={draft.referenceText} onChange={(event) => set('referenceText', event.target.value)} />
          </Field>
          <Field label="Price" required error={errors.price}>
            <Input type="number" min={0} step="0.01" value={draft.price} onChange={(event) => set('price', event.target.value)} />
          </Field>
          {test && (
            <label className="checkline">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => set('isActive', event.target.checked)}
              />
              Active (inactive tests cannot be ordered)
            </label>
          )}
        </div>
        <div className="alert-strip">
          Auto-flagging needs numeric bounds: set both the low and the high reference and the server marks a
          numeric result normal or abnormal against that inclusive range. With neither bound — or for a text-only
          result — everything lands as normal, so set the bounds for any test you expect to be flagged.
        </div>
      </div>
    </Modal>
  );
}

function CatalogueTab({ user }: { user: ReturnType<typeof useAuth>['user'] }) {
  const [rows, setRows] = useState<LabTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showInactive, setShowInactive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LabTest | null>(null);

  const mayWrite = can(user, ['lab_technician', 'doctor']);

  function load() {
    setLoading(true);
    setError(null);
    api<LabTest[]>('/api/lab/tests', { query: { active: showInactive ? 'all' : 'true' } })
      .then(setRows)
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }

  useEffect(load, [showInactive]);

  const columns: Column<LabTest>[] = [
    { key: 'code', header: 'Code', render: (row) => <span className="mono">{row.code}</span> },
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'specimen', header: 'Specimen', render: (row) => row.specimen },
    { key: 'unit', header: 'Unit', render: (row) => row.unit ?? <span className="subtle">—</span> },
    {
      key: 'reference',
      header: 'Reference range',
      render: (row) => (
        <span>
          {referenceLabel(row)}
          {row.referenceLow === null && row.referenceHigh === null && (
            <span className="subtle"> · no auto-flag</span>
          )}
        </span>
      )
    },
    { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.price) },
    {
      key: 'isActive',
      header: 'Active',
      render: (row) => (
        <Badge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? 'active' : 'inactive'}</Badge>
      )
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        mayWrite && (
          <span onClick={(event) => event.stopPropagation()}>
            <Button size="sm" onClick={() => setEditing(row)}>
              Edit
            </Button>
          </span>
        )
    }
  ];

  return (
    <Card
      title="Tests catalogue"
      subtitle={`${rows.length} catalogue item(s).`}
      actions={
        <>
          <label className="checkline">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            include inactive
          </label>
          {mayWrite && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              Add test
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <Table columns={columns} rows={rows} loading={loading} empty="No tests in the catalogue." />
            {!mayWrite && (
              <p className="subtle">
                Catalogue maintenance is limited to laboratory staff and clinicians.
              </p>
            )}
          </>
        )}
        {creating && <TestFormModal test={null} onClose={() => setCreating(false)} onSaved={load} />}
        {editing && <TestFormModal test={editing} onClose={() => setEditing(null)} onSaved={load} />}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

type TabId = 'worklist' | 'orders' | 'catalogue';

export function LabPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>('worklist');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [worklistCount, setWorklistCount] = useState<number | undefined>(undefined);
  const [stamp, setStamp] = useState(0);

  const mayOrder = can(user, ['doctor', 'nurse', 'reception']);

  // Decorative tab badge: the worklist is role-restricted, so ignore its errors
  // here — the tab itself renders the real 403 card.
  useEffect(() => {
    let cancelled = false;
    api<LabOrder[]>('/api/lab/orders/worklist', { query: { limit: 200 } })
      .then((rows) => {
        if (cancelled) return;
        setWorklistCount(rows.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [stamp]);

  const onChanged = () => setStamp((value) => value + 1);

  return (
    <div className="page stack">
      <div className="page-head">
        <div>
          <h2>Laboratory</h2>
          <p>Specimen worklist, result entry and the test catalogue.</p>
        </div>
        <div className="topbar-actions">
          {mayOrder && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New order
            </Button>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="On the bench" value={worklistCount ?? '—'} hint="pending, collected and in progress" />
        <Stat
          label="Your role here"
          value={user?.role ?? '—'}
          hint={
            can(user, ['lab_technician', 'doctor'])
              ? 'you can result and complete orders'
              : 'you can track and move orders only'
          }
        />
      </div>

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'worklist', label: 'Worklist', count: worklistCount },
          { id: 'orders', label: 'Orders' },
          { id: 'catalogue', label: 'Tests catalogue' }
        ]}
      />

      {tab === 'worklist' && (
        <WorklistTab user={user} revision={stamp} onChanged={onChanged} onOpen={(id) => setOpenId(id)} />
      )}
      {tab === 'orders' && <OrdersTab revision={stamp} onOpen={(id) => setOpenId(id)} />}
      {tab === 'catalogue' && <CatalogueTab user={user} />}

      {openId && (
        <OrderDetailModal orderId={openId} onClose={() => setOpenId(null)} onChanged={onChanged} />
      )}

      {creating && (
        <NewOrderModal
          onClose={() => setCreating(false)}
          onCreated={(order) => {
            onChanged();
            setTab('worklist');
            setOpenId(order.id);
          }}
        />
      )}
    </div>
  );
}
