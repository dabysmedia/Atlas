/** Hex math shared by server (seeding) and client (rendering). Axial coordinates (q, r). */
export type Orientation = 'flat' | 'pointy';
export type Axial = { q: number; r: number };

export const SQRT3 = Math.sqrt(3);

/** Rectangular map cells in offset space, converted to axial. flat = odd-q, pointy = odd-r. */
export function offsetToAxial(col: number, row: number, o: Orientation): Axial {
  if (o === 'flat') return { q: col, r: row - (col - (col & 1)) / 2 };
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(q: number, r: number, o: Orientation): { col: number; row: number } {
  if (o === 'flat') return { col: q, row: r + (q - (q & 1)) / 2 };
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function rectangle(cols: number, rows: number, o: Orientation): Axial[] {
  const out: Axial[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) out.push(offsetToAxial(col, row, o));
  return out;
}

/** Hex center in world pixels for a hex of circumradius `size`. */
export function hexToPixel(q: number, r: number, size: number, o: Orientation): { x: number; y: number } {
  if (o === 'flat') return { x: size * 1.5 * q, y: size * SQRT3 * (r + q / 2) };
  return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
}

export function pixelToHex(x: number, y: number, size: number, o: Orientation): Axial {
  let qf: number, rf: number;
  if (o === 'flat') {
    qf = ((2 / 3) * x) / size;
    rf = ((-1 / 3) * x + (SQRT3 / 3) * y) / size;
  } else {
    qf = ((SQRT3 / 3) * x - (1 / 3) * y) / size;
    rf = ((2 / 3) * y) / size;
  }
  return roundAxial(qf, rf);
}

export function roundAxial(qf: number, rf: number): Axial {
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** Corner i (0..5) offset from center. */
export function corner(i: number, size: number, o: Orientation): { x: number; y: number } {
  const deg = o === 'flat' ? 60 * i : 60 * i - 30;
  const a = (Math.PI / 180) * deg;
  return { x: size * Math.cos(a), y: size * Math.sin(a) };
}

/**
 * Neighbor directions, ordered so that direction d shares the edge between
 * corner d and corner d+1 (for the matching orientation).
 */
export const DIRS: Record<Orientation, Axial[]> = {
  flat: [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }],
  pointy: [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }],
};

export const key = (q: number, r: number) => `${q},${r}`;

export function distance(a: Axial, b: Axial): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/** Hexcrawl-style label: 1-based column then row, zero-padded ("0412"). */
export function hexLabel(q: number, r: number, o: Orientation): string {
  const { col, row } = axialToOffset(q, r, o);
  const pad = (n: number) => String(n + 1).padStart(2, '0');
  return `${pad(col)}${pad(row)}`;
}
