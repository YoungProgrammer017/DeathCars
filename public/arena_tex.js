// arena_tex.js — the colosseum's textures, painted on canvases at load time (nothing to download).
import { makeNoise } from './arena_geo.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const N1 = makeNoise(7), N2 = makeNoise(23), N3 = makeNoise(91);

// ------------------------------------------------------------------------------------------------ floor
// World half-size covered by the floor maps (the arena wall is at 104 m)
export const FLOOR_S = 108;
const COL = {
  marble: '#e9e0d0', marble2: '#ddd3c1', grey: '#9a948c', greyDark: '#6c6760', black: '#2b2724',
  red: '#7e2620', red2: '#94322a', gold: '#d6a03c', goldHi: '#f2cf78', goldLo: '#9b6a1f', sand: '#d2b688',
};
// roughness (G) / metalness (B) of the same materials
const ORM = {
  marble: 'rgb(0,40,0)', marble2: 'rgb(0,46,0)', grey: 'rgb(0,52,0)', greyDark: 'rgb(0,52,0)', black: 'rgb(0,40,0)',
  red: 'rgb(0,52,0)', red2: 'rgb(0,52,0)', gold: 'rgb(0,105,170)', goldHi: 'rgb(0,100,170)', goldLo: 'rgb(0,115,170)', sand: 'rgb(0,225,0)',
};

// classic Greek key, one period in a unit band (s along, t across)
const KEY = [[0.1, 0.0], [0.1, 0.82], [0.82, 0.82], [0.82, 0.24], [0.36, 0.24], [0.36, 0.56], [0.6, 0.56]];

