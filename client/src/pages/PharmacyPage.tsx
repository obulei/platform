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
import { formatDate, formatDateTime, formatMoney } from '../utils.js';

/* ------------------------------------------------------------------ *
 * Types mirrored from server/src/modules/pharmacy.routes.ts DTOs.
 * ------------------------------------------------------------------ */

type MedicineForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'injection'
  | 'ointment'
  | 'drops'
  | 'inhaler'
  | 'other';

type MovementReason = 'purchase' | 'dispense' | 'adjustment' | 'return' | 'wastage';
type PrescriptionStatus = 'pending' | 'partially_dispensed' | 'dispensed' | 'cancelled';

const MEDICINE_FORMS: MedicineForm[] = [
  'tablet',
  'capsule',
  'syrup',
  'injection',
  'ointment',
  'drops',
  'inhaler',
  'other'
];
const MOVEMENT_REASONS: MovementReason[] = ['purchase', 'dispense', 'adjustment', 'return', 'wastage'];
const PRESCRIPTION_STATUSES: PrescriptionStatus[] = [
  'pending',
  'partially_dispensed',
  'dispensed',
  'cancelled'
];

/** toMedicineDto() in the route file. */
interface Medicine {
  id: string;
  name: string;
  genericName: string | null;
  form: MedicineForm;
  strength: string;
  unit: string;
  price: number;
  stock: number;
  reorderLevel: number;
  isActive: boolean;
  isLowStock: boolean;
}

interface MedicineListResult {
  items: Medicine[];
  total: number;
  offset: number;
  limit: number;
}

/** The projection the detail endpoint joins from stock_movements + staff. */
interface StockMovement {
  id: string;
  quantityChange: number;
  reason: MovementReason;
  reference: string | null;
  createdAt: string;
  performedByName: string | null;
  performedByRole: string | null;
}

interface MedicineDetail extends Medicine {
  createdAt: string;
  updatedAt: string;
  recentMovements: StockMovement[];
}

/** GET /api/pharmacy/queue — a bare array, oldest first. */
interface QueueEntry {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  prescriberName: string;
  status: PrescriptionStatus;
  createdAt: string;
  itemCount: number;
  remainingQuantity: number;
}

/** GET /api/prescriptions row. */
interface PrescriptionSummary {
  id: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  prescriberName: string;
  status: PrescriptionStatus;
  notes: string | null;
  createdAt: string;
  itemCount: number;
  totalQuantity: number;
}

interface PrescriptionListResult {
  items: PrescriptionSummary[];
  total: number;
  offset: number;
  limit: number;
}

/** GET /api/prescriptions/:id item — carries live medicine stock. */
interface PrescriptionItem {
  id: string;
  medicineId: string;
  medicineName: string;
  genericName: string | null;
  form: MedicineForm;
  strength: string;
  unit: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  dispensedQuantity: number;
  instructions: string | null;
  currentStock: number;
  remaining: number;
}

interface PrescriptionDetail extends Omit<PrescriptionSummary, 'itemCount' | 'totalQuantity'> {
  prescriberId: string;
  admissionId: string | null;
  appointmentId: string | null;
  updatedAt: string;
  items: PrescriptionItem[];
}

interface PatientOption {
  id: string;
  mrn: string;
  fullName: string;
  status: string;
  age: number | null;
}

interface PatientListResult {
  items: PatientOption[];
  total: number;
}

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Waiting time for the counter, rendered from the queue's oldest-first ordering. */
function ageLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function PermissionNotice({ error }: { error: unknown }) {
  return (
    <Card title="Not available for your role">
      <div className="stack">
        <p className="muted">{messageOf(error, 'Your role may not read this data.')}</p>
        <div className="alert-strip danger">
          Access to this tab is granted per role by the server. Ask an administrator if you need it.
        </div>
      </div>
    </Card>
  );
}

function QuantityBadge({ change }: { change: number }) {
  return (
    <Badge tone={change > 0 ? 'success' : 'danger'}>{change > 0 ? `+${change}` : change}</Badge>
  );
}

