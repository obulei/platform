import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import { can, useAuth } from '../auth.js';
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, Modal, Pager, SearchInput, Select, StatusBadge, Table, Textarea, type Column } from '../components.js';
import { classList, formatDateTime, toDateInputValue } from '../utils.js';

type PatientStatus = 'active' | 'inactive' | 'deceased';
type Gender = 'male' | 'female' | 'other';

/** Mirrors toDto() + age in server/src/modules/patients.routes.ts. */
interface PatientListItem {
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
  age: number | null;
}

interface PatientListResponse {
  items: PatientListItem[];
  total: number;
  offset: number;
  limit: number;
}

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: PatientStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'deceased', label: 'Deceased' }
];

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' }
];

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

/** The register form keeps every field as a string; blanks are sent as null. */
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

const emptyForm = (): DemographicsForm => ({
  givenName: '',
  familyName: '',
  birthDate: '',
  gender: '',
  bloodGroup: '',
  phone: '',
  email: '',
  address: '',
  allergies: '',
  chronicConditions: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  notes: '',
  status: 'active'
});

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** POST /api/patients body — birthDate must be YYYY-MM-DD or null, never ''. */
function toCreateBody(form: DemographicsForm) {
  return {
    givenName: form.givenName.trim(),
    familyName: form.familyName.trim(),
    birthDate: form.birthDate ? form.birthDate : null,
    gender: form.gender ? (form.gender as Gender) : null,
    bloodGroup: blankToNull(form.bloodGroup),
    phone: blankToNull(form.phone),
    email: blankToNull(form.email),
    address: blankToNull(form.address),
    allergies: blankToNull(form.allergies),
    chronicConditions: blankToNull(form.chronicConditions),
    emergencyContactName: blankToNull(form.emergencyContactName),
    emergencyContactPhone: blankToNull(form.emergencyContactPhone),
    notes: blankToNull(form.notes),
    status: form.status
  };
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function PermissionNotice() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Patients</h2>
          <p>Role-restricted area.</p>
        </div>
      </div>
      <div className="alert-strip">
        Your role may not read the patient registry. Ask an administrator for access.
      </div>
    </div>
  );
}

export function PatientsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | PatientStatus>('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<PatientListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const requestId = useRef(0);

  // 300ms debounce: the server matches q against name, MRN and phone already.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setOffset(0);
  }, [q, status]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api<PatientListResponse>('/api/patients', {
        query: { q: q || undefined, status: status || undefined, limit: PAGE_SIZE, offset }
      });
      if (id !== requestId.current) return;
      setData(result);
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(caught);
      setData(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [q, status, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<PatientListItem>[] = [
    { key: 'mrn', header: 'MRN', width: '110px', render: (row) => <span className="mono">{row.mrn}</span> },
    {
      key: 'name',
      header: 'Patient',
      render: (row) => (
        <div className="stack-sm stack">
          <strong>{row.fullName}</strong>
          {row.allergies ? (
            <span className="subtle" style={{ color: 'var(--danger)' }}>
              Allergy: {row.allergies}
            </span>
          ) : null}
        </div>
      )
    },
    { key: 'age', header: 'Age', width: '70px', render: (row) => (row.age === null ? '—' : `${row.age}`) },
    { key: 'sex', header: 'Sex', width: '80px', render: (row) => row.gender ?? '—' },
    { key: 'phone', header: 'Phone', width: '150px', render: (row) => row.phone ?? <span className="muted">—</span> },
    { key: 'status', header: 'Status', width: '110px', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'createdAt',
      header: 'Last created',
      width: '170px',
      render: (row) => <span className="subtle nowrap">{formatDateTime(row.createdAt)}</span>
    }
  ];

  if (isForbidden(error)) return <PermissionNotice />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Patients</h2>
          <p>Search by name, MRN or phone. Registering a patient mints a new MRN automatically.</p>
        </div>
        <div className="row">
          {can(user, ['reception']) && (
            <Button variant="primary" onClick={() => setRegisterOpen(true)}>
              Register patient
            </Button>
          )}
        </div>
      </div>

      <Card>
        <div className="toolbar" style={{ paddingBottom: 0 }}>
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search name, MRN or phone…"
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as '' | PatientStatus)}
            style={{ maxWidth: 180 }}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <span className="spacer" />
          {data && !loading && (
            <span className="subtle">
              {data.total} patient{data.total === 1 ? '' : 's'} match
            </span>
          )}
        </div>

        <div className="card-body padded">
          {error ? (
            <ErrorNote error={error} />
          ) : loading && !data ? (
            <Loading label="Loading patients…" />
          ) : (
            <Table
              columns={columns}
              rows={data?.items ?? []}
              loading={loading}
              empty={
                q || status ? 'No patient matches this search. Check the spelling or the MRN.' : 'No patients registered yet.'
              }
              onRowClick={(row) => navigate(`/patients/${row.id}`)}
            />
          )}
        </div>

        {data && !error && (
          <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
        )}
      </Card>

      {registerOpen && (
        <RegisterPatientModal
          onClose={() => setRegisterOpen(false)}
          onCreated={(patient) => {
            setRegisterOpen(false);
            void load();
            navigate(`/patients/${patient.id}`);
          }}
        />
      )}
    </div>
  );
}

function RegisterPatientModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (patient: PatientListItem) => void;
}) {
  const [form, setForm] = useState<DemographicsForm>(emptyForm);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof DemographicsForm>(key: K, value: DemographicsForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const canSubmit = form.givenName.trim().length > 0 && form.familyName.trim().length > 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<PatientListItem>('/api/patients', {
        method: 'POST',
        body: toCreateBody(form)
      });
      onCreated(created);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register patient"
      subtitle="Only the first two names are required; the MRN is generated by the server."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSubmit} loading={busy} disabled={!canSubmit}>
            Register
          </Button>
        </>
      }
    >
      {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

      <form className="stack" onSubmit={onSubmit}>
      <div className="form-grid">
        <Field label="Given name" required>
          <Input value={form.givenName} onChange={(event) => update('givenName', event.target.value)} />
        </Field>
        <Field label="Family name" required>
          <Input value={form.familyName} onChange={(event) => update('familyName', event.target.value)} />
        </Field>
        <Field label="Birth date" hint="YYYY-MM-DD — used to derive the age.">
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
            {GENDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Blood group">
          <Select value={form.bloodGroup} onChange={(event) => update('bloodGroup', event.target.value)}>
            <option value="">Unknown</option>
            {BLOOD_GROUPS.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select
            value={form.status}
            onChange={(event) => update('status', event.target.value as PatientStatus)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(event) => update('phone', event.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} />
        </Field>
        <Field label="Address" className="form-span-2">
          <Textarea
            rows={2}
            value={form.address}
            onChange={(event) => update('address', event.target.value)}
          />
        </Field>
      </div>

      <div className={classList('card')} style={{ background: 'var(--danger-soft)', borderColor: '#f0c6c6' }}>
        <div className="card-body padded stack">
          <div className="row">
            <Badge tone="danger">Clinical alerts</Badge>
            <span className="subtle">Anything here appears as a red warning on the patient record.</span>
          </div>
          <div className="form-grid">
            <Field label="Allergies" hint="Drugs, foods, latex — separate items with commas.">
              <Textarea
                rows={2}
                value={form.allergies}
                onChange={(event) => update('allergies', event.target.value)}
                placeholder="Penicillin, sulfa drugs"
              />
            </Field>
            <Field label="Chronic conditions">
              <Textarea
                rows={2}
                value={form.chronicConditions}
                onChange={(event) => update('chronicConditions', event.target.value)}
                placeholder="Type 2 diabetes, hypertension"
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
        <Field label="Registration notes" className="form-span-2">
          <Textarea rows={2} value={form.notes} onChange={(event) => update('notes', event.target.value)} />
        </Field>
      </div>
      </form>
    </Modal>
  );
}
