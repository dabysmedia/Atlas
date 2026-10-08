import { useState } from 'react';
import { motion } from 'motion/react';
import { api, ApiError } from '../api';
import { Sigil } from './Sigil';

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/auth/login', { body: { username, password } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a minute.' : err instanceof Error ? err.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <motion.form className="login-card" onSubmit={submit}
        initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
        <Sigil color="#d4a64a" size={44} />
        <h1 className="display">Campaign Atlas</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 22 }}>Sign in to your worlds.</p>
        <div className="field">
          <label className="label" htmlFor="u">Username</label>
          <input id="u" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="p">Password</label>
          <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6, padding: '9px 12px' }} disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </motion.form>
    </div>
  );
}
