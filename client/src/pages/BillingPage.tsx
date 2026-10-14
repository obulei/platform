import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { classList, formatDate, formatDateTime, formatMoney } from '../utils.js';

/* ------------------------------------------------------------------ *
 * Server-contract types — derived field-for-field from billing.routes.ts
 * ------------------------------------------------------------------ */

type InvoiceStatusValue = 'draft' | 'issued' | 'partial' | 'paid' | 'void';
type ItemCategoryValue = 'consultation' | 'ward' | 'medicine' | 'lab' | 'procedure' | 'other';
type PaymentMethodValue = 'cash' | 'card' | 'mobile_money' | 'insurance' | 'bank_transfer';

/** A row from GET /api/invoices (list). Carries subtotal/paid/balanceDue/itemCount. */
interface InvoiceRow {
  id: string;
  number: string;
  status: InvoiceStatusValue;
  patientId: string;
  patientName: string | null;
  patientMrn: string | null;
  createdAt: string;
  issuedAt: string | null;
  dueAt: string | null;
  itemCount: number;
  subtotal: number;
  paid: number;
  balanceDue: number;
}

interface InvoiceItemDetail {
  id: string;
  description: string;
  category: ItemCategoryValue;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  referenceId: string | null;
  createdAt: string;
}

interface PaymentDetail {
  id: string;
  amount: number;
  method: PaymentMethodValue;
  reference: string | null;
  paidAt: string;
  receivedBy: string | null;
  receiverName: string | null;
}

/** Full view from GET/POST/PATCH/DELETE .../invoices/:id — server-computed totals. */
interface InvoiceDetail {
  id: string;
  number: string;
  status: InvoiceStatusValue;
  patientId: string;
  admissionId: string | null;
  notes: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  createdBy: string | null;
  patientName: string | null;
  patientMrn: string | null;
  items: InvoiceItemDetail[];
  payments: PaymentDetail[];
  subtotal: number;
  paid: number;
  balanceDue: number;
  isOverdue: boolean;
}

/** GET /api/invoices/summary — restricted to billing/reception (WRITE_ROLES). */
interface InvoiceSummary {
  outstanding: { invoiceCount: number; balanceDue: number };
  collectedToday: number;
  collectedThisMonth: number;
  overdueCount: number;
}

interface PatientOption {
  id: string;
  mrn: string;
  fullName: string;
}

interface AppointmentOption {
  id: string;
  startsAt: string;
  reason: string;
  status: string;
  fee: number | null;
  clinicianName: string | null;
}

interface AdmissionOption {
  id: string;
  wardName: string | null;
  status: string;
  admittedAt: string;
  dischargedAt: string | null;
  admittingComplaint: string | null;
}

/* ------------------------------------------------------------------ *
 * Enumerations mirrored from the server's zod schemas
 * ------------------------------------------------------------------ */

const ITEM_CATEGORIES: ItemCategoryValue[] = ['consultation', 'ward', 'medicine', 'lab', 'procedure', 'other'];
const PAYMENT_METHODS: PaymentMethodValue[] = ['cash', 'card', 'mobile_money', 'insurance', 'bank_transfer'];

const CATEGORY_TONE: Record<ItemCategoryValue, 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'clinical'> = {
  consultation: 'info',
  ward: 'clinical',
  medicine: 'success',
  lab: 'warning',
  procedure: 'info',
  other: 'neutral'
};

const PAGE_SIZE = 50;
/** The list endpoint accepts a single status; "Unpaid" merges issued + partial (capped). */
const UNPAID_CAP = 200;

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

/**
 * Mirrors the server's own isOverdue predicate (issued|partial && dueAt < now).
 * The list rows don't carry a flag, so we surface the marker from the exact
 * fields the detail endpoint uses — never touching a money value.
 */
function rowIsOverdue(row: InvoiceRow): boolean {
  const outstanding = row.status === 'issued' || row.status === 'partial';
  return outstanding && row.dueAt !== null && new Date(row.dueAt).getTime() < Date.now();
}

/* ------------------------------------------------------------------ *
 * Reusable patient search (used by the filter, new invoice & encounter)
 * ------------------------------------------------------------------ */