function meander(g, map, len, width, P) {
  const n = Math.max(1, Math.round(len / width));
  const per = len / n;
  g.strokeStyle = P.gold; g.lineWidth = width * 0.11; g.lineJoin = 'miter'; g.lineCap = 'square';
  g.beginPath();
  for (let k = 0; k < n; k++) {
    KEY.forEach(([s, t], j) => {
      // densify for curved bands
      const [x, y] = map((k + s) * per, t * width * 0.86 + width * 0.07);
      if (j === 0) g.moveTo(x, y); else {
        const [ps, pt] = KEY[j - 1];
        for (let q = 1; q <= 4; q++) {
          const ss = ps + (s - ps) * q / 4, tt = pt + (t - pt) * q / 4;
          const [xx, yy] = map((k + ss) * per, tt * width * 0.86 + width * 0.07);
          g.lineTo(xx, yy);
        }
      }
    });
  }
  g.stroke();
  // the band's edge lines
  g.lineWidth = width * 0.06;
  for (const t of [0.02, 0.98]) {
    g.beginPath();
    for (let q = 0; q <= n * 8; q++) { const [x, y] = map(q / 8 * per, t * width); if (q === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
  }
}
const ringMap = (r0, r1) => (s, t) => { const r = r0 + t, a = s / ((r0 + r1) / 2); return [Math.sin(a) * r, Math.cos(a) * r]; };

function ring(g, r, w, style) {
  g.strokeStyle = style; g.lineWidth = w;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
}
function annulus(g, r0, r1, style) {
  g.fillStyle = style; g.beginPath(); g.arc(0, 0, r1, 0, Math.PI * 2); g.arc(0, 0, r0, 0, Math.PI * 2, true); g.fill();
}

function leaf(g, x, y, ang, len, P) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.beginPath(); g.ellipse(len / 2, 0, len / 2, len * 0.2, 0, 0, Math.PI * 2);
  g.fillStyle = P.gold; g.fill();
  g.lineWidth = len * 0.06; g.strokeStyle = P.goldLo; g.stroke();
  g.beginPath(); g.moveTo(len * 0.1, 0); g.lineTo(len * 0.85, 0); g.strokeStyle = P.goldHi; g.lineWidth = len * 0.04; g.stroke();
  g.restore();
}
// laurel wreath: two branches meeting at the top, ribbon at the bottom
export function wreath(g, cx, cy, R, P) {
  const L = R * 0.36;
  g.lineWidth = R * 0.045; g.strokeStyle = P.goldLo;
  for (const side of [-1, 1]) {
    g.beginPath(); g.arc(cx, cy, R, Math.PI / 2 + side * 0.25, Math.PI / 2 + side * 2.75, side < 0); g.stroke();
    for (let k = 0; k < 13; k++) {
      const a = Math.PI / 2 + side * (0.35 + k * 0.19);
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      const tang = a + side * Math.PI / 2;
      leaf(g, x, y, tang + side * 0.5 - Math.PI, L, P);    // outer leaf
      leaf(g, x, y, tang - side * 0.5 - Math.PI, L * 0.85, P);   // inner leaf
    }
  }
  // ribbon
  g.fillStyle = P.gold;
  g.beginPath(); g.ellipse(cx - R * 0.16, cy + R * 1.02, R * 0.16, R * 0.08, 0.4, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(cx + R * 0.16, cy + R * 1.02, R * 0.16, R * 0.08, -0.4, 0, Math.PI * 2); g.fill();
  g.lineWidth = R * 0.07; g.strokeStyle = P.gold;
  g.beginPath(); g.moveTo(cx, cy + R * 1.02); g.quadraticCurveTo(cx - R * 0.1, cy + R * 1.3, cx - R * 0.3, cy + R * 1.45); g.stroke();
  g.beginPath(); g.moveTo(cx, cy + R * 1.02); g.quadraticCurveTo(cx + R * 0.1, cy + R * 1.3, cx + R * 0.3, cy + R * 1.45); g.stroke();
}

// golden scroll ornament (four mirrored S-scrolls with leaves and a rosette), fits a square of size `s`
function scrolls(g, cx, cy, s, rot, P) {
  g.save(); g.translate(cx, cy); g.rotate(rot);
  const w = s * 0.022;
  for (const [mx, my] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    g.save(); g.scale(mx, my);
    // main S curve from the centre outwards, ending in a spiral
    g.beginPath(); g.moveTo(s * 0.04, s * 0.02);
    g.bezierCurveTo(s * 0.18, s * 0.2, s * 0.05, s * 0.32, s * 0.2, s * 0.38);
    g.bezierCurveTo(s * 0.32, s * 0.42, s * 0.42, s * 0.3, s * 0.36, s * 0.22);
    let a = 0, r = s * 0.07;
    const ox = s * 0.3, oy = s * 0.25;
    for (let k = 0; k < 40; k++) { a += 0.2; r *= 0.965; g.lineTo(ox + Math.cos(a + 0.6) * r, oy + Math.sin(a + 0.6) * r); }
    g.strokeStyle = P.goldLo; g.lineWidth = w * 1.5; g.stroke();
    g.strokeStyle = P.gold; g.lineWidth = w; g.stroke();
    // a smaller curl to the side
    g.beginPath(); g.moveTo(s * 0.12, s * 0.22);
    g.bezierCurveTo(s * 0.02, s * 0.3, s * 0.04, s * 0.44, s * 0.13, s * 0.45);
    a = 0; r = s * 0.04;
    for (let k = 0; k < 30; k++) { a -= 0.22; r *= 0.96; g.lineTo(s * 0.11 + Math.cos(a) * r, s * 0.41 + Math.sin(a) * r); }
    g.strokeStyle = P.gold; g.lineWidth = w * 0.8; g.stroke();
    for (let k = 0; k < 4; k++) leaf(g, s * (0.14 + k * 0.05), s * (0.3 + k * 0.025), -0.9 + k * 0.4, s * 0.07, P);
    g.restore();
  }
  // rosette
  for (let k = 0; k < 8; k++) leaf(g, 0, 0, k * Math.PI / 4, s * 0.09, P);
  g.beginPath(); g.arc(0, 0, s * 0.03, 0, Math.PI * 2); g.fillStyle = P.goldHi; g.fill();
  g.restore();
}

function star(g, r0, r1, n, P) {
  g.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const a = k / (n * 2) * Math.PI * 2, r = k % 2 ? r0 : r1;
    if (k === 0) g.moveTo(Math.sin(a) * r, Math.cos(a) * r); else g.lineTo(Math.sin(a) * r, Math.cos(a) * r);
  }
  g.closePath(); g.fillStyle = P.gold; g.fill(); g.lineWidth = r1 * 0.03; g.strokeStyle = P.goldLo; g.stroke();
}

function veins(g, x0, y0, w, h, rnd, n, alpha, tone = '60,55,50') {
  for (let k = 0; k < n; k++) {
    let x = x0 + rnd() * w, y = y0 + rnd() * h, a = rnd() * Math.PI * 2;
    g.beginPath(); g.moveTo(x, y);
    const steps = 12 + Math.floor(rnd() * 14), st = Math.max(w, h) / 14;
    for (let s = 0; s < steps; s++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * st; y += Math.sin(a) * st; g.lineTo(x, y); }
    g.strokeStyle = `rgba(${tone},${alpha * (0.4 + rnd() * 0.6)})`; g.lineWidth = 0.02 + rnd() * 0.05; g.stroke();
  }
}

// Paint the floor: mode 'color' (albedo) or 'orm' (roughness in G, metalness in B)
export function paintFloor(size, mode) {
  const c = mk(size, size), g = c.getContext('2d');
  const P = mode === 'color' ? COL : ORM, color = mode === 'color';
  const S = FLOOR_S, k = size / (2 * S);
  g.setTransform(k, 0, 0, k, size / 2, size / 2);
  const { rnd } = makeNoise(5);
  g.fillStyle = P.marble; g.fillRect(-S, -S, 2 * S, 2 * S);
  // 4 m marble slabs with tone variation and veins
  const step = 4;
  for (let x = -S; x < S; x += step) for (let y = -S; y < S; y += step) {
    if (Math.hypot(x + step / 2, y + step / 2) > S + 3) continue;
    if (color) {
      const t = rnd();
      g.fillStyle = t < 0.33 ? COL.marble : t < 0.66 ? COL.marble2 : '#e3d9c6';
      g.fillRect(x, y, step, step);
      veins(g, x, y, step, step, rnd, 2, 0.14);
    }
  }
  if (color) {
    g.strokeStyle = 'rgba(120,105,85,0.55)'; g.lineWidth = 0.035;
    g.beginPath();
    for (let x = -S; x <= S; x += step) { g.moveTo(x, -S); g.lineTo(x, S); g.moveTo(-S, x); g.lineTo(S, x); }
    g.stroke();
  }

  // ---- panel field between the inner ring and the outer band: checker of 12 m panels
  g.save();
  g.beginPath(); g.arc(0, 0, 95, 0, Math.PI * 2); g.arc(0, 0, 30, 0, Math.PI * 2, true); g.clip('evenodd');
  const PS = 16;                              // panels start at the runway's edges
  for (let i = -7; i < 7; i++) for (let j = -7; j < 7; j++) {
    const x = i * PS + (i >= 0 ? 6 : -6), y = j * PS - PS / 2, cx = x + PS / 2, cy = y + PS / 2, r = Math.hypot(cx, cy);
    if (r > 104 || r < 20) continue;
    const dark = (i + j) & 1, ins = 0.8;
    if (dark) {
      g.fillStyle = P.grey; g.fillRect(x + ins, y + ins, PS - 2 * ins, PS - 2 * ins);
      if (color) {
        g.fillStyle = 'rgba(80,74,66,0.3)'; g.fillRect(x + 2.2, y + 2.2, PS - 4.4, PS - 4.4);
        veins(g, x + ins, y + ins, PS - 2 * ins, PS - 2 * ins, rnd, 10, 0.4, '238,232,222');
      }
      g.strokeStyle = P.gold; g.lineWidth = 0.2; g.strokeRect(x + ins, y + ins, PS - 2 * ins, PS - 2 * ins);
      g.lineWidth = 0.08; g.strokeRect(x + ins + 0.5, y + ins + 0.5, PS - 2 * ins - 1, PS - 2 * ins - 1);
      if (r > 32 && r < 92) {
        if ((i * 3 + j) % 3 === 0) { g.save(); g.translate(cx, cy); star(g, 1.3, 3.4, 8, P); g.restore(); g.save(); g.translate(cx, cy); g.beginPath(); g.arc(0, 0, 4.3, 0, Math.PI * 2); g.strokeStyle = P.gold; g.lineWidth = 0.14; g.stroke(); g.restore(); }
        else wreath(g, cx, cy - 0.5, 3.4, P);
      }
    } else {
      g.strokeStyle = P.gold; g.lineWidth = 0.1; g.strokeRect(x + ins, y + ins, PS - 2 * ins, PS - 2 * ins);
      if (r > 32 && r < 92) scrolls(g, cx, cy, PS * 0.9, ((i * 7 + j * 3) % 4) * Math.PI / 2, P);
    }
  }
  g.restore();

  // ---- outer band by the wall
  annulus(g, 95, 104.5, P.greyDark);
  if (color) {
    g.save(); g.beginPath(); g.arc(0, 0, 104.5, 0, Math.PI * 2); g.arc(0, 0, 95, 0, Math.PI * 2, true); g.clip('evenodd');
    veins(g, -105, -105, 210, 210, rnd, 260, 0.25, '210,200,190'); g.restore();
  }
  annulus(g, 97.3, 99.9, P.black);
  meander(g, ringMap(97.4, 99.8), 2 * Math.PI * 98.6, 2.4, P);
  ring(g, 95.3, 0.22, P.gold); ring(g, 96.6, 0.08, P.gold); ring(g, 100.6, 0.08, P.gold); ring(g, 103.4, 0.22, P.gold);
  // laurel wreaths around the band
  for (let k = 0; k < 24; k++) {
    const a = (k + 0.5) / 24 * Math.PI * 2;
    if (Math.abs(Math.sin(a)) < 0.06) continue;
    const r = 102;
    g.save(); g.translate(Math.sin(a) * r, Math.cos(a) * r); g.rotate(-a + Math.PI); wreath(g, 0, -0.1, 0.8, P); g.restore();
  }

  // ---- inner ring 24–30 m
  annulus(g, 23.5, 30.5, P.black);
  annulus(g, 29, 30.5, P.red);
  annulus(g, 23.5, 25, P.red);
  meander(g, ringMap(25.2, 28.8), 2 * Math.PI * 27, 3.6, P);
  ring(g, 23.5, 0.2, P.gold); ring(g, 25.1, 0.1, P.gold); ring(g, 28.9, 0.1, P.gold); ring(g, 30.5, 0.2, P.gold);
  // sunburst 11–23.5
  for (let k = 0; k < 32; k++) {
    const a0 = k / 32 * Math.PI * 2, a1 = (k + 1) / 32 * Math.PI * 2;
    g.beginPath(); g.moveTo(Math.sin(a0) * 11, Math.cos(a0) * 11); g.lineTo(Math.sin(a0) * 23.5, Math.cos(a0) * 23.5);
    g.lineTo(Math.sin(a1) * 23.5, Math.cos(a1) * 23.5); g.lineTo(Math.sin(a1) * 11, Math.cos(a1) * 11); g.closePath();
    g.fillStyle = k & 1 ? P.marble : P.grey; g.fill();
    if (color && !(k & 1)) { g.save(); g.clip(); veins(g, -24, -24, 48, 48, rnd, 3, 0.3, '235,230,220'); g.restore(); }
  }
  for (let k = 0; k < 32; k++) {
    const a = k / 32 * Math.PI * 2;
    g.beginPath(); g.moveTo(Math.sin(a) * 11, Math.cos(a) * 11); g.lineTo(Math.sin(a) * 23.5, Math.cos(a) * 23.5);
    g.strokeStyle = P.gold; g.lineWidth = 0.07; g.stroke();
  }
  ring(g, 17.3, 0.14, P.gold);
  // medallion
  annulus(g, 0, 11, P.red);
  if (color) { g.save(); g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.clip(); veins(g, -11, -11, 22, 22, rnd, 30, 0.35, '40,8,6'); g.restore(); }
  ring(g, 11, 0.32, P.gold); ring(g, 10.3, 0.08, P.gold);
  wreath(g, 0, -0.2, 7.6, P);
  star(g, 1.9, 4.6, 8, P);
  annulus(g, 0, 1.7, P.black); ring(g, 1.7, 0.12, P.gold);

  // ---- the red runway from the gate (+z) across the arena
  for (const sgn of [1, -1]) {
    const z0 = sgn * 30.5, z1 = sgn * 104.5;
    const ya = Math.min(z0, z1), yb = Math.max(z0, z1);
    g.fillStyle = P.black; g.fillRect(-5.6, ya, 11.2, yb - ya);
    g.fillStyle = P.red; g.fillRect(-4, ya, 8, yb - ya);
    if (color) { g.save(); g.beginPath(); g.rect(-4, ya, 8, yb - ya); g.clip(); veins(g, -4, ya, 8, yb - ya, rnd, 40, 0.35, '40,8,6'); g.restore(); }
    for (const sx of [-1, 1]) {
      const x0 = sx * 4.25, x1 = sx * 5.45;
      meander(g, (s, t) => [x0 + (x1 - x0) * t / 1.2, ya + s], yb - ya, 1.2, P);
    }
    g.fillStyle = P.gold;
    for (const x of [-5.75, -4.15, 4.0, 5.6]) g.fillRect(x, ya, 0.15, yb - ya);
    // wreaths along the runway
    for (let z = 36; z < 100; z += 12) wreath(g, 0, sgn * z, 1.9, P);
  }

  // ---- sand: a light dusting, heavier along the wall and in drifts
  sandLayer(g, P, color);
  return c;
}

function sandLayer(g, P, color) {
  const { rnd } = makeNoise(77);
  const sand = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const c0 = color ? `rgba(210,182,136,${a})` : `rgba(0,225,0,${a})`;
    gr.addColorStop(0, c0); gr.addColorStop(0.55, color ? `rgba(206,178,132,${a * 0.6})` : `rgba(0,225,0,${a * 0.6})`);
    gr.addColorStop(1, color ? 'rgba(206,178,132,0)' : 'rgba(0,225,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  // drifts along the wall
  for (let k = 0; k < 420; k++) {
    const a = rnd() * Math.PI * 2, r = 104 - Math.pow(rnd(), 1.6) * 14;
    sand(Math.sin(a) * r, Math.cos(a) * r, 1.5 + rnd() * 5, 0.25 + 0.45 * (r - 90) / 14 * rnd());
  }
  // patches over the arena, clustered by low-frequency noise
  for (let k = 0; k < 900; k++) {
    const x = (rnd() * 2 - 1) * 104, y = (rnd() * 2 - 1) * 104;
    if (Math.hypot(x, y) > 103) continue;
    const n = N1.fbm(x / 35 + 10, y / 35 + 4, 3);
    if (n < 0.02) continue;
    sand(x, y, 1 + rnd() * 4.5, Math.min(0.45, n * 1.2) * (0.5 + rnd() * 0.5));
  }
  // thin streaks blown across the floor
  for (let k = 0; k < 160; k++) {
    const x = (rnd() * 2 - 1) * 100, y = (rnd() * 2 - 1) * 100;
    if (Math.hypot(x, y) > 100) continue;
    g.save(); g.translate(x, y); g.rotate(0.6 + rnd() * 0.3); g.scale(4 + rnd() * 6, 0.6 + rnd() * 0.5);
    sand(0, 0, 1, 0.12 + rnd() * 0.12); g.restore();
  }
}

// close-up detail for the floor (tiles every few metres): fine marble veins + sand grains; 128 = no change
export function paintFloorDetail(size = 1024) {
  const c = mk(size, size), g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const per = 8;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * per, v = y / size * per;
    const t = N2.fbm(u, v, 4, per);
    const vein = Math.pow(1 - Math.abs(Math.sin((u * 0.9 + v * 0.5 + t * 4.2) * Math.PI)), 18);
    const grain = (N3.noise(x * 0.9, y * 0.9, size * 0.9) * 0.5 + N3.noise(x * 0.37 + 5, y * 0.37, size * 0.37) * 0.5);
    let val = 128 + t * 18 - vein * 30 + grain * 10;
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = clamp(val, 0, 255); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------------------------------------------ stone / marble
// travertine blocks (tiles every `m` metres): warm beige, staggered courses, pits
export function paintStone(size = 1024, m = 4) {
  const c = mk(size, size), g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const course = size / (m / 0.6) | 0, blockW = course * 2;
  for (let y = 0; y < size; y++) {
    const row = (y / course) | 0, off = (row & 1) * blockW / 2;
    for (let x = 0; x < size; x++) {
      const bx = ((x + off) / blockW) | 0, inX = (x + off) % blockW, inY = y % course;
      const h = N1.noise(bx * 3.7 + row * 1.3, row * 2.1, 256);
      const t = N2.fbm(x / size * 16, y / size * 16, 4, 16);
      const pit = N3.noise(x * 0.35, y * 0.35, size * 0.35) > 0.62 ? -38 : 0;
      const streak = N1.fbm(x / size * 40, y / size * 4, 3, 40) * 14;
      let r = 205 + h * 14 + t * 22 + pit + streak, gg = 186 + h * 12 + t * 20 + pit + streak, b = 156 + h * 10 + t * 16 + pit + streak;
      const joint = inX < 3 || inY < 3;
      if (joint) { r *= 0.62; gg *= 0.6; b *= 0.58; }
      const i = (y * size + x) * 4;
      d[i] = clamp(r, 0, 255); d[i + 1] = clamp(gg, 0, 255); d[i + 2] = clamp(b, 0, 255); d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// white marble with grey veins (tileable)
export function paintMarble(size = 1024, warm = 0) {
  const c = mk(size, size), g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const per = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * per, v = y / size * per;
    const t = N3.fbm(u, v, 5, per);
    const vein = Math.pow(1 - Math.abs(Math.sin((u * 1.3 + v * 0.7 + t * 5) * Math.PI)), 12);
    const base = 232 + t * 14 - vein * 70;
    const i = (y * size + x) * 4;
    d[i] = clamp(base + warm * 6, 0, 255); d[i + 1] = clamp(base - 2 + warm * 2, 0, 255); d[i + 2] = clamp(base - 8 - warm * 4, 0, 255); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// fluting for column shafts: one flute per texture repeat (normal map)
export function paintFlutes(w = 128, h = 8) {
  const c = mk(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let x = 0; x < w; x++) {
    const u = x / w;                       // 0..1 across a flute: a concave channel with a flat fillet at the edges
    let nx = 0;
    if (u > 0.08 && u < 0.92) { const t = (u - 0.5) / 0.42; nx = -t * 0.8; }
    const nz = Math.sqrt(1 - nx * nx);
    for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = 128; d[i + 2] = nz * 255; d[i + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------------------------------------------ relief frieze
// carved panels of soldiers and horses (height map → shaded stone + normal map). Tile = 9.6 m × 2.4 m.
export function paintRelief(w = 2048, h = 512) {
  const hc = mk(w, h), hg = hc.getContext('2d');
  hg.fillStyle = '#000'; hg.fillRect(0, 0, w, h);
  const { rnd } = makeNoise(11);
  const panelW = w / 2;
  for (let p = 0; p < 2; p++) {
    const x0 = p * panelW;
    // frame moulding
    hg.fillStyle = '#9a9a9a'; hg.fillRect(x0 + 8, 10, panelW - 16, 22); hg.fillRect(x0 + 8, h - 32, panelW - 16, 22);
    hg.fillRect(x0 + 8, 10, 20, h - 20); hg.fillRect(x0 + panelW - 28, 10, 20, h - 20);
    hg.fillStyle = '#5a5a5a'; hg.fillRect(x0 + 34, 38, panelW - 68, h - 76);
    // figures
    const n = 4;
    for (let k = 0; k < n; k++) {
      const fx = x0 + 90 + k * (panelW - 180) / (n - 1), base = h - 44;
      const horse = (k + p) % 3 === 1;
      hg.fillStyle = '#e6e6e6'; hg.strokeStyle = '#e6e6e6'; hg.lineCap = 'round';
      if (horse) {
        hg.beginPath(); hg.ellipse(fx, base - 150, 82, 42, -0.08, 0, Math.PI * 2); hg.fill();      // body
        hg.lineWidth = 16;
        for (const [lx, ang] of [[-55, -0.3], [-35, 0.2], [45, -0.15], [62, 0.35]]) {
          hg.beginPath(); hg.moveTo(fx + lx, base - 130); hg.lineTo(fx + lx + Math.sin(ang) * 120, base - 10); hg.stroke();
        }
        hg.lineWidth = 34; hg.beginPath(); hg.moveTo(fx + 60, base - 170); hg.lineTo(fx + 100, base - 250); hg.stroke(); // neck
        hg.beginPath(); hg.ellipse(fx + 112, base - 252, 34, 18, 0.5, 0, Math.PI * 2); hg.fill();                    // head
        hg.lineWidth = 10; hg.beginPath(); hg.moveTo(fx - 80, base - 160); hg.quadraticCurveTo(fx - 120, base - 120, fx - 110, base - 70); hg.stroke(); // tail
        // rider
        hg.beginPath(); hg.ellipse(fx + 5, base - 230, 22, 48, 0.1, 0, Math.PI * 2); hg.fill();
        hg.beginPath(); hg.arc(fx + 12, base - 292, 20, 0, Math.PI * 2); hg.fill();
        hg.lineWidth = 8; hg.beginPath(); hg.moveTo(fx - 40, base - 330); hg.lineTo(fx + 90, base - 200); hg.stroke(); // spear
      } else {
        const lean = (rnd() - 0.5) * 0.3;
        hg.lineWidth = 20;
        hg.beginPath(); hg.moveTo(fx - 18, base); hg.lineTo(fx - 6 + lean * 60, base - 120); hg.stroke();   // legs
        hg.beginPath(); hg.moveTo(fx + 22, base); hg.lineTo(fx + 8 + lean * 60, base - 120); hg.stroke();
        hg.beginPath(); hg.moveTo(fx - 30 + lean * 60, base - 110); hg.lineTo(fx + 32 + lean * 60, base - 110);
        hg.lineTo(fx + 26 + lean * 80, base - 230); hg.lineTo(fx - 24 + lean * 80, base - 230); hg.closePath(); hg.fill(); // tunic & torso
        hg.beginPath(); hg.arc(fx + lean * 90, base - 258, 24, 0, Math.PI * 2); hg.fill();                    // head
        hg.beginPath(); hg.moveTo(fx - 10 + lean * 90, base - 280); hg.quadraticCurveTo(fx + lean * 90, base - 318, fx + 30 + lean * 90, base - 286); hg.lineWidth = 9; hg.stroke(); // crest
        hg.fillStyle = '#ffffff'; hg.beginPath(); hg.arc(fx - 42 + lean * 70, base - 165, 46, 0, Math.PI * 2); hg.fill(); // shield
        hg.fillStyle = '#cfcfcf'; hg.beginPath(); hg.arc(fx - 42 + lean * 70, base - 165, 14, 0, Math.PI * 2); hg.fill();
        hg.lineWidth = 8; hg.strokeStyle = '#e6e6e6';
        hg.beginPath(); hg.moveTo(fx + 40 + lean * 80, base - 20); hg.lineTo(fx + 60 + lean * 90, base - 340); hg.stroke(); // spear
      }
    }
  }
  // blur the height a little so the edges read as carved
  const hb = mk(w, h), hbg = hb.getContext('2d');
  hbg.filter = 'blur(3px)'; hbg.drawImage(hc, 0, 0);
  const H = hbg.getImageData(0, 0, w, h).data;
  const color = mk(w, h), cg = color.getContext('2d'), ci = cg.createImageData(w, h), cd = ci.data;
  const nrm = mk(w, h), ng = nrm.getContext('2d'), ni = ng.createImageData(w, h), nd = ni.data;
  const ht = (x, y) => H[((clamp(y, 0, h - 1) * w) + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (ht(x + 1, y) - ht(x - 1, y)) * 6, dy = (ht(x, y + 1) - ht(x, y - 1)) * 6;
    const l = Math.hypot(dx, dy, 1), nx = -dx / l, ny = -dy / l, nz = 1 / l;
    const t = N2.fbm(x / w * 24, y / h * 6, 4, 24);
    const hh = ht(x, y);
    const shade = 0.82 + hh * 0.22 + t * 0.12 + (ny * -0.25 + nx * 0.12);   // light from above-left
    const i = (y * w + x) * 4;
    cd[i] = clamp(214 * shade, 0, 255); cd[i + 1] = clamp(196 * shade, 0, 255); cd[i + 2] = clamp(166 * shade, 0, 255); cd[i + 3] = 255;
    nd[i] = (nx * 0.5 + 0.5) * 255; nd[i + 1] = (-ny * 0.5 + 0.5) * 255; nd[i + 2] = nz * 255; nd[i + 3] = 255;
  }
  cg.putImageData(ci, 0, 0); ng.putImageData(ni, 0, 0);
  return { color, normal: nrm };
}

// ------------------------------------------------------------------------------------------------ cloth
export function paintBanner(w = 512, h = 1024) {
  const c = mk(w, h), g = c.getContext('2d');
  const P = COL;
  // velvet with soft vertical folds
  for (let x = 0; x < w; x++) {
    const f = 0.82 + 0.18 * Math.sin(x / w * Math.PI * 7) * Math.sin(x / w * Math.PI * 2.3 + 1);
    g.fillStyle = `rgb(${Math.round(150 * f)},${Math.round(20 * f)},${Math.round(22 * f)})`;
    g.fillRect(x, 0, 1, h);
  }
  // swallow-tail bottom: cut out with transparency
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.moveTo(0, h); g.lineTo(w / 2, h - w * 0.32); g.lineTo(w, h); g.closePath(); g.fill();
  g.globalCompositeOperation = 'source-over';
  // gold border
  g.strokeStyle = P.gold; g.lineWidth = 14;
  g.beginPath(); g.moveTo(24, 20); g.lineTo(w - 24, 20); g.lineTo(w - 24, h - 30); g.lineTo(w / 2, h - w * 0.32 - 26); g.lineTo(24, h - 30); g.closePath(); g.stroke();
  g.lineWidth = 4; g.strokeStyle = P.goldHi;
  g.beginPath(); g.moveTo(44, 40); g.lineTo(w - 44, 40); g.lineTo(w - 44, h - 50); g.lineTo(w / 2, h - w * 0.32 - 48); g.lineTo(44, h - 50); g.closePath(); g.stroke();
  // emblem: laurel wreath, star, SPQR
  g.save(); g.translate(w / 2, h * 0.36); g.scale(w / 10, w / 10);
  wreath(g, 0, 0, 2.6, P);
  g.restore();
  g.fillStyle = P.gold; g.font = `bold ${Math.round(w * 0.15)}px Georgia, 'Times New Roman', serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('SPQR', w / 2, h * 0.36);
  g.save(); g.translate(w / 2, h * 0.66); g.scale(w / 26, w / 26); star(g, 1.2, 3, 8, P); g.restore();
  // fringe along the bottom edges
  g.strokeStyle = P.gold; g.lineWidth = 5;
  for (let k = 0; k <= 24; k++) {
    const t = k / 24, x = t * w, y = h - Math.abs(t - 0.5) * 2 * w * 0.32 * -1 - w * 0.32 + Math.abs(t - 0.5) * 0;
    const yy = t < 0.5 ? h - t * 2 * w * 0.32 : h - (1 - t) * 2 * w * 0.32;
    g.beginPath(); g.moveTo(x, yy - 18); g.lineTo(x, yy - 2); g.stroke();
  }
  return c;
}

export function paintFlag(w = 256, h = 128) {
  const c = mk(w, h), g = c.getContext('2d');
  g.fillStyle = '#a3161a'; g.fillRect(0, 0, w, h);
  g.fillStyle = COL.gold; g.fillRect(0, h * 0.42, w, h * 0.16);
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.moveTo(w, 0); g.lineTo(w * 0.72, h / 2); g.lineTo(w, h); g.closePath(); g.fill();
  return c;
}

// ------------------------------------------------------------------------------------------------ sky
// equirectangular sky at golden hour: deep blue above, warm haze at the horizon, low sun, lit cumulus
export function paintSky(w, h, sun) {
  const c = mk(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const [sx, sy, sz] = sun;
  for (let j = 0; j < h; j++) {
    const v = 1 - (j + 0.5) / h, th = (v - 0.5) * Math.PI, dy = Math.sin(th), cth = Math.cos(th);
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, ph = (u - 0.5) * Math.PI * 2;
      const dx = Math.cos(ph) * cth, dz = Math.sin(ph) * cth;
      const cs = dx * sx + dy * sy + dz * sz;                  // cos of the angle to the sun
      const up = Math.max(dy, 0);
      // gradient: warm horizon → pale blue → deep blue zenith; warmer towards the sun
      const warm = Math.pow(Math.max(cs, 0), 3) * 0.7 + 0.15;
      let r = 255 * (0.98 - 0.72 * Math.pow(up, 0.5)) , gg = 255 * (0.84 - 0.42 * Math.pow(up, 0.55)), b = 255 * (0.66 + 0.12 * Math.pow(up, 0.4));
      r = r * (1 - up) + 58 * up; gg = gg * (1 - up) + 104 * up; b = b * (1 - up) + 178 * up;
      const hz = Math.exp(-up * 9) * warm;
      r += 60 * hz; gg += 20 * hz; b -= 40 * hz;
      // sun glow and disc
      const glow = Math.pow(Math.max(cs, 0), 40) * 0.9 + Math.pow(Math.max(cs, 0), 8) * 0.35;
      r += 255 * glow; gg += 200 * glow; b += 120 * glow;
      if (cs > 0.9993) { r = 255; gg = 250; b = 228; }
      // clouds (projected on a plane above)
      if (dy > 0.015) {
        const k = 1 / (dy + 0.1);
        const cx = dx * k * 0.9, cz = dz * k * 0.9;
        let n = N1.fbm(cx + 3, cz + 7, 5) * 1.3 + N2.fbm(cx * 3.1, cz * 3.1, 3) * 0.3;
        n = clamp((n - 0.02) * 2.2, 0, 1) * clamp((dy - 0.015) * 10, 0, 1) * (1 - up * 0.4);
        if (n > 0) {
          const lit = 0.72 + 0.4 * Math.pow(Math.max(cs, 0), 2);
          // thick parts are darker underneath, edges glow in the low sun
          const body = clamp(N1.fbm(cx + 3.05, cz + 7.05, 4) * 2.2 + 0.25, 0, 1);
          const sh = 1 - 0.45 * body * (1 - Math.max(cs, 0) * 0.5);
          const cr = 255 * lit * sh + 40 * (1 - sh), cg = 222 * lit * sh + 52 * (1 - sh), cb = 182 * lit * sh + 78 * (1 - sh);
          r = r * (1 - n) + cr * n; gg = gg * (1 - n) + cg * n; b = b * (1 - n) + cb * n;
        }
      }
      if (dy < 0) { const t = clamp(-dy * 6, 0, 1); r = r * (1 - t) + 150 * t; gg = gg * (1 - t) + 128 * t; b = b * (1 - t) + 104 * t; }
      const q = (j * w + i) * 4;
      d[q] = clamp(r, 0, 255); d[q + 1] = clamp(gg, 0, 255); d[q + 2] = clamp(b, 0, 255); d[q + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
