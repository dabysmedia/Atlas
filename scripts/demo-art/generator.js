// Paints the demo world's map art: a continuous, hill-shaded landscape that the hex
// grid sits on top of. Runs in a browser page (see scripts/bake-demo-art.mjs) and
// also classifies every hex from the painting, so the seeded terrain matches the art.
/* eslint-disable */
(function () {
  // ---------------------------------------------------------------- noise
  function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function simplex(seed) {
    const rnd = mulberry(seed);
    const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    const perm = new Uint8Array(512); for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    return (x, y) => {
      const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
      const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
      const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n = 0, tt;
      tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { const g = perm[ii + perm[jj]] & 7; tt *= tt; n += tt * tt * (gx[g] * x0 + gy[g] * y0); }
      tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; tt *= tt; n += tt * tt * (gx[g] * x1 + gy[g] * y1); }
      tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; tt *= tt; n += tt * tt * (gx[g] * x2 + gy[g] * y2); }
      return 70 * n; // ~[-1, 1]
    };
  }
  const fbmOf = (n) => (x, y, oct, lac = 2, gain = 0.5) => { let a = 1, f = 1, s = 0, norm = 0; for (let o = 0; o < oct; o++) { s += a * n(x * f, y * f); norm += a; a *= gain; f *= lac; } return s / norm; };
  const ridgeOf = (n) => (x, y, oct) => { let a = 1, f = 1, s = 0, norm = 0, w = 1; for (let o = 0; o < oct; o++) { let v = 1 - Math.abs(n(x * f, y * f)); v *= v; v *= w; w = Math.min(1, v * 1.6); s += a * v; norm += a; a *= 0.5; f *= 2.05; } return s / norm; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const mixc = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

  const C = {
    abyss: hex('#071723'), deep: hex('#0c2638'), mid: hex('#123a4c'), shallow: hex('#23626c'), reef: hex('#3d8a86'), foam: hex('#a9d2c8'),
    sand: hex('#b7a676'), plainsDry: hex('#9a9152'), plains: hex('#788f43'), meadow: hex('#55893d'),
    forest: hex('#2f6a30'), forestDark: hex('#1a4420'), jungle: hex('#1d6034'),
    swamp: hex('#46553a'), swampWater: hex('#2f4a46'),
    hills: hex('#7f7548'), hillsDry: hex('#8c7a52'),
    rock: hex('#86705c'), rockDark: hex('#54463b'), snow: hex('#e8ecea'),
    desert: hex('#c7a466'), dune: hex('#dcbd7f'),
    ash: hex('#2c2827'), ashLight: hex('#4a403a'), ember: hex('#ff6a2a'),
    tundra: hex('#a9b5b1'),
  };

  window.paintAtlas = function paintAtlas(opt) {
    const { cols, rows, size, margin, ppu, seed } = opt;
    const SQ3 = Math.sqrt(3);
    const minX = -size - margin, minY = -size * SQ3 / 2 - margin;
    const maxX = size * 1.5 * (cols - 1) + size + margin;
    const maxY = size * SQ3 * (rows - 1) + size * SQ3 + margin;
    const W = Math.round((maxX - minX) * ppu), H = Math.round((maxY - minY) * ppu);
    const n1 = simplex(seed), n2 = simplex(seed + 1), n3 = simplex(seed + 2), n4 = simplex(seed + 3), n5 = simplex(seed + 4), n6 = simplex(seed + 5);
    const fbm1 = fbmOf(n1), fbm2 = fbmOf(n2), fbm3 = fbmOf(n3), fbm5 = fbmOf(n5), ridge4 = ridgeOf(n4), ridge6 = ridgeOf(n6);

    // Hand-placed geography over noise: a main continent with a mountain spine in the
    // north, a western harbor bay, ashen moors and a fire mountain in the east, a
    // forested south breaking into an archipelago.
    const blobs = [
      [0.47, 0.42, 0.36, 0.30, 1.0], [0.30, 0.62, 0.20, 0.22, 0.85], [0.66, 0.66, 0.22, 0.20, 0.9],
      [0.24, 0.30, 0.16, 0.18, 0.8], [0.74, 0.38, 0.18, 0.20, 0.9], [0.52, 0.80, 0.18, 0.12, 0.7],
      [0.83, 0.84, 0.07, 0.06, 0.55], [0.73, 0.92, 0.06, 0.05, 0.5], [0.91, 0.72, 0.05, 0.05, 0.5], [0.12, 0.84, 0.06, 0.05, 0.45],
    ];
    const bays = [[0.10, 0.55, 0.11, 0.08, 0.9], [0.40, 0.95, 0.10, 0.09, 0.6], [0.60, 0.08, 0.10, 0.06, 0.5]];
    const ell = (u, v, b) => { const dx = (u - b[0]) / b[2], dy = (v - b[1]) / b[3]; return Math.exp(-(dx * dx + dy * dy) * 1.4) * b[4]; };
    const volcano = [0.78, 0.30];

    // Fields sampled in normalized map space (u, v in 0..1 across the art).
    function field(u, v) {
      const wx = fbm2(u * 3, v * 3, 4) * 0.07, wy = fbm2(u * 3 + 9, v * 3 - 4, 4) * 0.07;
      const uu = u + wx, vv = v + wy;
      let mask = 0; for (const b of blobs) mask = Math.max(mask, ell(uu, vv, b));
      for (const b of bays) mask -= ell(uu, vv, b);
      const base = fbm1(uu * 5, vv * 5, 4) * 0.27 + fbm1(u * 24 + 40, v * 20, 3) * 0.05;
      let h = mask * 0.9 + base - 0.45;
      // Mountain spine: ridged noise along a bending north-south line.
      const sx = uu - (0.50 + 0.06 * Math.sin(vv * 7.5) - 0.12 * vv);
      const spine = Math.exp(-(sx * sx) / 0.0035) * smooth(0.72, 0.18, vv) * smooth(0.0, 0.08, vv);
      const r = ridge4(uu * 7, vv * 7, 6);
      h += spine * (0.06 + r * r * 0.62) * clamp(mask * 1.4, 0, 1);
      // Eastern highland moors and a fire mountain.
      const ed = Math.hypot((uu - volcano[0]) / 1.0, (vv - volcano[1]) / 1.2);
      const cone = Math.exp(-(ed * ed) / 0.0018);
      h += cone * 0.55 - Math.exp(-(ed * ed) / 0.00012) * 0.18;
      const moor = Math.exp(-(Math.pow((uu - 0.78) / 0.10, 2) + Math.pow((vv - 0.34) / 0.12, 2)));
      h += moor * 0.05 * clamp(mask * 2, 0, 1) + moor * r * 0.06;
      // Moisture: wet west and south, dry south-west pocket, dry east.
      let m = fbm3(uu * 4 + 20, vv * 4, 5) * 0.35 + 0.62 + (0.45 - uu) * 0.45 + (vv - 0.45) * 0.35;
      m -= Math.exp(-(Math.pow((uu - 0.36) / 0.10, 2) + Math.pow((vv - 0.64) / 0.09, 2))) * 0.75;
      const ash = clamp(moor * 1.15 + cone * 0.6, 0, 1);
      return { h, m, ash, spine };
    }

    // ---- pass 1: height, moisture, ash at pixel resolution
    const N = W * H;
    const Hf = new Float32Array(N), Mf = new Float32Array(N), Af = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W, i = y * W + x;
        const f = field(u, v);
        // Micro relief in world units so it stays isotropic: canopy clumps, crags, grass grain.
        const wx = x / ppu, wy = y / ppu;
        let d = 0;
        if (f.h > 0) {
          const b = biome(f.h, f.m, f.ash, v, u);
          if (b === 'forest' || b === 'jungle' || b === 'swamp') d = Math.max(0, n5(wx / 5.5, wy / 5.5)) * 0.010 + n6(wx / 2.2, wy / 2.2) * 0.002;
          else if (b === 'mountains' || b === 'tundra' || b === 'wasteland') d = ridge4(wx / 75, wy / 75, 5) * 0.11 + ridge6(wx / 18, wy / 18, 2) * 0.012;
          else if (b === 'hills') d = ridge4(wx / 40, wy / 40, 2) * 0.02 + n6(wx / 3, wy / 3) * 0.002;
          else d = n6(wx / 3, wy / 3) * 0.0015;
        }
        Hf[i] = f.h + d;
        Mf[i] = f.m; Af[i] = f.ash;
      }
    }

    // ---- biome classification shared by painting and hex terrain
    // returns terrain key for a sample
    function biome(h, m, ash, v, u) {
      if (h < -0.16) return 'deep';
      if (h < 0) return 'water';
      if (h > 0.33 && ash > 0.5) return 'wasteland';
      if (h > 0.56) return 'tundra';
      if (h > 0.33) return 'mountains';
      if (ash > 0.62) return 'wasteland';
      if (h > 0.21) return 'hills';
      if (m < 0.22) return 'desert';
      if (m > 0.95 && h < 0.07) return 'swamp';
      if (m > 0.82 && v < 0.45 && u < 0.40) return 'jungle';
      if (m > 0.62) return 'forest';
      return 'plains';
    }

    // ---- pass 2: color with hill shading
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const px = img.data;
    const L = (() => { const l = [-0.62, -0.68, 0.9]; const n = Math.hypot(...l); return l.map((x) => x / n); })();
    const exag = 700 * ppu / 2; // height → relief scale
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, u = x / W;
        const h = Hf[i], m = Mf[i], ash = Af[i];
        let c;
        if (h < 0) {
          // Water: depth gradient, reef glow and foam at the shore, faint swell.
          const d = -h;
          c = d > 0.28 ? mixc(C.deep, C.abyss, smooth(0.28, 0.6, d)) : d > 0.09 ? mixc(C.mid, C.deep, smooth(0.09, 0.28, d)) : mixc(C.reef, C.mid, smooth(0.0, 0.09, d));
          c = mixc(c, C.shallow, (1 - smooth(0, 0.05, d)) * 0.35);
          const swell = n2(u * 90, v * 140) * 0.5 + n3(u * 300, v * 300) * 0.5;
          c = mixc(c, C.foam, Math.max(0, swell - 0.55) * 0.12 * (1 - smooth(0, 0.3, d)));
          if (d < 0.012) c = mixc(c, C.foam, (1 - d / 0.012) * 0.55);
          px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
          continue;
        }
        const b = biome(h, m, ash, v, u);
        const g = fbm3(u * 40, v * 40, 3) * 0.5 + 0.5; // patchiness
        switch (b) {
          case 'plains': c = mixc(mixc(C.plainsDry, C.plains, smooth(0.25, 0.6, m)), C.meadow, smooth(0.45, 0.7, m) * g); break;
          case 'forest': c = mixc(C.forest, C.forestDark, g * 0.8); break;
          case 'jungle': c = mixc(C.jungle, C.forestDark, g * 0.6); break;
          case 'swamp': c = mixc(C.swamp, C.swampWater, smooth(0.45, 0.7, fbm5(u * 60, v * 60, 3) * 0.5 + 0.5)); break;
          case 'hills': c = mixc(C.hills, C.hillsDry, g); c = mixc(c, C.plains, smooth(0.6, 0.9, m) * 0.4); break;
          case 'mountains': c = mixc(C.rock, C.rockDark, smooth(0.2, 0.8, g)); break;
          case 'tundra': c = mixc(C.rock, C.snow, smooth(0.55, 0.68, h + g * 0.08)); break;
          case 'desert': c = mixc(C.desert, C.dune, smooth(0.3, 0.7, n1(u * 70, v * 30) * 0.5 + 0.5)); break;
          case 'wasteland': c = mixc(C.ash, C.ashLight, g * 0.7); break;
        }
        // Soft transitions: blend toward the neighbor biome palette using moisture/ash gradients.
        if (b === 'plains' || b === 'hills') c = mixc(c, C.forest, smooth(0.56, 0.66, m) * 0.6);
        if (b !== 'wasteland') c = mixc(c, C.ash, smooth(0.35, 0.6, ash) * 0.55);
        if (h < 0.012) c = mixc(c, C.sand, (1 - h / 0.012) * 0.8);
        // Hill shade from the height gradient.
        const hx = Hf[i + (x < W - 1 ? 1 : 0)] - Hf[i - (x > 0 ? 1 : 0)];
        const hy = Hf[i + (y < H - 1 ? W : 0)] - Hf[i - (y > 0 ? W : 0)];
        let nx = -hx * exag, ny = -hy * exag, nz = 1; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const lam = nx * L[0] + ny * L[1] + nz * L[2];
        const shade = 0.36 + 0.72 * clamp(lam, 0, 1.2);
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
        // Ember fissures across the ash moors.
        if (ash > 0.4) {
          const crack = ridge6(u * 26, v * 26, 3);
          const e = smooth(0.80, 0.95, crack) * smooth(0.4, 0.75, ash);
          if (e > 0) c = mixc(c, C.ember, Math.min(1, e * 1.1));
        }
        px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // ---- rivers: steepest descent from springs high on the spine
    const step = 3;
    const hAt = (x, y) => field(x / W, y / H).h; // smooth terrain, without canopy bumps
    const rnd = mulberry(seed + 99);
    const rivers = [];
    for (let k = 0; k < 400 && rivers.length < 9; k++) {
      const x0 = rnd() * W, y0 = rnd() * H;
      const h0 = hAt(x0, y0);
      if (h0 < 0.16 || h0 > 0.36) continue;
      const pts = [[x0, y0]];
      let x = x0, y = y0, ok = false;
      // Greedy descent over unvisited cells: in a basin it climbs the lowest rim, like a filling lake.
      const cell = step * ppu, seen = new Set();
      const ck = (x, y) => Math.round(x / cell) + ',' + Math.round(y / cell);
      seen.add(ck(x, y));
      for (let s = 0; s < 3000; s++) {
        let best = null, bh = Infinity;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2, nx = x + Math.cos(ang) * cell, ny = y + Math.sin(ang) * cell;
          if (seen.has(ck(nx, ny))) continue;
          const hh = hAt(nx, ny);
          if (hh < bh) { bh = hh; best = [nx, ny]; }
        }
        if (!best) break;
        [x, y] = best; pts.push(best); seen.add(ck(x, y));
        if (bh < 0) { ok = true; break; }
        if (x < 0 || y < 0 || x >= W || y >= H) break;
      }
      if (!ok || pts.length < 40) continue;
      if (rivers.some((r) => Math.hypot(r[0][0] - x0, r[0][1] - y0) < W * 0.08)) continue;
      rivers.push(pts);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const pts of rivers) {
      // Chaikin smoothing for a natural line.
      let p = pts;
      for (let it = 0; it < 3; it++) { const q = [p[0]]; for (let j = 0; j < p.length - 1; j++) { const a = p[j], b = p[j + 1]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); } q.push(p[p.length - 1]); p = q; }
      for (let j = 1; j < p.length; j++) {
        const t = j / p.length;
        const w = (0.8 + t * 4) * ppu;
        ctx.strokeStyle = 'rgba(14,32,34,0.55)'; ctx.lineWidth = w + 1.6 * ppu;
        ctx.beginPath(); ctx.moveTo(p[j - 1][0], p[j - 1][1]); ctx.lineTo(p[j][0], p[j][1]); ctx.stroke();
      }
      for (let j = 1; j < p.length; j++) {
        const t = j / p.length;
        ctx.strokeStyle = `rgba(${mix(70, 58, t)},${mix(140, 120, t)},${mix(146, 130, t)},0.95)`; ctx.lineWidth = (0.8 + t * 4) * ppu;
        ctx.beginPath(); ctx.moveTo(p[j - 1][0], p[j - 1][1]); ctx.lineTo(p[j][0], p[j][1]); ctx.stroke();
      }
    }

    // ---- lava glow around the fire mountain's crater
    const vx = volcano[0] * W, vy = volcano[1] * H;
    let gr = ctx.createRadialGradient(vx, vy, 0, vx, vy, 34 * ppu);
    gr.addColorStop(0, 'rgba(255,140,60,0.85)'); gr.addColorStop(0.25, 'rgba(255,90,30,0.45)'); gr.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = gr; ctx.fillRect(vx - 60 * ppu, vy - 60 * ppu, 120 * ppu, 120 * ppu);
    ctx.globalCompositeOperation = 'source-over';

    // ---- atmosphere: cool vignette and a faint grain
    gr = ctx.createRadialGradient(W * 0.5, H * 0.48, Math.min(W, H) * 0.35, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    gr.addColorStop(0, 'rgba(4,10,16,0)'); gr.addColorStop(1, 'rgba(4,10,16,0.55)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

    // ---- hex terrain from the painting: majority vote over points inside each hex
    const terrain = [];
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const q = col, r = row - (col - (col & 1)) / 2;
      const cx = size * 1.5 * q, cy = size * SQ3 * (r + q / 2);
      const votes = {};
      let land = 0, total = 0, hsum = 0;
      for (let a = -3; a <= 3; a++) for (let bb = -3; bb <= 3; bb++) {
        const sx = cx + a * size * 0.24, sy = cy + bb * size * 0.24;
        if (Math.hypot(sx - cx, sy - cy) > size * 0.8) continue;
        const ix = clamp(Math.round((sx - minX) * ppu), 0, W - 1), iy = clamp(Math.round((sy - minY) * ppu), 0, H - 1);
        const i = iy * W + ix, h = Hf[i];
        const t = biome(h, Mf[i], Af[i], iy / H, ix / W);
        votes[t] = (votes[t] ?? 0) + 1; total++; hsum += h;
        if (h >= 0) land++;
      }
      let t;
      if (land / total < 0.5) t = hsum / total < -0.16 ? 'deep' : 'water';
      else { delete votes.water; delete votes.deep; t = Object.entries(votes).sort((x, y) => y[1] - x[1])[0][0]; }
      terrain.push({ col, row, q, r, terrain: t });
    }
    return { url: cv.toDataURL('image/webp', 0.84), width: W, height: H, rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, terrain, rivers: rivers.length };
  };
})();
