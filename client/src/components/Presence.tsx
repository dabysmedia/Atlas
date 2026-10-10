import { AnimatePresence, motion, type HTMLMotionProps } from 'motion/react';
import { useLive, type Viewer } from '../live';

const MAX_SHOWN = 4;

/** A steady hue per screen, so the same visitor keeps their color while they stay. */
const hue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/**
 * Who else has this world open, as small glass avatars (one per screen), and whether this screen is live. Quiet
 * when all is well: a green dot. While the link is being restored the dot pulses amber and the avatars dim, and the
 * tip says so; nothing changes width, so the bar never shifts.
 */
export function Presence(motionProps: HTMLMotionProps<'div'>) {
  const { status, viewers, me } = useLive();
  const shown = viewers.slice(0, MAX_SHOWN);
  const more = viewers.length - shown.length;
  const who = (v: Viewer) => `${v.name}${v.role === 'player' ? ' (player)' : ' (GM)'}${v.conn === me ? ' (this screen)' : ''}`;
  const tip = status === 'live'
    ? `Live · ${viewers.length === 1 ? 'only you are here' : `viewing now: ${viewers.map(who).join(', ')}`}`
    : status === 'reconnecting' ? 'Connection lost · reconnecting, changes from others will catch up' : 'Connecting…';
  return (
    <motion.div className={`presence glass ${status}`} role="status" aria-label={tip} data-tip={tip} data-status={status} data-count={viewers.length} {...motionProps}>
      <span className="live-dot" aria-hidden />
      <span className="avatars" aria-hidden>
        <AnimatePresence initial={false}>
          {shown.map((v) => (
            <motion.span key={v.conn} className={`avatar ${v.conn === me ? 'me' : ''} ${v.role}`} data-role={v.role} style={{ ['--hue' as string]: hue(v.conn) }}
              initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 420, damping: 28 }}>
              {v.name.slice(0, 1) || '?'}
              {v.role === 'player' && <span className="role-badge">P</span>}
            </motion.span>
          ))}
        </AnimatePresence>
        {more > 0 && <span className="avatar more">+{more}</span>}
      </span>
      {viewers.length > 0 && <span className="pres-n" aria-hidden>{viewers.length}</span>}
    </motion.div>
  );
}
