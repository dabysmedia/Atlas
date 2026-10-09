import { Anchor, BookOpen, Castle, Crown, Eye, Feather, Flame, Leaf, Moon, Shield, Skull, Sparkle, Sun, type LucideIcon } from 'lucide-react';
import { Diamond } from '../map/panels';

/** A small set of emblems a GM can give a faction; none means the plain diamond. */
export const SIGILS: Record<string, { label: string; icon: LucideIcon }> = {
  sun: { label: 'Sun', icon: Sun },
  castle: { label: 'Fortress', icon: Castle },
  book: { label: 'Book', icon: BookOpen },
  star: { label: 'Star', icon: Sparkle },
  moon: { label: 'Crescent', icon: Moon },
  flame: { label: 'Flame', icon: Flame },
  eye: { label: 'Eye', icon: Eye },
  leaf: { label: 'Leaf', icon: Leaf },
  feather: { label: 'Feather', icon: Feather },
  crown: { label: 'Crown', icon: Crown },
  shield: { label: 'Shield', icon: Shield },
  anchor: { label: 'Anchor', icon: Anchor },
  skull: { label: 'Skull', icon: Skull },
};

export function FactionSigil({ sigil, color, size = 34 }: { sigil: string | null | undefined; color: string; size?: number }) {
  const s = sigil ? SIGILS[sigil] : undefined;
  if (!s) return <Diamond color={color} size={Math.round(size * 0.53)} />;
  const Icon = s.icon;
  return (
    <span className="sigil-badge" style={{ width: size, height: size, borderColor: color, background: `color-mix(in srgb, ${color} 22%, transparent)` }}>
      <Icon size={Math.round(size * 0.5)} color={color} strokeWidth={1.8} style={{ filter: 'brightness(1.5)' }} />
    </span>
  );
}
