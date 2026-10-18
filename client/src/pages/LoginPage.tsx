import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api.js';
import { useAuth } from '../auth.js';
import { CLINIC } from '../branding.js';
import { roleLabel } from '../roles.js';
import { Button, ErrorNote, Field, Input, Select } from '../components.js';

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleChoices, setRoleChoices] = useState<string[]>([]);
  const [activeRole, setActiveRole] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password, activeRole || undefined);
      navigate('/', { replace: true });
    } catch (caught) {
      // An account can hold several roles. Once the password checks out the
      // server asks for one of them, and only ever lists this person's own.
      if (caught instanceof ApiError && caught.code === 'role_required') {
        setActiveRole('');
        setRoleChoices(caught.roles ?? []);
      } else {
        setError(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  const needsRole = roleChoices.length > 0;

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            {CLINIC.mark}
          </span>
          <span className="brand-text">
            <strong style={{ color: 'var(--text)' }}>{CLINIC.name}</strong>
          </span>
        </div>
        <h1>Staff sign in</h1>
        <p>Patient records are role-restricted. Everything you do here is logged.</p>

        <Field label="Work email" required>
          <Input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => {
              setEmail(event.target.value);
              setRoleChoices([]);
              setActiveRole('');
            }}
            placeholder="name@clinic.test"
            required
          />
        </Field>

        <Field label="Password" required>
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>

        {needsRole && (
          <Field
            label="Sign in as"
            required
            hint="Your account holds more than one role. Only one is active at a time — you can switch from the sidebar later."
          >
            <Select value={activeRole} disabled={busy} onChange={(event) => setActiveRole(event.target.value)}>
              <option value="">Choose a role…</option>
              {roleChoices.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <ErrorNote error={error} onDismiss={() => setError(null)} />

        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!email || !password || (needsRole && !activeRole)}
        >
          Sign in
        </Button>
      </form>
    </div>
  );
}
