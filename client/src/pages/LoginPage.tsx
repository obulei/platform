import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { Button, ErrorNote, Field, Input } from '../components.js';

const DEMO_ACCOUNTS = [
  { label: 'Administrator', email: 'admin@clinic.test' },
  { label: 'Reception', email: 'reception@clinic.test' },
  { label: 'Doctor', email: 'doctor@clinic.test' },
  { label: 'Nurse', email: 'nurse@clinic.test' },
  { label: 'Pharmacist', email: 'pharmacy@clinic.test' },
  { label: 'Lab tech', email: 'lab@clinic.test' },
  { label: 'Billing', email: 'billing@clinic.test' }
];

const DEMO_PASSWORD = 'Clinic#2026';

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span className="brand-text">
            <strong style={{ color: 'var(--text)' }}>Kisubi Medical Centre</strong>
          </span>
        </div>
        <h1>Staff sign in</h1>
        <p>Patient records are role-restricted. Everything you do here is logged.</p>

        <Field label="Work email" required>
          <Input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
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

        <ErrorNote error={error} onDismiss={() => setError(null)} />

        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>

        <div className="demo-accounts">
          <h4>Demo accounts after seeding</h4>
          <div className="demo-list">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                type="button"
                key={account.email}
                className="demo-chip"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                {account.label}
              </button>
            ))}
          </div>
          <p style={{ marginTop: 10 }}>
            Password for all demo accounts: <span className="mono">{DEMO_PASSWORD}</span>
          </p>
        </div>
      </form>
    </div>
  );
}