/** Signed stock number: flagged once the shelf is at or under its reorder point. */
function StockCell({ medicine }: { medicine: Medicine }) {
  const low = medicine.stock <= medicine.reorderLevel;
  return (
    <span className="row stack-sm nowrap">
      <strong className="mono">{medicine.stock}</strong>
      {low && <Badge tone="danger">reorder</Badge>}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Pickers
 * ------------------------------------------------------------------ */

function PatientPicker({ onPick }: { onPick: (patient: PatientOption) => void }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PatientOption | null>(null);
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
    api<PatientListResult>('/api/patients', { query: { q: debounced.trim(), limit: 8 } })
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
          <div>
            <strong>{picked.fullName}</strong> <span className="mono subtle">{picked.mrn}</span>{' '}
            <Badge tone={picked.status === 'active' ? 'success' : 'neutral'}>{picked.status}</Badge>
          </div>
          <span className="spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPicked(null);
              setQuery('');
              setOptions([]);
            }}
          >
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
                setPicked(patient);
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

function MedicinePicker({ onPick }: { onPick: (medicine: Medicine) => void }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Medicine[]>([]);
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
    api<MedicineListResult>('/api/medicines', { query: { q: debounced.trim(), limit: 15 } })
      // The list endpoint has no active-only filter, so drop inactive here.
      .then((result) => !cancelled && setOptions(result.items.filter((medicine) => medicine.isActive)))
      .catch((caught) => !cancelled && setError(caught))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return (
    <div className="stack-sm">
      <SearchInput value={query} onChange={setQuery} placeholder="Search medicine…" />
      {loading && <Loading label="Searching medicines…" />}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {!!options.length && (
        <div className="stack-sm">
          {options.map((medicine) => (
            <Button
              key={medicine.id}
              size="sm"
              variant="secondary"
              onClick={() => {
                setQuery('');
                setOptions([]);
                onPick(medicine);
              }}
            >
              {medicine.name} {medicine.strength} · stock{' '}
              <span className="mono">{medicine.stock}</span>
              {medicine.stock <= medicine.reorderLevel ? ' (low)' : ''}
            </Button>
          ))}
        </div>
      )}
      {!loading && !!debounced.trim() && !options.length && !error && (
        <p className="subtle">No active medicine matches “{debounced.trim()}”.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Medicine modals
 * ------------------------------------------------------------------ */

interface MedicineDraft {
  name: string;
  genericName: string;
  form: MedicineForm;
  strength: string;
  unit: string;
  price: string;
  stock: string;
  reorderLevel: string;
  isActive: boolean;
}

const EMPTY_DRAFT: MedicineDraft = {
  name: '',
  genericName: '',
  form: 'tablet',
  strength: '',
  unit: 'tablet',
  price: '',
  stock: '',
  reorderLevel: '',
  isActive: true
};

function draftFrom(medicine: Medicine): MedicineDraft {
  return {
    name: medicine.name,
    genericName: medicine.genericName ?? '',
    form: medicine.form,
    strength: medicine.strength,
    unit: medicine.unit,
    price: String(medicine.price),
    stock: String(medicine.stock),
    reorderLevel: String(medicine.reorderLevel),
    isActive: medicine.isActive
  };
}

/** Create + edit in one form: only create exposes the opening quantity. */
function MedicineFormModal({
  medicine,
  onClose,
  onSaved
}: {
  medicine: Medicine | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = medicine !== null;
  const [draft, setDraft] = useState<MedicineDraft>(
    medicine ? draftFrom(medicine) : { ...EMPTY_DRAFT, unit: 'tablet' }
  );
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function set<K extends keyof MedicineDraft>(key: K, value: MedicineDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!draft.name.trim()) errors.name = 'Required.';
    if (!draft.strength.trim()) errors.strength = 'Required, e.g. 500 mg.';
    if (!draft.unit.trim()) errors.unit = 'Required, e.g. tablet, bottle, ampoule.';
    const price = Number(draft.price);
    if (!draft.price.trim() || !Number.isFinite(price) || price < 0) errors.price = 'Enter a price of 0 or more.';
    const reorderLevel = Number(draft.reorderLevel || 0);
    if (!Number.isInteger(reorderLevel) || reorderLevel < 0)
      errors.reorderLevel = 'Whole units, 0 or more.';
    if (!isEdit) {
      const stock = Number(draft.stock || 0);
      if (!Number.isInteger(stock) || stock < 0) errors.stock = 'Whole units, 0 or more.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    const price = Number(draft.price);
    const reorderLevel = Number(draft.reorderLevel || 0);
    try {
      if (isEdit) {
        await api<Medicine>(`/api/medicines/${medicine.id}`, {
          method: 'PATCH',
          body: {
            name: draft.name.trim(),
            genericName: draft.genericName.trim() || null,
            form: draft.form,
            strength: draft.strength.trim(),
            unit: draft.unit.trim(),
            price,
            reorderLevel,
            isActive: draft.isActive
          }
        });
      } else {
        await api<Medicine>('/api/medicines', {
          method: 'POST',
          body: {
            name: draft.name.trim(),
            genericName: draft.genericName.trim() || null,
            form: draft.form,
            strength: draft.strength.trim(),
            unit: draft.unit.trim(),
            price,
            stock: Number(draft.stock || 0),
            reorderLevel
          }
        });
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
      title={isEdit ? `Edit ${medicine.name}` : 'Add medicine'}
      subtitle={isEdit ? 'Catalogue details only — stock moves through the ledger.' : 'Adds a catalogue entry.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {isEdit ? 'Save changes' : 'Create medicine'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="form-grid">
          <Field label="Trade name" required error={fieldErrors.name}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label="Generic name" hint="Optional.">
            <Input value={draft.genericName} onChange={(event) => set('genericName', event.target.value)} />
          </Field>
          <Field label="Form" required>
            <Select value={draft.form} onChange={(event) => set('form', event.target.value as MedicineForm)}>
              {MEDICINE_FORMS.map((form) => (
                <option key={form} value={form}>
                  {form}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Strength" required error={fieldErrors.strength}>
            <Input
              value={draft.strength}
              placeholder="500 mg"
              onChange={(event) => set('strength', event.target.value)}
            />
          </Field>
          <Field label="Unit" required error={fieldErrors.unit}>
            <Input value={draft.unit} onChange={(event) => set('unit', event.target.value)} />
          </Field>
          <Field label="Price" required error={fieldErrors.price} hint="Per unit, in USD.">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={draft.price}
              onChange={(event) => set('price', event.target.value)}
            />
          </Field>
          <Field
            label="Reorder level"
            error={fieldErrors.reorderLevel}
            hint="At or below this the medicine appears on the low-stock list."
          >
            <Input
              type="number"
              min={0}
              step={1}
              value={draft.reorderLevel}
              onChange={(event) => set('reorderLevel', event.target.value)}
            />
          </Field>
          {!isEdit && (
            <Field
              label="Opening quantity"
              error={fieldErrors.stock}
              hint="Recorded as a 'purchase' movement so the ledger reconciles to the shelf."
            >
              <Input
                type="number"
                min={0}
                step={1}
                value={draft.stock}
                onChange={(event) => set('stock', event.target.value)}
              />
            </Field>
          )}
          {isEdit && (
            <div className="alert-strip">
              Stock is deliberately not editable here: PATCH /api/medicines/:id ignores any raw stock value, so
              use “Adjust stock” — every change is written to the audited movements ledger.
            </div>
          )}
          {isEdit && (
            <label className="checkline">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => set('isActive', event.target.checked)}
              />
              Active (inactive medicines cannot be prescribed)
            </label>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AdjustStockModal({
  medicine,
  initialReason,
  initialChange,
  onClose,
  onDone
}: {
  medicine: Medicine;
  initialReason: MovementReason;
  initialChange?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [change, setChange] = useState(initialChange !== undefined ? String(initialChange) : '');
  const [reason, setReason] = useState<MovementReason>(initialReason);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = Number(change);
  const parsedValid = change.trim() !== '' && Number.isInteger(parsed) && parsed !== 0;
  const wouldGoNegative = parsedValid && parsed < 0 && Math.abs(parsed) > medicine.stock;
  const resultingStock = parsedValid ? medicine.stock + parsed : medicine.stock;

  async function submit() {
    setFormError('');
    if (!parsedValid) {
      setFormError('Enter a whole number other than zero — positive for units received, negative for units removed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<{ id: string; stock: number }>(`/api/medicines/${medicine.id}/adjust-stock`, {
        method: 'POST',
        body: {
          quantityChange: parsed,
          reason,
          reference: reference.trim() || null,
          note: note.trim() || null
        }
      });
      onDone();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Adjust stock — ${medicine.name}`}
      subtitle={
        <>
          On the shelf now: <strong className="mono">{medicine.stock}</strong> {medicine.unit} · reorder at{' '}
          <span className="mono">{medicine.reorderLevel}</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Record movement
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="form-grid">
          <Field
            label="Quantity change"
            required
            error={formError}
            hint="Positive = received, negative = removed. Removals can never exceed what is on the shelf."
          >
            <Input type="number" step={1} value={change} onChange={(event) => setChange(event.target.value)} />
          </Field>
          <Field label="Reason" required>
            <Select value={reason} onChange={(event) => setReason(event.target.value as MovementReason)}>
              {MOVEMENT_REASONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" hint="Invoice, prescription or return number.">
            <Input value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field label="Note" hint="Optional; kept in the audit trail.">
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>

        {parsedValid && (
          <div className="row subtle">
            New shelf quantity would be <strong className="mono">{resultingStock}</strong> {medicine.unit}.
          </div>
        )}
        {wouldGoNegative && (
          <div className="alert-strip danger">
            Removing {Math.abs(parsed)} leaves {medicine.stock - Math.abs(parsed)} on the shelf. The server
            applies this as one guarded update and will refuse the movement if the live stock is short — the
            conflict message appears above.
          </div>
        )}
        <p className="subtle">
          The adjustment and its ledger row are written in one transaction, so two staff adjusting the same
          medicine cannot lose an update or drive stock below zero.
        </p>
      </div>
    </Modal>
  );
}

function MedicineDetailModal({
  medicineId,
  onClose
}: {
  medicineId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<MedicineDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<MedicineDetail>(`/api/medicines/${medicineId}`)
      .then(setDetail)
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, [medicineId]);

  useEffect(load, [load]);

  const movementColumns: Column<StockMovement>[] = [
    {
      key: 'createdAt',
      header: 'When',
      render: (row) => <span className="nowrap">{formatDateTime(row.createdAt)}</span>
    },
    {
      key: 'quantityChange',
      header: 'Qty',
      align: 'right',
      render: (row) => <QuantityBadge change={row.quantityChange} />
    },
    { key: 'reason', header: 'Reason', render: (row) => <StatusBadge status={row.reason} /> },
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => (row.reference ? <span className="mono subtle">{row.reference}</span> : <span className="subtle">—</span>)
    },
    {
      key: 'performedBy',
      header: 'By',
      render: (row) =>
        row.performedByName ? (
          <span>
            {row.performedByName}{' '}
            {row.performedByRole && <span className="subtle">({row.performedByRole})</span>}
          </span>
        ) : (
          <span className="subtle">system</span>
        )
    }
  ];

  return (
    <Modal
      title={detail ? detail.name : 'Medicine'}
      subtitle={detail ? `${detail.genericName ?? 'no generic name'} · ${detail.strength}` : undefined}
      width="lg"
      onClose={onClose}
    >
      {loading && <Loading label="Loading medicine…" />}
      {!loading && isForbidden(error) && <PermissionNotice error={error} />}
      {!loading && !!error && !isForbidden(error) && <ErrorNote error={error} />}
      {!loading && detail && (
        <div className="stack">
          <div className="detail-list">
            <div className="detail-item">
              <span>Form</span>
              <strong>{detail.form}</strong>
            </div>
            <div className="detail-item">
              <span>Unit</span>
              <strong>{detail.unit}</strong>
            </div>
            <div className="detail-item">
              <span>Price</span>
              <strong>{formatMoney(detail.price)}</strong>
            </div>
            <div className="detail-item">
              <span>On shelf</span>
              <StockCell medicine={detail} />
            </div>
            <div className="detail-item">
              <span>Reorder level</span>
              <strong className="mono">{detail.reorderLevel}</strong>
            </div>
            <div className="detail-item">
              <span>Active</span>
              <strong>{detail.isActive ? 'yes' : 'no'}</strong>
            </div>
            <div className="detail-item">
              <span>Added</span>
              <strong>{formatDate(detail.createdAt)}</strong>
            </div>
            <div className="detail-item">
              <span>Last changed</span>
              <strong>{formatDateTime(detail.updatedAt)}</strong>
            </div>
          </div>

          {detail.stock <= detail.reorderLevel && (
            <div className="alert-strip">
              At or below the reorder point: {detail.reorderLevel - detail.stock} {detail.unit} short.
            </div>
          )}

          <h3 className="card-title">Recent stock movements</h3>
          <Table
            columns={movementColumns}
            rows={detail.recentMovements}
            empty="No movements recorded yet — the ledger starts with the first adjustment."
          />
          <p className="subtle">Up to the 20 newest movements are returned by the server.</p>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Prescription detail + dispensing
 * ------------------------------------------------------------------ */

function PrescriptionDetailModal({
  prescriptionId,
  canDispense,
  canCancel,
  onClose,
  onChanged
}: {
  prescriptionId: string;
  canDispense: boolean;
  canCancel: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<PrescriptionDetail>(`/api/prescriptions/${prescriptionId}`)
      .then((result) => {
        setDetail(result);
        const nextQuantities: Record<string, string> = {};
        const nextIncluded: Record<string, boolean> = {};
        for (const item of result.items) {
          nextQuantities[item.id] = String(Math.max(0, item.remaining));
          nextIncluded[item.id] = item.remaining > 0;
        }
        setQuantities(nextQuantities);
        setIncluded(nextIncluded);
      })
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, [prescriptionId]);

  useEffect(load, [load]);

  const shortages = detail ? detail.items.filter((item) => item.remaining > item.currentStock) : [];
  const totalDispensed = detail
    ? detail.items.reduce((sum, item) => sum + item.dispensedQuantity, 0)
    : 0;

  const overRemaining = detail
    ? detail.items.filter((item) => {
        if (!included[item.id]) return false;
        const value = Number(quantities[item.id]);
        return !Number.isInteger(value) || value < 1 || value > item.remaining;
      })
    : [];

  const selected = detail
    ? detail.items.filter((item) => {
        if (!included[item.id]) return false;
        const value = Number(quantities[item.id]);
        return Number.isInteger(value) && value >= 1;
      })
    : [];

  async function dispense() {
    if (!detail || !selected.length) return;
    setBusy(true);
    setActionError(null);
    setNotice('');
    try {
      const result = await api<{ id: string; status: PrescriptionStatus; dispensedLines: number }>(
        `/api/prescriptions/${detail.id}/dispense`,
        {
          method: 'POST',
          body: {
            items: selected.map((item) => ({
              itemId: item.id,
              quantity: Number(quantities[item.id])
            }))
          }
        }
      );
      setNotice(`Dispensed ${result.dispensedLines} line(s). Prescription is now “${result.status.replace(/_/g, ' ')}”.`);
      onChanged();
      // Reload so quantities, remaining and live stock are the server's truth.
      load();
    } catch (caught) {
      setActionError(caught);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    setNotice('');
    try {
      const result = await api<{ id: string; status: PrescriptionStatus }>(
        `/api/prescriptions/${detail.id}/cancel`,
        { method: 'POST' }
      );
      setNotice(`Prescription cancelled (status “${result.status}”).`);
      onChanged();
      load();
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={detail ? detail.patientName : 'Prescription'}
      subtitle={
        detail ? (
          <>
            <span className="mono">{detail.patientMrn}</span> · prescribed by {detail.prescriberName} ·{' '}
            {formatDateTime(detail.createdAt)}
          </>
        ) : undefined
      }
      width="lg"
      onClose={onClose}
      footer={
        <>
          {canCancel && detail && detail.status !== 'cancelled' && (
            <Button
              variant="danger"
              loading={busy}
              disabled={totalDispensed > 0}
              onClick={cancel}
              title={
                totalDispensed > 0
                  ? 'Items have already been dispensed — record a stock return instead.'
                  : undefined
              }
            >
              Cancel prescription
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canDispense && (
            <Button
              variant="primary"
              loading={busy}
              disabled={!selected.length || !!overRemaining.length || detail?.status === 'cancelled'}
              onClick={dispense}
            >
              Dispense selected ({selected.length})
            </Button>
          )}
        </>
      }
    >
      {loading && <Loading label="Loading prescription…" />}
      {isForbidden(error) && <PermissionNotice error={error} />}
      {!!error && !isForbidden(error) && <ErrorNote error={error} />}
      {!loading && detail && (
        <div className="stack">
          <div className="row">
            <StatusBadge status={detail.status} />
            <span className="subtle">
              {detail.items.length} item(s) · {totalDispensed} unit(s) dispensed so far
            </span>
          </div>
          {detail.notes && <div className="muted">{detail.notes}</div>}
          {notice && <div className="alert-strip">{notice}</div>}
          <ErrorNote error={actionError} onDismiss={() => setActionError(null)} />
          {!!shortages.length && (
            <div className="alert-strip danger">
              Not enough on the shelf for: {shortages.map((item) => item.medicineName).join(', ')}. Dispensing
              is atomic — one short medicine rolls the whole batch back, so reduce the quantity or restock first.
            </div>
          )}
          {!!overRemaining.length && (
            <div className="alert-strip">
              Fix the highlighted quantities: a line cannot dispense more than its remaining amount.
            </div>
          )}

          <div className="stack-sm">
            {detail.items.map((item) => {
              const value = quantities[item.id] ?? '';
              const numeric = Number(value);
              const tooMany = !!value.trim() && numeric > item.remaining;
              const shortStock =
                !!value.trim() && Number.isFinite(numeric) && numeric > item.currentStock;
              return (
                <div className="card" key={item.id}>
                  <div className="card-body padded stack-sm">
                    <div className="row">
                      <strong>
                        {item.medicineName} <span className="subtle">{item.strength}</span>
                      </strong>
                      <Badge tone="neutral">{item.form}</Badge>
                      <span className="spacer" />
                      <span className="subtle nowrap">
                        stock{' '}
                        <strong className="mono">{item.currentStock}</strong>{' '}
                        {item.unit}
                      </span>
                    </div>
                    <div className="detail-list">
                      <div className="detail-item">
                        <span>Dosage</span>
                        <strong>{item.dosage}</strong>
                      </div>
                      <div className="detail-item">
                        <span>Frequency</span>
                        <strong>{item.frequency}</strong>
                      </div>
                      <div className="detail-item">
                        <span>Duration</span>
                        <strong>{item.durationDays} day(s)</strong>
                      </div>
                      <div className="detail-item">
                        <span>Prescribed</span>
                        <strong className="mono">{item.quantity}</strong>
                      </div>
                      <div className="detail-item">
                        <span>Already dispensed</span>
                        <strong className="mono">{item.dispensedQuantity}</strong>
                      </div>
                      <div className="detail-item">
                        <span>Remaining</span>
                        <strong className="mono">{item.remaining}</strong>
                      </div>
                    </div>
                    {item.instructions && (
                      <p className="subtle">Instructions: {item.instructions}</p>
                    )}
                    {canDispense && item.remaining > 0 && detail.status !== 'cancelled' && (
                      <div className="row">
                        <label className="checkline">
                          <input
                            type="checkbox"
                            checked={!!included[item.id]}
                            onChange={(event) =>
                              setIncluded((current) => ({ ...current, [item.id]: event.target.checked }))
                            }
                          />
                          Dispense
                        </label>
                        <Field
                          label={`Quantity (max ${item.remaining})`}
                          className="nowrap"
                          error={tooMany ? `Only ${item.remaining} left to dispense.` : undefined}
                        >
                          <Input
                            type="number"
                            min={1}
                            max={item.remaining}
                            step={1}
                            style={{ width: 110 }}
                            value={value}
                            onChange={(event) =>
                              setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                            }
                          />
                        </Field>
                        {shortStock && (
                          <span className="alert-strip danger">
                            Only {item.currentStock} on the shelf — the server will refuse this batch.
                          </span>
                        )}
                      </div>
                    )}
                    {canDispense && item.remaining === 0 && (
                      <p className="subtle">Fully dispensed.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {!detail.items.length && (
            <EmptyState title="No items" hint="This prescription has no medicine lines." />
          )}
          {!canDispense && (
            <p className="subtle">
              Dispensing is limited to pharmacy staff; you can read the prescription and its stock picture.
            </p>
          )}
          {canCancel && totalDispensed > 0 && (
            <p className="subtle">
              Cancellation is blocked once anything has been dispensed — record a “return” stock adjustment
              instead.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * New prescription
 * ------------------------------------------------------------------ */

interface DraftItem {
  key: number;
  medicine: Medicine | null;
  dosage: string;
  frequency: string;
  durationDays: string;
  quantity: string;
  instructions: string;
}

let draftKey = 0;
function newDraftItem(): DraftItem {
  draftKey += 1;
  return { key: draftKey, medicine: null, dosage: '', frequency: '', durationDays: '5', quantity: '', instructions: '' };
}

interface ReadyItem extends DraftItem {
  medicine: Medicine;
}

function withMedicines(items: DraftItem[]): ReadyItem[] {
  return items.filter((item): item is ReadyItem => item.medicine !== null);
}

function NewPrescriptionModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [items, setItems] = useState<DraftItem[]>([newDraftItem()]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  function patch(key: number, changes: Partial<DraftItem>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  }

  function valid(): string {
    if (!patient) return 'Choose a patient first.';
    if (!items.length) return 'Add at least one medicine line.';
    for (const [index, item] of items.entries()) {
      const label = `Line ${index + 1}`;
      if (!item.medicine) return `${label}: pick a medicine.`;
      if (!item.dosage.trim()) return `${label}: dosage is required.`;
      if (!item.frequency.trim()) return `${label}: frequency is required.`;
      const duration = Number(item.durationDays);
      if (!Number.isInteger(duration) || duration < 1 || duration > 365)
        return `${label}: duration must be 1–365 days.`;
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) return `${label}: quantity must be a whole number of 1 or more.`;
    }
    if (items.length > 30) return 'A prescription may hold at most 30 lines.';
    return '';
  }

  async function submit() {
    const problem = valid();
    if (problem) {
      setFormError(problem);
      return;
    }
    const chosen = patient;
    const lines = withMedicines(items);
    if (!chosen || lines.length !== items.length) {
      setFormError('Choose a patient and a medicine for every line.');
      return;
    }
    setFormError('');
    setBusy(true);
    setError(null);
    try {
      await api<{ id: string; status: PrescriptionStatus; itemCount: number }>('/api/prescriptions', {
        method: 'POST',
        body: {
          patientId: chosen.id,
          notes: notes.trim() || null,
          items: lines.map((line) => ({
            medicineId: line.medicine.id,
            dosage: line.dosage.trim(),
            frequency: line.frequency.trim(),
            durationDays: Number(line.durationDays),
            quantity: Number(line.quantity),
            instructions: line.instructions.trim() || null
          }))
        }
      });
      onCreated();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New prescription"
      subtitle="Saves as a pending prescription for the pharmacy to dispense."
      width="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save prescription
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        {formError && <div className="alert-strip danger">{formError}</div>}
        <Field label="Patient" required>
          <PatientPicker onPick={setPatient} />
        </Field>

        {items.map((item, index) => (
          <div className="card" key={item.key}>
            <div className="card-body padded stack-sm">
              <div className="row">
                <strong>Line {index + 1}</strong>
                <span className="spacer" />
                {items.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {item.medicine ? (
                <div className="row">
                  <span>
                    <strong>{item.medicine.name}</strong> <span className="subtle">{item.medicine.strength}</span>{' '}
                    · <span className="mono">{item.medicine.stock}</span> on shelf ·{' '}
                    <span className="mono">{formatMoney(item.medicine.price)}</span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => patch(item.key, { medicine: null })}>
                    Change medicine
                  </Button>
                </div>
              ) : (
                <MedicinePicker onPick={(medicine) => patch(item.key, { medicine })} />
              )}
              <div className="form-grid">
                <Field label="Dosage" required hint="e.g. 1 tablet / 5 ml.">
                  <Input value={item.dosage} onChange={(event) => patch(item.key, { dosage: event.target.value })} />
                </Field>
                <Field label="Frequency" required hint="e.g. three times daily.">
                  <Input
                    value={item.frequency}
                    onChange={(event) => patch(item.key, { frequency: event.target.value })}
                  />
                </Field>
                <Field label="Duration (days)" required>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={item.durationDays}
                    onChange={(event) => patch(item.key, { durationDays: event.target.value })}
                  />
                </Field>
                <Field label="Quantity" required hint="Units to supply.">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={item.quantity}
                    onChange={(event) => patch(item.key, { quantity: event.target.value })}
                  />
                </Field>
                <Field label="Instructions" className="form-span-2" hint="Optional.">
                  <Input
                    value={item.instructions}
                    onChange={(event) => patch(item.key, { instructions: event.target.value })}
                  />
                </Field>
              </div>
              {!!item.medicine && Number(item.quantity) > item.medicine.stock && (
                <p className="subtle">
                  Only {item.medicine.stock} {item.medicine.unit} on the shelf — prescribing is allowed, but the
                  pharmacy cannot dispense this quantity until it is restocked.
                </p>
              )}
            </div>
          </div>
        ))}

        <div className="row">
          <Button size="sm" onClick={() => setItems((current) => [...current, newDraftItem()])}>
            Add medicine line
          </Button>
        </div>

        <Field label="Notes" hint="Optional; visible to the pharmacy.">
          <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <p className="subtle">
          The server rejects a prescription that names an inactive or unknown medicine and lists them by name in
          the error above.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 25;

function StockTab({
  user,
  revision,
  onChanged
}: {
  user: ReturnType<typeof useAuth>['user'];
  revision: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Medicine[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Medicine | null>(null);
  const [adjusting, setAdjusting] = useState<Medicine | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query);

  function load() {
    setLoading(true);
    setError(null);
    api<MedicineListResult>('/api/medicines', {
      query: { q: debouncedQuery.trim() || undefined, form: form || undefined, limit: PAGE_SIZE, offset }
    })
      .then((result) => {
        setRows(result.items);
        setTotal(result.total);
      })
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }

  useEffect(load, [debouncedQuery, form, offset, revision]);

  // Any write bumps the page revision, which re-runs the effect above.
  const refresh = onChanged;

  const columns: Column<Medicine>[] = [
    { key: 'name', header: 'Medicine', render: (row) => <strong>{row.name}</strong> },
    {
      key: 'genericName',
      header: 'Generic',
      render: (row) => row.genericName ?? <span className="subtle">—</span>
    },
    { key: 'form', header: 'Form', render: (row) => row.form },
    { key: 'strength', header: 'Strength', render: (row) => row.strength },
    { key: 'unit', header: 'Unit', render: (row) => row.unit },
    { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.price) },
    { key: 'stock', header: 'Stock', align: 'right', render: (row) => <StockCell medicine={row} /> },
    { key: 'reorderLevel', header: 'Reorder', align: 'right', render: (row) => row.reorderLevel },
    {
      key: 'isActive',
      header: 'Active',
      render: (row) => <Badge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? 'active' : 'inactive'}</Badge>
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        // stopPropagation: the row itself opens the detail modal.
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          {can(user, ['pharmacist']) && (
            <>
              <Button size="sm" onClick={() => setEditing(row)}>
                Edit
              </Button>
              <Button size="sm" onClick={() => setAdjusting(row)}>
                Adjust stock
              </Button>
            </>
          )}
        </span>
      )
    }
  ];

  return (
    <Card title="Medicine stock" subtitle={`${total} catalogue item(s).`}>
      <div className="stack">
        <div className="toolbar">
          <SearchInput value={query} onChange={(value) => { setQuery(value); setOffset(0); }} placeholder="Search name or generic…" />
          <Select
            value={form}
            onChange={(event) => {
              setForm(event.target.value);
              setOffset(0);
            }}
            aria-label="Filter by form"
          >
            <option value="">All forms</option>
            {MEDICINE_FORMS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <span className="spacer" />
          {can(user, ['pharmacist']) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add medicine
            </Button>
          )}
        </div>

        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <Table columns={columns} rows={rows} loading={loading} empty="No medicine matches this search." onRowClick={(row) => setDetailId(row.id)} />
            <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}

        {creating && <MedicineFormModal medicine={null} onClose={() => setCreating(false)} onSaved={refresh} />}
        {editing && <MedicineFormModal medicine={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
        {adjusting && (
          <AdjustStockModal medicine={adjusting} initialReason="adjustment" onClose={() => setAdjusting(null)} onDone={refresh} />
        )}
        {detailId && <MedicineDetailModal medicineId={detailId} onClose={() => setDetailId(null)} />}
      </div>
    </Card>
  );
}

function QueueTab({
  user,
  revision,
  onChanged,
  onCountChange
}: {
  user: ReturnType<typeof useAuth>['user'];
  revision: number;
  onChanged: () => void;
  onCountChange: (count: number) => void;
}) {
  const [rows, setRows] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<QueueEntry[]>('/api/pharmacy/queue')
      .then((result) => {
        // Oldest first is the server's own ordering; keep it as delivered.
        setRows(result);
        onCountChange(result.length);
      })
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, [onCountChange]);

  useEffect(() => {
    load();
  }, [load, revision]);

  // Keeps the "waiting" column live while a pharmacist works slowly on a batch.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const columns: Column<QueueEntry>[] = [
    { key: 'patient', header: 'Patient', render: (row) => <span><strong>{row.patientName}</strong> <span className="mono subtle">{row.patientMrn}</span></span> },
    { key: 'prescriber', header: 'Prescribed by', render: (row) => row.prescriberName },
    { key: 'itemCount', header: 'Items', align: 'right', render: (row) => row.itemCount },
    { key: 'remainingQuantity', header: 'Units left', align: 'right', render: (row) => row.remainingQuantity },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'age',
      header: 'Waiting',
      align: 'right',
      render: (row) => {
        const waited = now - new Date(row.createdAt).getTime();
        return (
          <span className="row nowrap">
            {ageLabel(row.createdAt)}
            {waited > 4 * 3600_000 && <Badge tone="warning">overdue</Badge>}
          </span>
        );
      }
    }
  ];

  return (
    <Card
      title="Dispensing queue"
      subtitle="Prescriptions pending or partially dispensed, oldest first."
      actions={
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="stack">
        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <Table
              columns={columns}
              rows={rows}
              loading={loading}
              empty="Nothing waiting — the counter is clear."
              onRowClick={(row) => setOpenId(row.id)}
            />
            {!loading && !!rows.length && (
              <p className="subtle">Select a row to review its items, live shelf stock and dispense.</p>
            )}
          </>
        )}
        {openId && (
          <PrescriptionDetailModal
            prescriptionId={openId}
            canDispense={can(user, ['pharmacist'])}
            canCancel={can(user, ['doctor'])}
            onClose={() => setOpenId(null)}
            onChanged={onChanged}
          />
        )}
      </div>
    </Card>
  );
}

function PrescriptionsTab({
  user,
  revision,
  onChanged
}: {
  user: ReturnType<typeof useAuth>['user'];
  revision: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<PrescriptionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [patientQuery, setPatientQuery] = useState('');
  const [patientFilter, setPatientFilter] = useState<PatientOption | null>(null);
  const [candidates, setCandidates] = useState<PatientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const debouncedQuery = useDebounced(patientQuery);

  // /api/patients is the only patient-name search; the prescriptions endpoint
  // filters by patientId, so resolve the term into patients and filter by id.
  useEffect(() => {
    if (!debouncedQuery.trim() || patientFilter) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    api<PatientListResult>('/api/patients', { query: { q: debouncedQuery.trim(), limit: 6 } })
      .then((result) => !cancelled && setCandidates(result.items))
      .catch(() => !cancelled && setCandidates([]));
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, patientFilter]);

  function load() {
    setLoading(true);
    setError(null);
    api<PrescriptionListResult>('/api/prescriptions', {
      query: {
        status: status || undefined,
        patientId: patientFilter?.id,
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

  useEffect(load, [status, patientFilter, offset, revision]);

  const columns: Column<PrescriptionSummary>[] = [
    { key: 'createdAt', header: 'When', render: (row) => <span className="nowrap">{formatDateTime(row.createdAt)}</span> },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (
        <span>
          <strong>{row.patientName}</strong> <span className="mono subtle">{row.patientMrn}</span>
        </span>
      )
    },
    { key: 'prescriberName', header: 'Prescribed by', render: (row) => row.prescriberName },
    { key: 'itemCount', header: 'Items', align: 'right', render: (row) => row.itemCount },
    { key: 'totalQuantity', header: 'Units', align: 'right', render: (row) => row.totalQuantity },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> }
  ];

  return (
    <Card
      title="Prescriptions"
      subtitle={`${total} prescription(s) match.`}
      actions={
        can(user, ['doctor']) && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New prescription
          </Button>
        )
      }
    >
      <div className="stack">
        <div className="toolbar">
          <SearchInput
            value={patientQuery}
            onChange={(value) => {
              setPatientQuery(value);
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
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            {PRESCRIPTION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          {patientFilter && (
            <Badge tone="info">
              filtered: {patientFilter.fullName}
            </Badge>
          )}
          {patientFilter && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPatientFilter(null);
                setPatientQuery('');
                setOffset(0);
              }}
            >
              Clear patient
            </Button>
          )}
          <span className="spacer" />
        </div>

        {!!candidates.length && !patientFilter && (
          <div className="stack-sm">
            <p className="subtle">Pick a patient to filter the whole list by them:</p>
            <div className="row">
              {candidates.map((patient) => (
                <Button
                  key={patient.id}
                  size="sm"
                  onClick={() => {
                    setPatientFilter(patient);
                    setCandidates([]);
                    setOffset(0);
                  }}
                >
                  {patient.fullName} · <span className="mono">{patient.mrn}</span>
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
              empty="No prescriptions for this filter."
              onRowClick={(row) => setOpenId(row.id)}
            />
            <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}

        {openId && (
          <PrescriptionDetailModal
            prescriptionId={openId}
            canDispense={can(user, ['pharmacist'])}
            canCancel={can(user, ['doctor'])}
            onClose={() => setOpenId(null)}
            onChanged={onChanged}
          />
        )}
        {creating && <NewPrescriptionModal onClose={() => setCreating(false)} onCreated={onChanged} />}
      </div>
    </Card>
  );
}

function LowStockTab({
  user,
  revision,
  onChanged
}: {
  user: ReturnType<typeof useAuth>['user'];
  revision: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Medicine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adjusting, setAdjusting] = useState<Medicine | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api<{ items: Medicine[]; total: number }>('/api/medicines/low-stock')
      .then((result) => setRows(result.items))
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }

  useEffect(load, [revision]);

  const columns: Column<Medicine>[] = [
    { key: 'name', header: 'Medicine', render: (row) => <strong>{row.name}</strong> },
    { key: 'strength', header: 'Strength', render: (row) => row.strength },
    { key: 'form', header: 'Form', render: (row) => row.form },
    { key: 'stock', header: 'On shelf', align: 'right', render: (row) => <StockCell medicine={row} /> },
    { key: 'reorderLevel', header: 'Reorder at', align: 'right', render: (row) => row.reorderLevel },
    {
      key: 'shortfall',
      header: 'Short by',
      align: 'right',
      render: (row) => (
        <Badge tone="danger">
          {Math.max(0, row.reorderLevel - row.stock)} {row.unit}
        </Badge>
      )
    },
    {
      key: 'value',
      header: 'Restock cost',
      align: 'right',
      render: (row) => formatMoney(Math.max(0, row.reorderLevel - row.stock) * row.price)
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        can(user, ['pharmacist']) && (
          <span onClick={(event) => event.stopPropagation()}>
            <Button size="sm" variant="primary" onClick={() => setAdjusting(row)}>
              Record purchase
            </Button>
          </span>
        )
    }
  ];

  const totalShortfall = rows.reduce((sum, row) => sum + Math.max(0, row.reorderLevel - row.stock), 0);

  return (
    <Card
      title="Low stock"
      subtitle="Active medicines at or below their reorder point, worst first."
      actions={
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="stack">
        {isForbidden(error) ? (
          <PermissionNotice error={error} />
        ) : (
          <>
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            {loading && <Loading label="Loading low-stock list…" />}
            {!loading && (
              <>
                <div className="stat-grid">
                  <Stat label="Items to reorder" value={rows.length} tone={rows.length ? 'warning' : 'success'} />
                  <Stat label="Total units short" value={totalShortfall} />
                </div>
                {!rows.length ? (
                  <EmptyState title="Everything is above its reorder point" hint="No action needed right now." />
                ) : (
                  <div className="stack-sm">
                    {rows.map((row) => (
                      <div className="row" key={row.id}>
                        <div className="stack-sm">
                          <strong>{row.name} <span className="subtle">{row.strength}</span></strong>
                          <span className="muted">
                            {row.stock} {row.unit} on the shelf —{' '}
                            <strong>
                              {Math.max(0, row.reorderLevel - row.stock)} {row.unit} below the reorder point of{' '}
                              {row.reorderLevel}
                            </strong>
                            .
                          </span>
                        </div>
                        <span className="spacer" />
                        {can(user, ['pharmacist']) ? (
                          <Button size="sm" variant="primary" onClick={() => setAdjusting(row)}>
                            Record purchase
                          </Button>
                        ) : (
                          <Badge tone="danger">reorder</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
        {adjusting && (
          <AdjustStockModal
            medicine={adjusting}
            initialReason="purchase"
            initialChange={Math.max(1, adjusting.reorderLevel - adjusting.stock)}
            onClose={() => setAdjusting(null)}
            onDone={onChanged}
          />
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

type TabId = 'stock' | 'queue' | 'prescriptions' | 'low';

export function PharmacyPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>('stock');
  const [queueCount, setQueueCount] = useState<number | undefined>(undefined);
  const [lowCount, setLowCount] = useState<number | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [stamp, setStamp] = useState(0);

  // Tab counters are decorative: refreshed on any mutation, errors swallowed
  // because the tabs themselves surface the real 403/404 state.
  useEffect(() => {
    let cancelled = false;
    api<QueueEntry[]>('/api/pharmacy/queue')
      .then((rows) => !cancelled && setQueueCount(rows.length))
      .catch(() => undefined);
    api<{ items: Medicine[]; total: number }>('/api/medicines/low-stock')
      .then((result) => !cancelled && setLowCount(result.total))
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
          <h2>Pharmacy</h2>
          <p>Stock ledger, dispensing queue and prescriptions in one workbench.</p>
        </div>
        <div className="topbar-actions">
          {can(user, ['doctor']) && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New prescription
            </Button>
          )}
        </div>
      </div>

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'stock', label: 'Stock' },
          { id: 'queue', label: 'Dispensing queue', count: queueCount },
          { id: 'prescriptions', label: 'Prescriptions' },
          { id: 'low', label: 'Low stock', count: lowCount }
        ]}
      />

      {tab === 'stock' && <StockTab user={user} revision={stamp} onChanged={onChanged} />}
      {tab === 'queue' && (
        <QueueTab user={user} revision={stamp} onChanged={onChanged} onCountChange={setQueueCount} />
      )}
      {tab === 'prescriptions' && <PrescriptionsTab user={user} revision={stamp} onChanged={onChanged} />}
      {tab === 'low' && <LowStockTab user={user} revision={stamp} onChanged={onChanged} />}

      {creating && (
        <NewPrescriptionModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            onChanged();
            setTab('prescriptions');
          }}
        />
      )}
    </div>
  );
}