function PatientPicker({
  onSelect,
  placeholder = 'Search patients by name or MRN…',
  compact = false
}: {
  onSelect: (patient: PatientOption) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PatientOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      return;
    }
    const timer = setTimeout(() => {
      const current = ++reqId.current;
      setLoading(true);
      setError(null);
      api<{ items: PatientOption[] }>('/api/patients', { query: { q: trimmed, limit: 8 } })
        .then((res) => {
          if (current !== reqId.current) return;
          setResults(res.items.map((p) => ({ id: p.id, mrn: p.mrn, fullName: p.fullName })));
        })
        .catch((caught) => {
          if (current !== reqId.current) return;
          setError(caught);
        })
        .finally(() => {
          if (current === reqId.current) setLoading(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [term]);

  return (
    <div className="stack stack-sm">
      <SearchInput value={term} onChange={setTerm} placeholder={placeholder} />
      {loading && <Loading label="Searching patients…" />}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {!loading && results.length > 0 && (
        <div className={classList('card', compact && 'flush')} style={{ overflow: 'hidden' }}>
          {results.map((patient) => (
            <button
              type="button"
              key={patient.id}
              className="nav-link"
              style={{ color: 'var(--text)', background: 'var(--surface)' }}
              onClick={() => {
                onSelect(patient);
                setTerm('');
                setResults([]);
              }}
            >
              <span>
                {patient.fullName} <span className="mono muted">· {patient.mrn}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!loading && term.trim() && results.length === 0 && !error && (
        <p className="subtle">No patients match “{term.trim()}”.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Add / edit an invoice line item
 * ------------------------------------------------------------------ */

function ItemFormModal({
  invoiceId,
  item,
  onClose,
  onSaved
}: {
  invoiceId: string;
  item: InvoiceItemDetail | null;
  onClose: () => void;
  onSaved: (detail: InvoiceDetail) => void;
}) {
  const [description, setDescription] = useState(item?.description ?? '');
  const [category, setCategory] = useState<ItemCategoryValue>(item?.category ?? 'other');
  const [quantity, setQuantity] = useState(item ? String(item.quantity) : '1');
  const [unitPrice, setUnitPrice] = useState(item ? String(item.unitPrice) : '');
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Display-only preview: a plain multiplication. The server's lineTotal is what
  // we render in the table after saving.
  const previewQuantity = Number(quantity);
  const previewPrice = Number(unitPrice);
  const preview =
    Number.isFinite(previewQuantity) && Number.isFinite(previewPrice) ? previewQuantity * previewPrice : 0;

  async function save() {
    setFieldError(null);
    if (description.trim().length < 2) {
      setFieldError('Description must be at least 2 characters.');
      return;
    }
    if (!Number.isFinite(previewQuantity) || previewQuantity <= 0) {
      setFieldError('Quantity must be greater than 0.');
      return;
    }
    if (!Number.isFinite(previewPrice) || previewPrice < 0) {
      setFieldError('Unit price must be 0 or more.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        description: description.trim(),
        category,
        quantity: previewQuantity,
        unitPrice: previewPrice
      };
      const detail = item
        ? await api<InvoiceDetail>(`/api/invoices/${invoiceId}/items/${item.id}`, { method: 'PATCH', body: payload })
        : await api<InvoiceDetail>(`/api/invoices/${invoiceId}/items`, { method: 'POST', body: payload });
      onSaved(detail);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? 'Edit line item' : 'Add line item'}
      subtitle="Charges are rounded per line on the server."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {item ? 'Save item' : 'Add item'}
          </Button>
        </>
      }
    >
      <Field label="Description" required error={fieldError ?? undefined}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Category" required>
        <Select value={category} onChange={(e) => setCategory(e.target.value as ItemCategoryValue)}>
          {ITEM_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="form-grid">
        <Field label="Quantity" required hint="Must be greater than 0">
          <Input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Unit price" required hint="0 or more">
          <Input type="number" min={0} step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        </Field>
      </div>
      <div className="alert-strip">
        Line total preview: <span className="mono">{formatMoney(preview)}</span>
        <span className="subtle">· display only — the server computes the saved total</span>
      </div>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Record a payment
 * ------------------------------------------------------------------ */

function PaymentModal({
  invoiceId,
  balanceDue,
  onClose,
  onSaved
}: {
  invoiceId: string;
  balanceDue: number;
  onClose: () => void;
  onSaved: (detail: InvoiceDetail) => void;
}) {
  const [amount, setAmount] = useState(String(balanceDue));
  const [method, setMethod] = useState<PaymentMethodValue>('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setFieldError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFieldError(`Enter an amount greater than 0 — the balance still due is ${formatMoney(balanceDue)}.`);
      return;
    }
    if (value > balanceDue) {
      setFieldError(
        `That is more than the remaining balance. The exact amount still due is ${formatMoney(balanceDue)}.`
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { amount: value, method };
      if (reference.trim()) body.reference = reference.trim();
      if (paidAt) body.paidAt = paidAt;
      const detail = await api<InvoiceDetail>(`/api/invoices/${invoiceId}/payments`, { method: 'POST', body });
      onSaved(detail);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record payment"
      subtitle={`Remaining balance: ${formatMoney(balanceDue)}`}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Record payment
          </Button>
        </>
      }
    >
      <Field label="Amount" required error={fieldError ?? undefined} hint={`Must be more than 0 and no more than ${formatMoney(balanceDue)}.`}>
        <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Method" required>
        <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
          {PAYMENT_METHODS.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Reference" hint="Optional transaction or receipt reference.">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Received on" hint="Optional — defaults to now.">
        <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </Field>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Void an invoice
 * ------------------------------------------------------------------ */

function VoidModal({
  invoiceId,
  onClose,
  onSaved
}: {
  invoiceId: string;
  onClose: () => void;
  onSaved: (detail: InvoiceDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setFieldError(null);
    if (reason.trim().length < 3) {
      setFieldError('A void reason of at least 3 characters is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await api<InvoiceDetail>(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        body: { reason: reason.trim() }
      });
      onSaved(detail);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Void invoice"
      subtitle="Voiding is permanent. Any recorded payments must be reversed first."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={save}>
            Void invoice
          </Button>
        </>
      }
    >
      <Field label="Reason" required error={fieldError ?? undefined}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this invoice being voided?" />
      </Field>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * New invoice (creates a draft)
 * ------------------------------------------------------------------ */

interface DraftLine {
  description: string;
  category: ItemCategoryValue;
  quantity: string;
  unitPrice: string;
}

function emptyLine(): DraftLine {
  return { description: '', category: 'other', quantity: '1', unitPrice: '' };
}

function NewInvoiceModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (detail: InvoiceDetail) => void;
}) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function create() {
    setFieldError(null);
    if (!patient) {
      setFieldError('Choose a patient first.');
      return;
    }
    const items = lines
      .map((line) => ({
        description: line.description.trim(),
        category: line.category,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice)
      }))
      .filter((line) => line.description.length >= 2 || Number.isFinite(line.quantity));
    const valid = lines.filter((line) => {
      const q = Number(line.quantity);
      const p = Number(line.unitPrice);
      return line.description.trim().length >= 2 && Number.isFinite(q) && q > 0 && Number.isFinite(p) && p >= 0;
    });
    if (valid.length === 0) {
      setFieldError('Add at least one line with a description (2+ chars), a quantity above 0 and a price of 0 or more.');
      return;
    }
    void items;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        patientId: patient.id,
        items: valid.map((line) => ({
          description: line.description.trim(),
          category: line.category,
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice)
        }))
      };
      if (notes.trim()) body.notes = notes.trim();
      if (dueDate) body.dueAt = dueDate;
      const detail = await api<InvoiceDetail>('/api/invoices', { method: 'POST', body });
      onCreated(detail);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New invoice"
      subtitle="Creates a draft you can review and issue."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Create draft
          </Button>
        </>
      }
    >
      <Field label="Patient" required error={fieldError ?? undefined}>
        {patient ? (
          <div className="row">
            <span>
              {patient.fullName} <span className="mono muted">· {patient.mrn}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
              Change
            </Button>
          </div>
        ) : (
          <PatientPicker onSelect={setPatient} compact />
        )}
      </Field>
      <div className="form-grid">
        <Field label="Due date" hint="Optional — the server defaults to 14 days after issuing.">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!patient} />
        </Field>
        <Field label="Notes" hint="Optional.">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} disabled={!patient} />
        </Field>
      </div>

      <div className="stack">
        <div className="row">
          <strong>Line items</strong>
          <span className="spacer" />
          <Button size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])} disabled={!patient}>
            Add line
          </Button>
        </div>
        {lines.map((line, index) => (
          <div className="form-grid form-grid-3" key={index}>
            <Field label={`Line ${index + 1} description`}>
              <Input
                value={line.description}
                onChange={(e) => updateLine(index, { description: e.target.value })}
                placeholder="e.g. Ward round"
                maxLength={200}
              />
            </Field>
            <Field label="Category">
              <Select value={line.category} onChange={(e) => updateLine(index, { category: e.target.value as ItemCategoryValue })}>
                {ITEM_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="row">
              <Field label="Qty">
                <Input type="number" min={0} step="any" value={line.quantity} onChange={(e) => updateLine(index, { quantity: e.target.value })} />
              </Field>
              <Field label="Unit price">
                <Input type="number" min={0} step="0.01" value={line.unitPrice} onChange={(e) => updateLine(index, { unitPrice: e.target.value })} />
              </Field>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                disabled={lines.length <= 1}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Bill an encounter (completed appointment or admission)
 * ------------------------------------------------------------------ */

function EncounterModal({
  onClose,
  onBilled,
  openInvoiceByNumber
}: {
  onClose: () => void;
  onBilled: (detail: InvoiceDetail) => void;
  openInvoiceByNumber: (number: string) => void;
}) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [appointments, setAppointments] = useState<AppointmentOption[]>([]);
  const [admissions, setAdmissions] = useState<AdmissionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<unknown>(null);
  const [chosen, setChosen] = useState<{ kind: 'appointment' | 'admission'; id: string } | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [existingNumber, setExistingNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!patient) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    setChosen(null);
    setExistingNumber(null);
    Promise.all([
      api<AppointmentOption[]>('/api/appointments', { query: { patientId: patient.id, status: 'completed', limit: 100 } }),
      api<{ items: AdmissionOption[] }>('/api/admissions', { query: { patientId: patient.id, limit: 100 } })
    ])
      .then(([appts, adms]) => {
        if (cancelled) return;
        setAppointments(appts);
        setAdmissions(adms.items);
      })
      .catch((caught) => {
        if (!cancelled) setListError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patient]);

  async function bill() {
    if (!chosen) return;
    setBusy(true);
    setSubmitError(null);
    setExistingNumber(null);
    try {
      const body = chosen.kind === 'appointment' ? { appointmentId: chosen.id } : { admissionId: chosen.id };
      const detail = await api<InvoiceDetail>('/api/invoices/from-encounter', { method: 'POST', body });
      onBilled(detail);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      const match = /already exists:\s*([A-Za-z0-9-]+)\.?/i.exec(message);
      if (match) {
        setExistingNumber(match[1]);
      } else {
        setSubmitError(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Bill an encounter"
      subtitle="Roll a completed appointment or admission into a draft invoice."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!chosen} onClick={bill}>
            Create draft
          </Button>
        </>
      }
    >
      <Field label="Patient" required>
        {patient ? (
          <div className="row">
            <span>
              {patient.fullName} <span className="mono muted">· {patient.mrn}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => { setPatient(null); setChosen(null); }}>
              Change
            </Button>
          </div>
        ) : (
          <PatientPicker onSelect={setPatient} compact />
        )}
      </Field>

      {patient && loading && <Loading label="Loading encounters…" />}
      {patient && !loading && <ErrorNote error={listError} onDismiss={() => setListError(null)} />}

      {patient && !loading && (
        <div className="stack">
          {appointments.length > 0 && (
            <Card title="Completed appointments" padded={false}>
              <Table<AppointmentOption & { id: string }>
                columns={[
                  { key: 'when', header: 'When', render: (r) => formatDateTime(r.startsAt) },
                  { key: 'reason', header: 'Reason', render: (r) => r.reason },
                  { key: 'fee', header: 'Fee', align: 'right', render: (r) => formatMoney(r.fee ?? 0) },
                  {
                    key: 'pick',
                    header: '',
                    render: (r) => (
                      <Button
                        size="sm"
                        variant={chosen?.id === r.id ? 'primary' : 'secondary'}
                        onClick={() => setChosen({ kind: 'appointment', id: r.id })}
                      >
                        {chosen?.id === r.id ? 'Selected' : 'Bill'}
                      </Button>
                    )
                  }
                ]}
                rows={appointments}
                empty="No completed appointments."
              />
            </Card>
          )}

          {admissions.length > 0 && (
            <Card title="Admissions" padded={false}>
              <Table<AdmissionOption & { id: string }>
                columns={[
                  { key: 'ward', header: 'Ward', render: (r) => r.wardName ?? '—' },
                  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                  { key: 'admitted', header: 'Admitted', render: (r) => formatDateTime(r.admittedAt) },
                  { key: 'discharged', header: 'Discharged', render: (r) => (r.dischargedAt ? formatDateTime(r.dischargedAt) : 'Open') },
                  {
                    key: 'pick',
                    header: '',
                    render: (r) => (
                      <Button
                        size="sm"
                        variant={chosen?.id === r.id ? 'primary' : 'secondary'}
                        onClick={() => setChosen({ kind: 'admission', id: r.id })}
                      >
                        {chosen?.id === r.id ? 'Selected' : 'Bill'}
                      </Button>
                    )
                  }
                ]}
                rows={admissions}
                empty="No admissions."
              />
            </Card>
          )}

          {appointments.length === 0 && admissions.length === 0 && (
            <EmptyState title="Nothing to bill" hint="This patient has no completed appointments or admissions." />
          )}
        </div>
      )}

      {existingNumber && (
        <div className="alert-strip">
          <span>
            A draft already exists: <span className="mono">{existingNumber}</span> — the server keeps one draft per
            encounter.
          </span>
          <span className="spacer" />
          <Button size="sm" variant="primary" onClick={() => { openInvoiceByNumber(existingNumber); onClose(); }}>
            Open {existingNumber}
          </Button>
        </div>
      )}

      <ErrorNote error={submitError} onDismiss={() => setSubmitError(null)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Invoice detail panel (wide modal) — read + guarded mutations
 * ------------------------------------------------------------------ */

function InvoicePanel({
  invoiceId,
  canWrite,
  canVoidOps,
  onClose,
  onChanged,
  refreshAll
}: {
  invoiceId: string;
  canWrite: boolean;
  canVoidOps: boolean;
  onClose: () => void;
  onChanged: (detail: InvoiceDetail) => void;
  refreshAll: () => void;
}) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [itemModal, setItemModal] = useState<{ open: boolean; item: InvoiceItemDetail | null }>({ open: false, item: null });
  const [payModal, setPayModal] = useState(false);
  const [voidModal, setVoidModal] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const current = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api<InvoiceDetail>(`/api/invoices/${invoiceId}`);
      if (current !== reqId.current) return;
      setDetail(res);
    } catch (caught) {
      if (current === reqId.current) setError(caught);
    } finally {
      if (current === reqId.current) setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterMutation(res: InvoiceDetail) {
    setDetail(res);
    onChanged(res);
    refreshAll();
  }

  async function issue() {
    setBusyAction('issue');
    setActionError(null);
    try {
      const res = await api<InvoiceDetail>(`/api/invoices/${invoiceId}/issue`, { method: 'POST' });
      afterMutation(res);
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusyAction(null);
    }
  }

  async function removeItem(itemId: string) {
    setBusyAction(itemId);
    setActionError(null);
    try {
      const res = await api<InvoiceDetail>(`/api/invoices/${invoiceId}/items/${itemId}`, { method: 'DELETE' });
      afterMutation(res);
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusyAction(null);
    }
  }

  async function reversePayment(paymentId: string) {
    setBusyAction(paymentId);
    setActionError(null);
    try {
      const res = await api<InvoiceDetail>(`/api/invoices/${invoiceId}/payments/${paymentId}`, { method: 'DELETE' });
      afterMutation(res);
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusyAction(null);
    }
  }

  if (loading) {
    return (
      <Modal title="Invoice" onClose={onClose} width="lg">
        <Loading label="Loading invoice…" />
      </Modal>
    );
  }

  if (error || !detail) {
    return (
      <Modal title="Invoice" onClose={onClose} width="lg">
        <ErrorNote error={error ?? 'Invoice could not be loaded.'} />
      </Modal>
    );
  }

  const voidInvoice = detail.status === 'void';
  const frozen = voidInvoice;
  const hasMoney = detail.paid > 0 || detail.payments.length > 0;
  // Items edit only while draft, or issued with zero payments. Hide when paid > 0.
  const itemsEditable = canWrite && !frozen && (detail.status === 'draft' || detail.status === 'issued') && !hasMoney;
  const canIssue = canWrite && detail.status === 'draft';
  const canReceivePayment = canWrite && (detail.status === 'issued' || detail.status === 'partial') && detail.balanceDue > 0;
  const canVoid = canVoidOps && !voidInvoice;

  const itemColumns: Column<InvoiceItemDetail>[] = [
    { key: 'description', header: 'Description', render: (r) => r.description },
    { key: 'category', header: 'Category', render: (r) => <Badge tone={CATEGORY_TONE[r.category]}>{humanize(r.category)}</Badge> },
    { key: 'quantity', header: 'Qty', align: 'right', render: (r) => String(r.quantity) },
    { key: 'unitPrice', header: 'Unit price', align: 'right', render: (r) => formatMoney(r.unitPrice) },
    { key: 'lineTotal', header: 'Line total', align: 'right', render: (r) => <span className="strong">{formatMoney(r.lineTotal)}</span> }
  ];
  if (itemsEditable) {
    itemColumns.push({
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <span className="row-actions">
          <Button size="sm" variant="ghost" onClick={() => setItemModal({ open: true, item: r })}>
            Edit
          </Button>
          <Button size="sm" variant="danger" loading={busyAction === r.id} onClick={() => void removeItem(r.id)}>
            Remove
          </Button>
        </span>
      )
    });
  }

  const footer = (
    <>
      {canIssue && (
        <span className="subtle">
          {detail.items.length === 0
            ? 'Add at least one item before issuing.'
            : `Issue this draft (${detail.items.length} item${detail.items.length === 1 ? '' : 's'}).`}
        </span>
      )}
      <span className="spacer" />
      {canVoid && hasMoney && <span className="subtle">Reverse every payment before voiding.</span>}
      {canIssue && (
        <Button variant="primary" disabled={detail.items.length === 0} loading={busyAction === 'issue'} onClick={() => void issue()}>
          Issue invoice
        </Button>
      )}
      {itemsEditable && (
        <Button onClick={() => setItemModal({ open: true, item: null })}>Add item</Button>
      )}
      {canReceivePayment && (
        <Button variant="primary" onClick={() => setPayModal(true)}>
          Record payment
        </Button>
      )}
      {canVoid && (
        <Button variant="danger" disabled={hasMoney} onClick={() => setVoidModal(true)}>
          Void invoice
        </Button>
      )}
    </>
  );

  return (
    <>
      <Modal
        title={`Invoice ${detail.number}`}
        subtitle={<span>{detail.patientName ?? 'Unknown patient'} {detail.patientMrn ? `· ${detail.patientMrn}` : ''}</span>}
        onClose={onClose}
        width="lg"
        footer={footer}
      >
        {voidInvoice && <div className="alert-strip danger">This invoice is void — it is read-only and cannot change.</div>}
        {itemsEditable && hasMoney && (
          <div className="alert-strip">A payment has landed — the ledger is frozen. Reverse it before editing items.</div>
        )}

        <div className="detail-list">
          <div className="detail-item">
            <span>Status</span>
            <strong>
              <StatusBadge status={detail.status} />
            </strong>
          </div>
          <div className="detail-item">
            <span>Patient</span>
            <strong>{detail.patientName ?? '—'}</strong>
          </div>
          <div className="detail-item">
            <span>MRN</span>
            <strong className="mono">{detail.patientMrn ?? '—'}</strong>
          </div>
          <div className="detail-item">
            <span>Admission</span>
            <strong className="mono">{detail.admissionId ? `${detail.admissionId.slice(0, 8)}…` : '—'}</strong>
          </div>
          <div className="detail-item">
            <span>Issued</span>
            <strong>{formatDate(detail.issuedAt)}</strong>
          </div>
          <div className="detail-item">
            <span>Due</span>
            <strong>{formatDate(detail.dueAt)}</strong>
          </div>
        </div>

        {detail.notes && (
          <div className="detail-item">
            <span>Notes</span>
            <strong style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{detail.notes}</strong>
          </div>
        )}

        <div className="stack stack-sm">
          <div className="row">
            <strong>Items ({detail.items.length})</strong>
          </div>
          <Table<InvoiceItemDetail> columns={itemColumns} rows={detail.items} empty="No items yet. Add at least one before issuing." />
        </div>

        <div className="stack stack-sm">
          <strong>Payments ({detail.payments.length})</strong>
          {detail.payments.length === 0 ? (
            <p className="subtle">No payments recorded.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th>Received by</th>
                    <th>Date</th>
                    {canVoidOps && <th />}
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((payment, index) => (
                    <tr key={payment.id}>
                      <td className="num">
                        <span className="strong">{formatMoney(payment.amount)}</span>
                      </td>
                      <td>
                        <Badge tone="neutral">{humanize(payment.method)}</Badge>
                      </td>
                      <td>{payment.reference ?? <span className="muted">—</span>}</td>
                      <td>{payment.receiverName ?? <span className="muted">—</span>}</td>
                      <td>{formatDateTime(payment.paidAt)}</td>
                      {canVoidOps && (
                        <td className="num">
                          {index === 0 ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busyAction === payment.id}
                              onClick={() => void reversePayment(payment.id)}
                            >
                              Reverse last payment
                            </Button>
                          ) : (
                            <span className="subtle">older</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="stack stack-sm">
          {detail.isOverdue && <div className="alert-strip danger">Overdue — the due date has passed with a balance outstanding.</div>}
          <div className="detail-list">
            <div className="detail-item">
              <span>Subtotal</span>
              <strong>{formatMoney(detail.subtotal)}</strong>
            </div>
            <div className="detail-item">
              <span>Paid</span>
              <strong>{formatMoney(detail.paid)}</strong>
            </div>
            <div className="detail-item">
              <span>Balance due</span>
              <strong style={{ color: detail.balanceDue > 0 ? 'var(--danger)' : 'var(--success)' }}>
                {formatMoney(detail.balanceDue)}
              </strong>
            </div>
          </div>
        </div>

        <ErrorNote error={actionError} onDismiss={() => setActionError(null)} />
      </Modal>

      {itemModal.open && (
        <ItemFormModal
          invoiceId={invoiceId}
          item={itemModal.item}
          onClose={() => setItemModal({ open: false, item: null })}
          onSaved={afterMutation}
        />
      )}
      {payModal && (
        <PaymentModal
          invoiceId={invoiceId}
          balanceDue={detail.balanceDue}
          onClose={() => setPayModal(false)}
          onSaved={afterMutation}
        />
      )}
      {voidModal && (
        <VoidModal invoiceId={invoiceId} onClose={() => setVoidModal(false)} onSaved={afterMutation} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

type TabId = 'all' | 'unpaid' | 'draft' | 'paid' | 'void';

const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: 'All invoices' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'draft', label: 'Drafts' },
  { id: 'paid', label: 'Paid' },
  { id: 'void', label: 'Void' }
];

export function BillingPage() {
  const { user } = useAuth();
  const canWrite = can(user, ['billing', 'reception']);
  const canVoidOps = can(user, ['billing']);

  // Summary (needs billing/reception — the endpoint is WRITE_ROLES).
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<unknown>(null);

  // List.
  const [tab, setTab] = useState<TabId>('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [patientFilter, setPatientFilter] = useState<PatientOption | null>(null);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<unknown>(null);
  const forbidden = listError instanceof ApiError && listError.status === 403;
  const listReqId = useRef(0);

  // Panel + modals.
  const [panelId, setPanelId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [encounterOpen, setEncounterOpen] = useState(false);

  // Debounce the search term into an applied query.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qInput.trim());
      setOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [qInput]);

  const fetchSummary = useCallback(async () => {
    if (!canWrite) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      setSummary(await api<InvoiceSummary>('/api/invoices/summary'));
    } catch (caught) {
      setSummaryError(caught);
    } finally {
      setSummaryLoading(false);
    }
  }, [canWrite]);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const fetchList = useCallback(async () => {
    const current = ++listReqId.current;
    setListLoading(true);
    setListError(null);
    const base: Record<string, string | number> = {};
    if (q) base.q = q;
    if (from) base.from = from;
    if (to) base.to = to;
    if (patientFilter) base.patientId = patientFilter.id;
    try {
      if (tab === 'unpaid') {
        const [issued, partial] = await Promise.all([
          api<{ items: InvoiceRow[] }>('/api/invoices', { query: { ...base, status: 'issued', limit: UNPAID_CAP, offset: 0 } }),
          api<{ items: InvoiceRow[] }>('/api/invoices', { query: { ...base, status: 'partial', limit: UNPAID_CAP, offset: 0 } })
        ]);
        if (current !== listReqId.current) return;
        const merged = [...issued.items, ...partial.items].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setTotal(merged.length);
        setRows(merged.slice(offset, offset + PAGE_SIZE));
      } else {
        const res = await api<{ items: InvoiceRow[]; total: number }>('/api/invoices', {
          query: { ...base, status: tab === 'all' ? undefined : tab, limit: PAGE_SIZE, offset }
        });
        if (current !== listReqId.current) return;
        setTotal(res.total);
        setRows(res.items);
      }
    } catch (caught) {
      if (current === listReqId.current) setListError(caught);
    } finally {
      if (current === listReqId.current) setListLoading(false);
    }
  }, [tab, q, from, to, patientFilter, offset]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  function refreshAll() {
    void fetchList();
    void fetchSummary();
  }

  function changeTab(next: TabId) {
    setTab(next);
    setOffset(0);
  }

  async function openInvoiceByNumber(number: string) {
    try {
      const res = await api<{ items: InvoiceRow[] }>('/api/invoices', { query: { q: number, limit: 5 } });
      const found = res.items.find((row) => row.number.toLowerCase() === number.toLowerCase()) ?? res.items[0];
      if (found) setPanelId(found.id);
    } catch (caught) {
      setListError(caught);
    }
  }

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Number', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'patient',
      header: 'Patient',
      render: (r) => (
        <div className="stack stack-sm">
          <span>{r.patientName ?? '—'}</span>
          <span className="subtle mono">{r.patientMrn ?? ''}</span>
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className="row">
          <StatusBadge status={r.status} />
          {rowIsOverdue(r) && <Badge tone="danger">Overdue</Badge>}
        </span>
      )
    },
    { key: 'subtotal', header: 'Subtotal', align: 'right', render: (r) => formatMoney(r.subtotal) },
    { key: 'paid', header: 'Paid', align: 'right', render: (r) => formatMoney(r.paid) },
    {
      key: 'balanceDue',
      header: 'Balance due',
      align: 'right',
      render: (r) => (
        <span className={classList(r.balanceDue > 0 && 'strong')} style={r.balanceDue > 0 ? { color: 'var(--danger)' } : undefined}>
          {formatMoney(r.balanceDue)}
        </span>
      )
    },
    { key: 'itemCount', header: 'Items', align: 'right', render: (r) => String(r.itemCount) },
    { key: 'issued', header: 'Issued', render: (r) => formatDate(r.issuedAt) }
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Billing workbench</h2>
          <p>Invoices, payments and money owed — the figures shown come straight from the server.</p>
        </div>
        <div className="toolbar">
          {canWrite && (
            <>
              <Button onClick={() => setEncounterOpen(true)}>Bill an encounter</Button>
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                New invoice
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Summary */}
      {!canWrite ? (
        <Card>
          <p className="muted">Money summary is limited to billing and reception staff.</p>
        </Card>
      ) : (
        <div className="stat-grid">
          {summaryLoading && !summary ? (
            <Loading label="Loading money figures…" />
          ) : summaryError ? (
            <Card>
              <ErrorNote error={summaryError} onDismiss={() => setSummaryError(null)} />
            </Card>
          ) : summary ? (
            <>
              <Stat
                label="Outstanding balance"
                value={formatMoney(summary.outstanding.balanceDue)}
                hint={`${summary.outstanding.invoiceCount} open invoice${summary.outstanding.invoiceCount === 1 ? '' : 's'}`}
                tone="warning"
              />
              <Stat label="Collected today" value={formatMoney(summary.collectedToday)} tone="success" />
              <Stat label="Collected this month" value={formatMoney(summary.collectedThisMonth)} tone="success" />
              <Stat label="Overdue invoices" value={String(summary.overdueCount)} hint="past their due date" tone="danger" />
            </>
          ) : (
            <Loading label="Loading…" />
          )}
        </div>
      )}

      {/* Table + filters */}
      <Card padded={false}>
        <div className="stack" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px 0' }}>
            <div className="tabs-host">
              <Tabs<TabId>
                tabs={TABS.map((t) => (
                  { id: t.id, label: t.label, count: t.id === 'unpaid' ? summary?.outstanding.invoiceCount : undefined }
                ))}
                active={tab}
                onChange={changeTab}
              />
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <SearchInput value={qInput} onChange={setQInput} placeholder="Search invoice no. or patient…" />
              <Field label="From">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setOffset(0);
                  }}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setOffset(0);
                  }}
                />
              </Field>
              {patientFilter ? (
                <span className="row">
                  <Badge tone="info">
                    {patientFilter.fullName} · {patientFilter.mrn}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPatientFilter(null);
                      setOffset(0);
                    }}
                  >
                    Clear patient
                  </Button>
                </span>
              ) : (
                <div style={{ minWidth: 240 }}>
                  <PatientPicker
                    compact
                    placeholder="Filter by patient…"
                    onSelect={(p) => {
                      setPatientFilter(p);
                      setOffset(0);
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {forbidden ? (
            <div style={{ padding: 16 }}>
              <Card>
                <EmptyState
                  title="No billing access"
                  hint="Your role cannot view invoices here. Ask a billing, reception or administrator user for access."
                />
              </Card>
            </div>
          ) : (
            <>
              <div style={{ padding: '8px 0 0' }}>
                <ErrorNote error={listError} onDismiss={() => setListError(null)} />
              </div>
              <Table<InvoiceRow>
                columns={columns}
                rows={rows}
                loading={listLoading}
                empty="No invoices match these filters."
                onRowClick={(row) => setPanelId(row.id)}
              />
              <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
            </>
          )}
        </div>
      </Card>

      {panelId && (
        <InvoicePanel
          invoiceId={panelId}
          canWrite={canWrite}
          canVoidOps={canVoidOps}
          onClose={() => setPanelId(null)}
          onChanged={() => undefined}
          refreshAll={refreshAll}
        />
      )}

      {newOpen && (
        <NewInvoiceModal
          onClose={() => setNewOpen(false)}
          onCreated={(detail) => {
            refreshAll();
            setPanelId(detail.id);
          }}
        />
      )}

      {encounterOpen && (
        <EncounterModal
          onClose={() => setEncounterOpen(false)}
          openInvoiceByNumber={(number) => void openInvoiceByNumber(number)}
          onBilled={(detail) => {
            refreshAll();
            setPanelId(detail.id);
          }}
        />
      )}
    </div>
  );
}
