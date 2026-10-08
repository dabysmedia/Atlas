/** A small hex emblem tinted with the world's accent color. */
export function Sigil({ color, size = 30 }: { color: string; size?: number }) {
  return (
    <svg className="world-sigil" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2l12 7v14l-12 7-12-7V9z" fill={color} opacity="0.18" />
      <path d="M16 2l12 7v14l-12 7-12-7V9z" fill="none" stroke={color} strokeWidth="1.6" />
      <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill={color} />
    </svg>
  );
}
