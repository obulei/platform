import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { platformFacilities, type FacilityBranding, type PlatformAdministrator, type PlatformFacility } from '../api.js';
import { usePlatformAuth } from '../platform-auth.js';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  StatusBadge,
  Table
} from '../components.js';
import type { Column } from '../components.js';
import { classList } from '../utils.js';

const MIN_PASSWORD = 10;
/** Same rule the server applies to a hospital address. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

interface AdministratorDraft {
  fullName: string;
  email: string;
  password: string;
}

const EMPTY_ADMIN: AdministratorDraft = { fullName: '', email: '', password: '' };

/** A hospital's own wording, as it is being typed into the identity dialog. */
type IdentityDraft = { name: string } & FacilityBranding;

const EMPTY_IDENTITY: IdentityDraft = {
  name: '',
  mark: '',
  tagline: '',
  accent: '',
  reportCaption: '',
  reportFootnote: ''
};

function validateAdministrator(draft: AdministratorDraft): string | null {
  if (draft.fullName.trim().length < 2) return 'The administrator needs a name.';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(draft.email.trim())) return 'Enter a valid work email address.';
  if (draft.password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`;
  return null;
}

const reason = (caught: unknown) =>
  caught instanceof Error && caught.message ? caught.message : 'The platform did not accept that.';

/**
 * What an operator does here: open a hospital with its first administrator, then
 * keep that hospital reachable — set its name and identity, add or quieten its
 * administrators, hand a locked-out one a new password, suspend it or bring it back.
 *
 * Everything clinical stays inside the hospital. This screen can switch an
 * administrator off, but it does not edit nurses, beds or tariffs: those belong to
 * the hospital's own Staff and Wards screens, under its own audit trail.
 */
export function PlatformHospitalsPage() {
  const { admin, signOut } = usePlatformAuth();
  const [facilities, setFacilities] = useState<PlatformFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [firstAdmin, setFirstAdmin] = useState<AdministratorDraft>(EMPTY_ADMIN);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Dialogs remember which hospital they are about by id, so a refresh after a
  // saved change re-reads the row the dialog is still showing.
  const [identityId, setIdentityId] = useState<string | null>(null);
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft>(EMPTY_IDENTITY);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const [manageId, setManageId] = useState<string | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [manageNote, setManageNote] = useState<string | null>(null);
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [newAdmin, setNewAdmin] = useState<AdministratorDraft>(EMPTY_ADMIN);
  const [busyAdmin, setBusyAdmin] = useState<string | null>(null);
  const [renamingAdmin, setRenamingAdmin] = useState<{ id: string; value: string } | null>(null);
  const [passwordFor, setPasswordFor] = useState<PlatformAdministrator | null>(null);
  const [passwordValue, setPasswordValue] = useState('');

  const editing = facilities.find((row) => row.id === identityId) ?? null;
  const setField = (key: keyof IdentityDraft) => (event: { target: { value: string } }) =>
    setIdentityDraft((draft) => ({ ...draft, [key]: event.target.value }));
  const managing = facilities.find((row) => row.id === manageId) ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await platformFacilities.list();
      setFacilities(result.items);
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
    setName('');
    setSlug('');
    setFirstAdmin(EMPTY_ADMIN);
    setFormError(null);
  }

  async function submitHospital(event: FormEvent) {
    event.preventDefault();
    const address = slug.trim().toLowerCase();
    if (name.trim().length < 2) return setFormError('Enter the hospital name.');
    if (!SLUG.test(address)) {
      return setFormError(
        'A hospital address is lowercase letters, digits and single hyphens, 3 to 50 characters, starting and ending with a letter or digit.'
      );
    }
    const problem = validateAdministrator(firstAdmin);
    if (problem) return setFormError(problem);

    setFormError(null);
    setSaving(true);
    try {
      await platformFacilities.create({
        slug: address,
        name: name.trim(),
        administrator: {
          fullName: firstAdmin.fullName.trim(),
          email: firstAdmin.email.trim(),
          password: firstAdmin.password
        }
      });
      closeAdd();
      await refresh();
    } catch (caught) {
      setFormError(reason(caught));
    } finally {
      setSaving(false);
    }
  }

  function openIdentity(facility: PlatformFacility) {
    setIdentityId(facility.id);
    setIdentityDraft({ name: facility.name, ...facility.branding });
    setIdentityError(null);
  }

  async function submitIdentity(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    if (identityDraft.name.trim().length < 2) return setIdentityError('Enter the hospital name.');

    setIdentityError(null);
    setSaving(true);
    try {
      const updated = await platformFacilities.update(editing.slug, {
        name: identityDraft.name.trim(),
        mark: identityDraft.mark.trim(),
        tagline: identityDraft.tagline.trim(),
        accent: identityDraft.accent.trim().toLowerCase(),
        reportCaption: identityDraft.reportCaption.trim(),
        reportFootnote: identityDraft.reportFootnote.trim()
      });
      setFacilities((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setIdentityId(null);
    } catch (caught) {
      setIdentityError(reason(caught));
    } finally {
      setSaving(false);
    }
  }

  function openManage(facility: PlatformFacility) {
    setManageId(facility.id);
    setManageError(null);
    setManageNote(null);
    setShowAddAdmin(false);
    setNewAdmin(EMPTY_ADMIN);
    setRenamingAdmin(null);
    setPasswordFor(null);
    setPasswordValue('');
  }

  async function toggleAdministrator(person: PlatformAdministrator) {
    if (!managing) return;
    setBusyAdmin(person.id);
    setManageError(null);
    try {
      await platformFacilities.setAdministrator(managing.slug, person.id, { isActive: !person.isActive });
      await refresh();
      setManageNote(
        person.isActive
          ? `${person.fullName} can no longer sign in. Any session already open stops on its next request.`
          : `${person.fullName} can sign in again at ${managing.slug}.`
      );
    } catch (caught) {
      setManageError(reason(caught));
    } finally {
      setBusyAdmin(null);
    }
  }

  async function submitAdministratorName(event: FormEvent) {
    event.preventDefault();
    if (!managing || !renamingAdmin) return;
    if (renamingAdmin.value.trim().length < 2) return setManageError('Enter a name of at least two characters.');

    setBusyAdmin(renamingAdmin.id);
    setManageError(null);
    try {
      await platformFacilities.setAdministrator(managing.slug, renamingAdmin.id, {
        fullName: renamingAdmin.value.trim()
      });
      setRenamingAdmin(null);
      await refresh();
    } catch (caught) {
      setManageError(reason(caught));
    } finally {
      setBusyAdmin(null);
    }
  }

  async function submitNewAdministrator(event: FormEvent) {
    event.preventDefault();
    if (!managing) return;
    const problem = validateAdministrator(newAdmin);
    if (problem) return setManageError(problem);

    setManageError(null);
    setSaving(true);
    try {
      await platformFacilities.addAdministrator(managing.slug, {
        fullName: newAdmin.fullName.trim(),
        email: newAdmin.email.trim(),
        password: newAdmin.password
      });
      setShowAddAdmin(false);
      setNewAdmin(EMPTY_ADMIN);
      await refresh();
    } catch (caught) {
      setManageError(reason(caught));
    } finally {
      setSaving(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!managing || !passwordFor) return;
    if (passwordValue.length < MIN_PASSWORD) {
      return setManageError(`Use at least ${MIN_PASSWORD} characters.`);
    }

    setManageError(null);
    setSaving(true);
    try {
      await platformFacilities.resetAdministratorPassword(managing.slug, passwordFor.id, passwordValue);
      setPasswordFor(null);
      setPasswordValue('');
      setManageNote(
        `Password set for ${passwordFor.email}. It is not shown again — pass it on however you send other credentials.`
      );
    } catch (caught) {
      setManageError(reason(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(facility: PlatformFacility) {
    const status = facility.status === 'active' ? 'suspended' : 'active';
    setBusySlug(facility.slug);
    try {
      const updated = await platformFacilities.setStatus(facility.slug, status);
      setFacilities((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    } catch (caught) {
      setLoadError(caught);
    } finally {
      setBusySlug(null);
    }
  }

  const columns: Column<PlatformFacility>[] = [
    {
      key: 'hospital',
      header: 'Hospital',
      render: (row) => (
        <div className="stack stack-sm">
          <strong>{row.name}</strong>
          <span className="subtle">
            Staff sign in with <strong>{row.slug}</strong>
          </span>
        </div>
      )
    },
    { key: 'status', header: 'Status', width: '120px', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'administrators',
      header: 'Administrators',
      render: (row) =>
        row.administrators.length ? (
          <div className="stack stack-sm">
            {row.administrators.map((person) => (
              <span key={person.id}>
                {person.fullName}{' '}
                <span className="subtle">
                  {person.email}
                  {!person.isActive && ' · deactivated'}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <Badge tone="warning">none yet</Badge>
        )
    },
    {
      key: 'size',
      header: 'Records',
      width: '150px',
      render: (row) => (
        <span className="subtle">
          {row.staffCount} staff · {row.patientCount} patients
        </span>
      )
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '320px',
      render: (row) => (
        <div className="row-actions">
          <Button size="sm" onClick={() => openManage(row)}>
            Administrators
          </Button>
          <Button size="sm" onClick={() => openIdentity(row)}>
            Identity
          </Button>
          <Button
            size="sm"
            variant={row.status === 'active' ? 'danger' : 'primary'}
            loading={busySlug === row.slug}
            onClick={() => void toggleStatus(row)}
          >
            {row.status === 'active' ? 'Suspend' : 'Reactivate'}
          </Button>
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
            <h1>All hospitals</h1>
          </div>
          <div className="topbar-actions">
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add hospital
            </Button>
          </div>
        </header>

        <main className="page">
          <ErrorNote error={loadError} onDismiss={() => setLoadError(null)} />

          <Card
            title="Hospitals"
            subtitle="Each hospital has its own database. Staff sign in with their hospital address, so the same email can belong to people at two clinics."
          >
            <Table
              columns={columns}
              rows={facilities}
              loading={loading}
              empty="No hospitals yet. Add the first one."
            />
          </Card>
        </main>
      </div>

      {addOpen && (
        <Modal
          title="Add a hospital"
          subtitle="The address becomes part of every sign-in at that clinic, so choose one the clinic will recognise."
          onClose={closeAdd}
          width="md"
        >
          <form className="form-grid" onSubmit={submitHospital}>
            <Field label="Hospital name" required className="form-span-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Meridian General Hospital"
                autoFocus
              />
            </Field>

            <Field
              label="Hospital address"
              required
              hint="Lowercase letters, digits and single hyphens, 3 to 50 characters. Staff type this to sign in."
              className="form-span-2"
            >
              <Input
                value={slug}
                spellCheck={false}
                onChange={(event) => setSlug(event.target.value.trim().toLowerCase())}
                placeholder="meridian-general"
              />
            </Field>

            <div className="form-span-2 page-head">
              <h2>First administrator</h2>
              <p>
                A hospital needs an administrator before it can manage anything of its own — this
                account is created with the hospital.
              </p>
            </div>

            <Field label="Full name" required>
              <Input
                value={firstAdmin.fullName}
                onChange={(event) => setFirstAdmin({ ...firstAdmin, fullName: event.target.value })}
                autoComplete="off"
              />
            </Field>

            <Field label="Work email" required>
              <Input
                type="email"
                value={firstAdmin.email}
                onChange={(event) => setFirstAdmin({ ...firstAdmin, email: event.target.value })}
                autoComplete="off"
              />
            </Field>

            <Field
              label="Password"
              required
              hint={`At least ${MIN_PASSWORD} characters. It is stored hashed and never shown again, so send it to the person yourself.`}
              className="form-span-2"
            >
              <Input
                type="password"
                value={firstAdmin.password}
                onChange={(event) => setFirstAdmin({ ...firstAdmin, password: event.target.value })}
                autoComplete="new-password"
              />
            </Field>

            {formError && <p className="form-span-2 field-error">{formError}</p>}

            <div className="form-span-2 row-actions">
              <Button type="button" onClick={closeAdd}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Add hospital
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal
          title="Hospital identity"
          subtitle={`The address stays ${editing.slug} — staff keep signing in with it.`}
          onClose={() => setIdentityId(null)}
          width="md"
        >
          <form className="stack" onSubmit={submitIdentity}>
            <p className="subtle">
              The same words this hospital's own administrators can set under Settings. Blank fields use the
              software's defaults.
            </p>

            <div className="form-grid">
              <Field label="Hospital name" required hint="Shown on its screens and printed documents.">
                <Input value={identityDraft.name} onChange={setField('name')} autoFocus />
              </Field>

              <Field label="Sign-in address" hint="Chosen when the hospital was opened and never changed.">
                <Input value={editing.slug} readOnly className="mono" />
              </Field>

              <Field label="Brand mark" hint="One or two characters. Blank uses the first letter of the name.">
                <Input value={identityDraft.mark} onChange={setField('mark')} maxLength={2} />
              </Field>

              <Field label="Accent colour" hint="A hex colour like #12628f, or blank for the default.">
                <Input value={identityDraft.accent} onChange={setField('accent')} maxLength={7} className="mono" />
              </Field>

              <Field label="Line under the name" hint="The sidebar subtitle." className="form-span-2">
                <Input value={identityDraft.tagline} onChange={setField('tagline')} maxLength={60} />
              </Field>

              <Field label="Report heading line" hint="Printed under the name on a clinical report." className="form-span-2">
                <Input value={identityDraft.reportCaption} onChange={setField('reportCaption')} maxLength={80} />
              </Field>

              <Field label="Report footnote" hint="The closing sentence printed at the foot of a report." className="form-span-2">
                <Input value={identityDraft.reportFootnote} onChange={setField('reportFootnote')} maxLength={160} />
              </Field>
            </div>

            {identityError && <p className="field-error">{identityError}</p>}

            <div className="row-actions">
              <Button type="button" onClick={() => setIdentityId(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Save identity
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {managing && (
        <Modal
          title="Administrators"
          subtitle={`${managing.name} · signs in at ${managing.slug}`}
          onClose={() => setManageId(null)}
          width="md"
        >
          <div className="stack">
            {managing.administrators.length === 0 && (
              <p className="subtle">
                This hospital has no administrator yet, so nobody can sign in to it. Add one below.
              </p>
            )}

            {managing.administrators.map((person) => (
              <div className="stack stack-sm" key={person.id}>
                <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                  <div className="stack stack-sm">
                    <strong>{person.fullName}</strong>
                    <span className="subtle">{person.email}</span>
                  </div>
                  <div className="row-actions">
                    <Badge tone={person.isActive ? 'success' : 'neutral'}>
                      {person.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => setRenamingAdmin({ id: person.id, value: person.fullName })}>
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPasswordFor(person);
                        setPasswordValue('');
                        setManageNote(null);
                      }}
                    >
                      Reset password
                    </Button>
                    <Button
                      size="sm"
                      variant={person.isActive ? 'danger' : 'primary'}
                      loading={busyAdmin === person.id}
                      onClick={() => void toggleAdministrator(person)}
                    >
                      {person.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </div>

                {renamingAdmin?.id === person.id && (
                  <form className="row-actions" style={{ justifyContent: 'space-between' }} onSubmit={submitAdministratorName}>
                    <Input
                      value={renamingAdmin.value}
                      onChange={(event) => setRenamingAdmin({ id: person.id, value: event.target.value })}
                      autoFocus
                    />
                    <div className="row-actions">
                      <Button size="sm" type="button" onClick={() => setRenamingAdmin(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" type="submit" variant="primary" loading={busyAdmin === person.id}>
                        Save
                      </Button>
                    </div>
                  </form>
                )}

                {passwordFor?.id === person.id && (
                  <form className="stack stack-sm" onSubmit={submitPassword}>
                    <Field
                      label={`New password for ${person.email}`}
                      required
                      hint={`At least ${MIN_PASSWORD} characters. Not shown again after saving.`}
                    >
                      <Input
                        type="password"
                        value={passwordValue}
                        onChange={(event) => setPasswordValue(event.target.value)}
                        autoComplete="new-password"
                        autoFocus
                      />
                    </Field>
                    <div className="row-actions">
                      <Button size="sm" type="button" onClick={() => setPasswordFor(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" type="submit" variant="primary" loading={saving}>
                        Set password
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            ))}

            {manageError && <p className="field-error">{manageError}</p>}
            {manageNote && <p className="subtle">{manageNote}</p>}

            {showAddAdmin ? (
              <form className="stack stack-sm" onSubmit={submitNewAdministrator}>
                <Field label="Full name" required>
                  <Input
                    value={newAdmin.fullName}
                    onChange={(event) => setNewAdmin({ ...newAdmin, fullName: event.target.value })}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Work email" required hint="Unique inside this hospital only.">
                  <Input
                    type="email"
                    value={newAdmin.email}
                    onChange={(event) => setNewAdmin({ ...newAdmin, email: event.target.value })}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Password" required hint={`At least ${MIN_PASSWORD} characters.`}>
                  <Input
                    type="password"
                    value={newAdmin.password}
                    onChange={(event) => setNewAdmin({ ...newAdmin, password: event.target.value })}
                    autoComplete="new-password"
                  />
                </Field>
                <div className="row-actions">
                  <Button size="sm" type="button" onClick={() => setShowAddAdmin(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" type="submit" variant="primary" loading={saving}>
                    Add administrator
                  </Button>
                </div>
              </form>
            ) : (
              <div className="row-actions">
                <Button size="sm" onClick={() => setShowAddAdmin(true)}>
                  Add administrator
                </Button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
