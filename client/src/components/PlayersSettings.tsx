import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Trash2, UserPlus } from 'lucide-react';
import { api, qk } from '../api';
import { useMe, type Me } from '../me';
import type { CampaignChoice, Player } from '../types';
import { Dialog } from './Dialog';
import { toast, toastError } from './toast';

type PlayersData = { players: Player[]; campaigns: CampaignChoice[] };

/** Campaigns as chips, grouped under their worlds: a player belongs to the ones lit. */
function CampaignChips({ campaigns, chosen, onToggle, disabled }: {
  campaigns: CampaignChoice[]; chosen: string[]; onToggle: (id: string) => void; disabled?: boolean;
}) {
  const worlds = [...new Map(campaigns.map((c) => [c.worldId, c.worldName])).entries()];
  if (!campaigns.length) return <span className="faint" style={{ fontSize: 12 }}>No campaigns yet: add one under Campaigns, then choose it here.</span>;
  return (
    <div className="camp-chips">
      {worlds.map(([wid, wname]) => (
        <div key={wid} className="camp-world">
          <span className="camp-world-name">{wname}</span>
          {campaigns.filter((c) => c.worldId === wid).map((c) => {
            const on = chosen.includes(c.id);
            return (
              <button key={c.id} type="button" className={`chip camp-chip ${on ? 'on' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => onToggle(c.id)}>
                {on && <Check size={11} />}{c.name}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A password shown once, to pass on to the player. */
function PasswordReveal({ shown, onClose }: { shown: { name: string; username: string; password: string } | null; onClose: () => void }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(shown!.password); toast('Password copied'); } catch { toast('Select the password and copy it.'); }
  };
  return (
    <Dialog open={!!shown} onClose={onClose} title={`Pass this on to ${shown?.name ?? ''}`}>
      <p className="muted" style={{ marginTop: 0 }}>They sign in as <b>{shown?.username}</b> with this password. It isn’t shown again; they can change it under Your account.</p>
      <div className="pw-reveal">
        <code data-testid="generated-password">{shown?.password}</code>
        <button className="btn sm" onClick={copy}><Copy size={13} /> Copy</button>
      </div>
      <div className="actions"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}

/**
 * The GM's players: add one (with a password the GM sets, or one generated and shown once), choose their campaigns
 * (which decide the worlds they see), reset a password, or remove them. Removing or resetting signs them out at once.
 */
export function PlayersCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.players, queryFn: () => api<PlayersData>('/api/players'), refetchInterval: 15_000 });
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState<Player | null>(null);
  const [removing, setRemoving] = useState<Player | null>(null);
  const [shown, setShown] = useState<{ name: string; username: string; password: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.players });
  const setCampaigns = async (p: Player, ids: string[]) => {
    qc.setQueryData<PlayersData>(qk.players, (d) => d && { ...d, players: d.players.map((x) => (x.id === p.id ? { ...x, campaignIds: ids } : x)) });
    try { await api(`/api/players/${p.id}/campaigns`, { method: 'PUT', body: { campaignIds: ids } }); } catch (e) { toastError(e); refresh(); }
  };
  const rename = async (p: Player, displayName: string) => {
    if (!displayName.trim() || displayName.trim() === p.displayName) return;
    try { await api(`/api/players/${p.id}`, { method: 'PATCH', body: { displayName: displayName.trim() } }); refresh(); } catch (e) { toastError(e); }
  };
  const remove = async (p: Player) => {
    try { await api(`/api/players/${p.id}`, { method: 'DELETE' }); toast(`${p.displayName || p.username} removed and signed out`); refresh(); } catch (e) { toastError(e); }
  };
  const players = q.data?.players ?? [];
  const campaigns = q.data?.campaigns ?? [];
  return (
    <>
      <div className="row" style={{ margin: '28px 0 6px', alignItems: 'flex-end' }}>
        <h3 className="display grow" style={{ margin: 0 }}>Players</h3>
        <button className="btn sm primary" onClick={() => setAdding(true)}><UserPlus size={14} /> Add player</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Players sign in with their own username and password. They see the worlds of the campaigns you choose for them, through
        their party’s fog: no GM notes, hidden markers, GM-only pages, faction meters or roll tables. They can move their party’s
        marker, keep party notes on hexes and write wiki pages.
      </p>
      <div className="card players-card" data-testid="players-card"><div className="card-body">
        {players.map((p) => (
          <div key={p.id} className="player-row" data-player={p.username}>
            <div className="player-id">
              <span className={`player-avatar ${p.online ? 'online' : ''}`} data-tip={p.online ? 'On now' : 'Not signed in now'}>{(p.displayName || p.username).slice(0, 1)}</span>
              <div className="grow">
                <input className="input bare player-name" defaultValue={p.displayName} key={p.displayName} aria-label={`Display name of ${p.username}`}
                  onBlur={(e) => void rename(p, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                <div className="faint player-user">@{p.username}{p.online && <span className="tone-good"> · on now</span>}</div>
              </div>
              <button className="btn ghost sm" onClick={() => setReset(p)}><KeyRound size={13} /> Reset password</button>
              <button className="btn ghost sm danger" onClick={() => setRemoving(p)} aria-label={`Remove ${p.username}`}><Trash2 size={13} /> Remove</button>
            </div>
            <CampaignChips campaigns={campaigns} chosen={p.campaignIds}
              onToggle={(id) => void setCampaigns(p, p.campaignIds.includes(id) ? p.campaignIds.filter((x) => x !== id) : [...p.campaignIds, id])} />
          </div>
        ))}
        {q.data && !players.length && <div className="faint" style={{ padding: '6px 0' }}>No players yet. Add one, choose their campaigns, and pass on their password.</div>}
        {q.isError && <div className="error-text">Couldn’t load the players.</div>}
      </div></div>

      <AddPlayer open={adding} campaigns={campaigns} onClose={() => setAdding(false)}
        onAdded={(p, password) => { refresh(); setAdding(false); if (password) setShown({ name: p.displayName || p.username, username: p.username, password }); else toast(`${p.displayName || p.username} added`); }} />
      <ResetPassword player={reset} onClose={() => setReset(null)}
        onDone={(p, password) => { setReset(null); if (password) setShown({ name: p.displayName || p.username, username: p.username, password }); else toast('Password changed; they’ve been signed out'); }} />
      <PasswordReveal shown={shown} onClose={() => setShown(null)} />
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.displayName || removing?.username}?`}>
        <p className="muted" style={{ marginTop: 0 }}>Their account goes, and any screen they have open signs out now. What they wrote (party notes, wiki pages) stays.</p>
        <div className="actions">
          <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
          <button className="btn danger-solid" onClick={() => { const p = removing!; setRemoving(null); void remove(p); }}>Remove player</button>
        </div>
      </Dialog>
    </>
  );
}

function PasswordChoice({ generate, setGenerate, password, setPassword }: {
  generate: boolean; setGenerate: (v: boolean) => void; password: string; setPassword: (v: string) => void;
}) {
  return (
    <div className="field">
      <label className="label">Password</label>
      <div className="seg pw-seg" role="radiogroup" aria-label="Password">
        <button type="button" role="radio" aria-checked={generate} className={generate ? 'on' : ''} onClick={() => setGenerate(true)}>Generate one</button>
        <button type="button" role="radio" aria-checked={!generate} className={!generate ? 'on' : ''} onClick={() => setGenerate(false)}>Set one</button>
      </div>
      {generate
        ? <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>An easy-to-read password is made and shown to you once, to pass on.</div>
        : <input className="input" style={{ marginTop: 8 }} type="text" autoComplete="off" placeholder="At least 10 characters" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="New password" />}
    </div>
  );
}

function AddPlayer({ open, campaigns, onClose, onAdded }: {
  open: boolean; campaigns: CampaignChoice[]; onClose: () => void; onAdded: (p: Player, password?: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ok = displayName.trim() && username.trim().length >= 2 && (generate || password.length >= 10);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api<{ player: Player; password?: string }>('/api/players', {
        body: { displayName: displayName.trim(), username: username.trim(), ...(generate ? {} : { password }), campaignIds: chosen },
      });
      setDisplayName(''); setUsername(''); setPassword(''); setChosen([]); setGenerate(true);
      onAdded(res.player, res.password);
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a player">
      <form onSubmit={submit}>
        <div className="field"><label className="label" htmlFor="np-name">Display name</label>
          <input id="np-name" className="input" autoFocus value={displayName} placeholder="Mira" onChange={(e) => setDisplayName(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="np-user">Username</label>
          <input id="np-user" className="input" value={username} placeholder="mira" autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} /></div>
        <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        <div className="field"><label className="label">Campaigns</label>
          <CampaignChips campaigns={campaigns} chosen={chosen} onToggle={(id) => setChosen((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))} /></div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy}><Plus size={14} /> Add player</button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPassword({ player, onClose, onDone }: { player: Player | null; onClose: () => void; onDone: (p: Player, password?: string) => void }) {
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!player || (!generate && password.length < 10)) return;
    setBusy(true);
    try {
      const res = await api<{ password?: string }>(`/api/players/${player.id}/password`, { body: generate ? {} : { password } });
      setPassword(''); setGenerate(true);
      onDone(player, res.password);
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!player} onClose={onClose} title={`New password for ${player?.displayName || player?.username || ''}`}>
      <form onSubmit={submit}>
        <p className="muted" style={{ marginTop: 0 }}>Their old password stops working and any screen they have open signs out.</p>
        <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (!generate && password.length < 10)}><KeyRound size={14} /> Set password</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Everyone's own account: the name others see them by and, for players, their password. */
export function AccountCard({ heading = true }: { heading?: boolean }) {
  const me = useMe();
  if (!me) return null;
  return <AccountForm key={me.id} me={me} heading={heading} />;
}

function AccountForm({ me, heading }: { me: Me; heading: boolean }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const row = await api<{ displayName: string; name: string }>('/api/account', { method: 'PATCH', body: { displayName: displayName.trim() } });
      qc.setQueryData<Me>(qk.me, (m) => m && { ...m, displayName: row.displayName, name: row.name });
      toast('Name saved');
    } catch (err) { toastError(err); }
  };
  const mismatch = !!again && next !== again;
  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || next.length < 10 || mismatch) return;
    setBusy(true);
    try {
      await api('/api/account/password', { body: { current, password: next } });
      setCurrent(''); setNext(''); setAgain('');
      toast('Password changed. Your other devices have been signed out.');
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return (
    <>
      {heading && <h3 className="display" style={{ margin: '28px 0 6px' }}>Your account</h3>}
      <p className="muted" style={{ marginTop: heading ? 0 : 4 }}>Signed in as <b>{me.username}</b>{me.role === 'gm' ? ', the GM' : ', a player'}.</p>
      <div className="card"><div className="card-body">
        <form className="row" onSubmit={saveName} style={{ alignItems: 'flex-end', gap: 10 }}>
          <div className="grow"><label className="label" htmlFor="acct-name">Display name</label>
            <input id="acct-name" className="input" value={displayName} placeholder={me.username} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} /></div>
          <button className="btn" disabled={displayName.trim() === me.displayName}><Check size={14} /> Save</button>
        </form>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Shown to others who have the same world open.</div>
      </div></div>
      {me.role === 'player' ? (
        <div className="card" style={{ marginTop: 12 }}><div className="card-body">
          <form onSubmit={savePassword} className="acct-pw">
            <div className="field"><label className="label" htmlFor="pw-cur">Current password</label>
              <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div className="field grow"><label className="label" htmlFor="pw-new">New password</label>
                <input id="pw-new" className="input" type="password" autoComplete="new-password" placeholder="At least 10 characters" value={next} onChange={(e) => setNext(e.target.value)} /></div>
              <div className="field grow"><label className="label" htmlFor="pw-again">Again</label>
                <input id="pw-again" className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
            </div>
            {mismatch && <div className="error-text" style={{ marginBottom: 10 }}>The two new passwords differ.</div>}
            <button className="btn primary" disabled={busy || !current || next.length < 10 || next !== again}><KeyRound size={14} /> Change password</button>
          </form>
        </div></div>
      ) : (
        <p className="faint" style={{ fontSize: 12, margin: '8px 2px 0' }}>The GM’s password is the server’s ADMIN_PASSWORD: change it where the app is deployed.</p>
      )}
    </>
  );
}
