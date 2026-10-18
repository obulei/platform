import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { useAuth } from '../auth.js';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Modal,
  SearchInput,
  Select,
  StatusBadge,
  Table
} from '../components.js';
import type { Column } from '../components.js';
import { ROLES, ROLE_LABEL, ROLE_TONE, sortRoles, type Role } from '../roles.js';
import { formatDateTime, formatMoney } from '../utils.js';

/* ------------------------------------------------------------------ types
 * Field names copied from the `dto()` in server/src/modules/staff.routes.ts. */

interface StaffMember {
  id: string;
  fullName: string;
  email: string;
  /** Every role this person has been granted; they pick one at sign-in. */
  roles: string[];
  phone: string | null;
  department: string | null;
  specialty: string | null;
  consultationFee: number;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const MIN_PASSWORD = 10;

interface ProfileDraft {
  fullName: string;
  email: string;
  roles: Role[];
  phone: string;
  department: string;
  specialty: string;
  consultationFee: string;
}

const EMPTY_DRAFT: ProfileDraft = {
  fullName: '',
  email: '',
  roles: ['doctor'],
  phone: '',
  department: '',
  specialty: '',
  consultationFee: '0'
};

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Drops anything the client does not know about so the checkboxes always match the server enum. */
function grantedRoles(roles: string[]): Role[] {
  const known = roles.filter((role) => (ROLES as readonly string[]).includes(role)) as Role[];
  return sortRoles<Role>(known.length ? known : ['reception']);
}

/** Body for POST /api/staff and PATCH /api/staff/:id — the server accepts the same profile shape. */
function profileBody(draft: ProfileDraft, isActive: boolean) {
  return {
    fullName: draft.fullName.trim(),
    email: draft.email.trim(),
    roles: sortRoles(draft.roles),
    phone: blankToNull(draft.phone),
    department: blankToNull(draft.department),
    specialty: blankToNull(draft.specialty),
    consultationFee: Number(draft.consultationFee || 0),
    isActive
  };
}

function validateProfile(draft: ProfileDraft): string | null {
  if (draft.fullName.trim().length < 2) return 'Full name needs at least 2 characters.';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(draft.email.trim())) return 'Enter a valid work email address.';
  if (draft.roles.length === 0) return 'Tick at least one role, or this account could never sign in.';
  const fee = Number(draft.consultationFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) return 'Consultation fee must be between 0 and 1,000,000.';
  return null;
}

/* ------------------------------------------------------------- field grid */

function RoleBadges({ roles }: { roles: string[] }) {
  const list = sortRoles(roles);
  if (!list.length) return <span className="subtle">none granted</span>;
  return (
    <span className="role-badges">
      {list.map((role) => (
        <Badge key={role} tone={ROLE_TONE[role] ?? 'neutral'}>
          {ROLE_LABEL[role] ?? role}
        </Badge>
      ))}
    </span>
  );
}

function ProfileFields({
  draft,
  onChange,
  disabled
}: {
  draft: ProfileDraft;
  onChange: (patch: Partial<ProfileDraft>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-grid">
      <Field label="Full name" required>
        <Input
          value={draft.fullName}
          disabled={disabled}
          onChange={(event) => onChange({ fullName: event.target.value })}
          placeholder="Dr Amina Nakato"
        />
      </Field>
      <Field label="Work email" required hint="Used to sign in; must be unique.">
        <Input
          type="email"
          value={draft.email}
          disabled={disabled}
          onChange={(event) => onChange({ email: event.target.value })}
          placeholder="name@clinic.test"
        />
      </Field>
      <fieldset className="role-set form-span-2">
        <legend>
          Roles <span className="req">*</span>
        </legend>
        <div className="role-checks">
          {ROLES.map((role) => (
            <label key={role} className="checkline">
              <input
                type="checkbox"
                checked={draft.roles.includes(role)}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    roles: event.target.checked
                      ? sortRoles([...draft.roles, role])
                      : draft.roles.filter((held) => held !== role)
                  })
                }
              />
              {ROLE_LABEL[role]}
            </label>
          ))}
        </div>
        <p className="role-hint">
          Tick every module this person should reach. They choose one of these roles at sign-in and work as that role
          until they switch — several roles never combine into one session.
        </p>
      </fieldset>
      <Field label="Phone">
        <Input value={draft.phone} disabled={disabled} onChange={(event) => onChange({ phone: event.target.value })} />
      </Field>
      <Field label="Department">
        <Input
          value={draft.department}
          disabled={disabled}
          onChange={(event) => onChange({ department: event.target.value })}
          placeholder="General ward"
        />
      </Field>
      <Field label="Specialty">
        <Input
          value={draft.specialty}
          disabled={disabled}
          onChange={(event) => onChange({ specialty: event.target.value })}
          placeholder="Paediatrics"
        />
      </Field>
      <Field label="Consultation fee" hint="Shown on invoices when this clinician is booked.">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={draft.consultationFee}
          disabled={disabled}
          onChange={(event) => onChange({ consultationFee: event.target.value })}
        />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------ create modal */

function CreateStaffModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> | void }) {
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const invalid = validateProfile(draft);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFieldError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      await api<StaffMember>('/api/staff', {
        method: 'POST',
        body: { ...profileBody(draft, isActive), password }
      });
      // Wipe the secret from state before closing.
      setPassword('');
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add staff member"
      subtitle="Creates the sign-in account and the clinician record in one step."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Create account
          </Button>
        </>
      }
    >
      <ProfileFields draft={draft} disabled={busy} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
      <Field label="Initial password" required error={fieldError ?? undefined} hint={`Minimum ${MIN_PASSWORD} characters — the server rejects shorter ones.`}>
        <Input
          type="password"
          value={password}
          autoComplete="new-password"
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <label className="checkline">
        <input type="checkbox" checked={isActive} disabled={busy} onChange={(event) => setIsActive(event.target.checked)} />
        Account active (can sign in immediately)
      </label>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
    </Modal>
  );
}

/* --------------------------------------------------------------- edit modal */

function EditStaffModal({
  member,
  isSelf,
  onClose,
  onSaved
}: {
  member: StaffMember;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>({
    fullName: member.fullName,
    email: member.email,
    roles: grantedRoles(member.roles),
    phone: member.phone ?? '',
    department: member.department ?? '',
    specialty: member.specialty ?? '',
    consultationFee: String(member.consultationFee ?? 0)
  });
  const [isActive, setIsActive] = useState(member.isActive);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [resetError, setResetError] = useState<unknown>(null);
  const [resetFieldError, setResetFieldError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function saveProfile() {
    const invalid = validateProfile(draft);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      // PATCH takes the same profile fields minus the password.
      await api<StaffMember>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: profileBody(draft, isActive)
      });
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (newPassword.length < MIN_PASSWORD) {
      setResetFieldError(`New password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (!adminPassword) {
      setResetFieldError('Enter your own password to confirm.');
      return;
    }
    setResetFieldError(null);
    setResetError(null);
    setResetDone(false);
    setResetBusy(true);
    try {
      await api<void>(`/api/staff/${member.id}/reset-password`, {
        method: 'POST',
        body: { newPassword, adminPassword }
      });
      setResetDone(true);
      await onSaved();
    } catch (caught) {
      setResetError(caught);
    } finally {
      // Both secrets are dropped as soon as the request settles.
      setNewPassword('');
      setAdminPassword('');
      setResetBusy(false);
    }
  }

  return (
    <Modal
      width="lg"
      title={`Edit ${member.fullName}`}
      subtitle={
        <>
          <RoleBadges roles={member.roles} />{' '}
          <span className="subtle">Signs in as {member.email}</span>
          {isSelf && <span className="subtle"> · this is your own account</span>}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" onClick={saveProfile} loading={busy} disabled={busy}>
            Save changes
          </Button>
        </>
      }
    >
      <ProfileFields draft={draft} disabled={busy} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
      {fieldError && <p className="field-error">{fieldError}</p>}

      <div className="stack stack-sm">
        <label className="checkline">
          <input
            type="checkbox"
            checked={isActive}
            disabled={isSelf || busy}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          Account active
        </label>
        <p className="subtle">
          Deactivating blocks sign-in immediately and hides this person from booking dropdowns.
          {isSelf && ' You cannot deactivate your own account — the server rejects it.'}
        </p>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <Card title="Reset this person's password" subtitle="Required when someone has lost access.">
        <div className="stack">
          <div className="form-grid">
            <Field
              label="New password"
              required
              hint={`At least ${MIN_PASSWORD} characters.`}
              error={resetFieldError ?? undefined}
            >
              <Input
                type="password"
                value={newPassword}
                autoComplete="new-password"
                disabled={resetBusy}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field label="Your own password" required hint="The server re-checks the acting administrator's credentials before allowing a reset.">
              <Input
                type="password"
                value={adminPassword}
                autoComplete="current-password"
                disabled={resetBusy}
                onChange={(event) => setAdminPassword(event.target.value)}
              />
            </Field>
          </div>
          <p className="subtle">
            Your password is sent only with this request and is cleared from the form afterwards — it is never stored or
            written to the console.
          </p>
          {resetDone && <div className="banner">Password reset for {member.fullName}.</div>}
          <ErrorNote error={resetError} onDismiss={() => setResetError(null)} />
          <div className="row">
            <Button
              variant="danger"
              onClick={resetPassword}
              loading={resetBusy}
              disabled={resetBusy || !newPassword || !adminPassword}
            >
              Reset password
            </Button>
          </div>
        </div>
      </Card>

      <dl className="detail-list">
        <div className="detail-item">
          <span>Last sign-in</span>
          <strong>{formatDateTime(member.lastLoginAt)}</strong>
        </div>
        <div className="detail-item">
          <span>Account created</span>
          <strong>{formatDateTime(member.createdAt)}</strong>
        </div>
      </dl>
    </Modal>
  );
}

/* ------------------------------------------------------------------- page */

export function StaffPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<StaffMember[]>('/api/staff', { query: { role: roleFilter || undefined } });
      setRows(data);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [roleFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visible = term
    ? rows.filter(
        (row) => row.fullName.toLowerCase().includes(term) || row.email.toLowerCase().includes(term)
      )
    : rows;

  const columns: Column<StaffMember>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.fullName}</div>
          {row.id === user?.id && <span className="subtle">you</span>}
        </div>
      ),
      width: '18%'
    },
    { key: 'email', header: 'Email', render: (row) => <span className="muted">{row.email}</span> },
    {
      key: 'roles',
      header: 'Roles',
      render: (row) => <RoleBadges roles={row.roles} />,
      width: '20%'
    },
    { key: 'department', header: 'Department', render: (row) => row.department ?? <span className="subtle">—</span> },
    { key: 'specialty', header: 'Specialty', render: (row) => row.specialty ?? <span className="subtle">—</span> },
    {
      key: 'fee',
      header: 'Fee',
      align: 'right',
      render: (row) => <span className="mono">{formatMoney(row.consultationFee)}</span>
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.isActive ? 'active' : 'inactive'} />
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      render: (row) => <span className="muted nowrap">{formatDateTime(row.lastLoginAt)}</span>
    }
  ];

  if (error instanceof ApiError && error.status === 403) {
    return (
      <>
        <div className="page-head">
          <div>
            <h2>Staff accounts</h2>
            <p>Administrator-only area.</p>
          </div>
        </div>
        <Card title="Permission denied">
          <p className="muted">Only administrators can list or manage staff accounts.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Staff accounts ({rows.length})</h2>
          <p>Create sign-in accounts, adjust clinician details and reset passwords.</p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          Add staff member
        </Button>
      </div>

      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" />
          <Select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} style={{ width: 200 }}>
            <option value="">All roles</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </Select>
          {roleFilter && (
            <Button size="sm" variant="ghost" onClick={() => setRoleFilter('')}>
              Clear role
            </Button>
          )}
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            Reload
          </Button>
        </div>

        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <Loading label="Loading staff…" />
        ) : (
          <Table
            columns={columns}
            rows={visible}
            empty={
              term || roleFilter
                ? 'No staff match this search or role filter.'
                : 'No staff accounts exist yet — add the first one.'
            }
            onRowClick={(row) => setEditing(row)}
          />
        )}
      </Card>

      {createOpen && <CreateStaffModal onClose={() => setCreateOpen(false)} onSaved={load} />}

      {editing && (
        <EditStaffModal
          key={editing.id}
          member={editing}
          isSelf={editing.id === user?.id}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </>
  );
}
