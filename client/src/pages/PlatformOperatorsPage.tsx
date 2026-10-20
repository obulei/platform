import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { platformOperators, type PlatformOperator } from '../api.js';
import { usePlatformAuth } from '../platform-auth.js';
import { Button, Card, ErrorNote, Field, Input, Modal, Table } from '../components.js';
import type { Column } from '../components.js';
import { classList } from '../utils.js';

const MIN_PASSWORD = 10;
const reason = (caught: unknown) =>
  caught instanceof Error && caught.message ? caught.message : 'The platform did not accept that.';

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'never signed in';

/**
 * The accounts that can add hospitals. An operator is not clinic staff and holds no
 * clinical role, so this list is the whole of who may open a clinic on this
 * deployment — which is why it refuses to remove the last one, or the one you are
 * using.
 */
export function PlatformOperatorsPage() {
  const { admin, signOut } = usePlatformAuth();
  const [operators, setOperators] = useState<PlatformOperator[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await platformOperators.list();
      setOperators(result.items);
    } catch (caught) {
      setLoadError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function closeAdd() {
    setAddOpen(false);
    setFullName('');
    setEmail('');
    setPassword('');
    setFormError(null);
  }

  async function submitOperator(event: FormEvent) {
    event.preventDefault();
    if (fullName.trim().length < 2) return setFormError('Enter the operator name.');
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email.trim())) return setFormError('Enter a valid email address.');
    if (password.length < MIN_PASSWORD) return setFormError(`Use at least ${MIN_PASSWORD} characters.`);

    setFormError(null);
    setSaving(true);
    try {
      await platformOperators.add({ fullName: fullName.trim(), email: email.trim(), password });
      closeAdd();
      await refresh();
    } catch (caught) {
      setFormError(reason(caught));
    } finally {
      setSaving(false);
    }
  }

  async function removeOperator(operator: PlatformOperator) {
    setBusyId(operator.id);
    setLoadError(null);
    try {
      await platformOperators.remove(operator.id);
      await refresh();
    } catch (caught) {
      setLoadError(caught);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<PlatformOperator>[] = [
    {
      key: 'operator',
      header: 'Operator',
      render: (row) => (
        <div className="stack stack-sm">
          <strong>
            {row.fullName}
            {row.id === admin?.id && <span className="subtle"> · this is you</span>}
          </strong>
          <span className="subtle">{row.email}</span>
        </div>
      )
    },
    {
      key: 'created',
      header: 'Added',
      width: '180px',
      render: (row) => <span className="subtle">{new Date(row.createdAt).toLocaleString()}</span>
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      width: '180px',
      render: (row) => <span className="subtle">{when(row.lastLoginAt)}</span>
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '140px',
      render: (row) => (
        <div className="row-actions">
          {row.id !== admin?.id && (
            <Button
              size="sm"
              variant="danger"
              loading={busyId === row.id}
              disabled={operators.length <= 1}
              onClick={() => void removeOperator(row)}
            >
              Remove
            </Button>
          )}
        </div>
      )
    }
  ];

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Platform navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-text">
            <strong>Hospital platform</strong>
            <span>Operator console</span>
          </span>
        </div>

        <span className="nav-group-label">Hospitals</span>
        <NavLink to="/platform" end className={({ isActive }) => classList('nav-link', isActive && 'is-active')}>
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 21V7a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14M13 21V11h5a2 2 0 0 1 2 2v8M4 21h16M7 9h2m-2 4h2m7 4h2M4 3h9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All hospitals
        </NavLink>
        <NavLink to="/platform/operators" className={({ isActive }) => classList('nav-link', isActive && 'is-active')}>
          <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M16 19a4 4 0 0 0-8 0M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Operators
        </NavLink>

        <div className="sidebar-foot">
          <div className="who">
            <strong>{admin?.fullName}</strong>
            <span>Platform operator</span>
          </div>
          <button type="button" className="sign-out" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="crumb">Hospital platform · {admin?.email}</div>
            <h1>Platform operators</h1>
          </div>
          <div className="topbar-actions">
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add operator
            </Button>
          </div>
        </header>

        <main className="page">
          <ErrorNote error={loadError} onDismiss={() => setLoadError(null)} />

          <Card
            title="Who may add hospitals"
            subtitle="One account per person. Operators sign in at /platform and hold no clinical role in any hospital."
          >
            <Table columns={columns} rows={operators} loading={loading} empty="No operators." />
          </Card>
        </main>
      </div>

      {addOpen && (
        <Modal
          title="Add a platform operator"
          subtitle="This person will be able to open hospitals and create their first administrators."
          onClose={closeAdd}
          width="sm"
        >
          <form className="stack" onSubmit={submitOperator}>
            <Field label="Full name" required>
              <Input value={fullName} onChange={(event) => setFullName(event.target.value)} autoFocus autoComplete="off" />
            </Field>

            <Field label="Email" required>
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" />
            </Field>

            <Field
              label="Password"
              required
              hint={`At least ${MIN_PASSWORD} characters. Not shown again after saving, so pass it on yourself.`}
            >
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {formError && <p className="field-error">{formError}</p>}

            <div className="row-actions">
              <Button type="button" onClick={closeAdd}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Add operator
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
