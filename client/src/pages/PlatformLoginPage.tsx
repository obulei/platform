import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePlatformAuth } from '../platform-auth.js';
import { Button, ErrorNote, Field, Input } from '../components.js';

/**
 * The operator's door. Deliberately separate from the staff sign-in: this one
 * creates hospitals and their first administrators, and it cannot open a patient
 * record — the token it mints names no hospital at all.
 */
export function PlatformLoginPage() {
  const { signIn } = usePlatformAuth();
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
      navigate('/platform', { replace: true });
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
            P
          </span>
          <span className="brand-text">
            <strong style={{ color: 'var(--text)' }}>Hospital platform</strong>
            <span>Operator console</span>
          </span>
        </div>
        <h1>Platform sign in</h1>
        <p>
          This console adds hospitals and their first administrators. It holds no clinical role, so
          it cannot open a patient record.
        </p>

        <Field label="Email" required>
          <Input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="ops@example.org"
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

        <p className="login-foot">
          Working at a hospital? <Link to="/login">Staff sign in</Link>
        </p>
      </form>
    </div>
  );
}
