// effects.js — particles (dust, smoke, sparks) and visible car damage (dents, scratches, cracked glass).
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Textures drawn on canvases (no image files needed)
// ---------------------------------------------------------------------------
function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

// soft, slightly lumpy puff for dust and smoke
export function puffTexture() {
  return canvasTexture(128, (g, s) => {
    const blob = (x, y, r, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };
    blob(s / 2, s / 2, s / 2, 0.7);
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * s * 0.18;
      blob(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.16 + Math.random() * 0.14), 0.3);
    }
  });
}

export function sparkTexture() {
  return canvasTexture(32, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.8)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}

// scratches: a bundle of thin streaks along the decal's x axis — bare metal and dark primer
function scratchTexture() {
  return canvasTexture(256, (g, s) => {
    g.clearRect(0, 0, s, s);
    for (let i = 0; i < 50; i++) {
      const y = s * (0.15 + Math.random() * 0.7), x0 = s * Math.random() * 0.35, len = s * (0.3 + Math.random() * 0.6);
      const bright = Math.random() < 0.65;
      g.strokeStyle = bright ? `rgba(215,215,220,${0.45 + Math.random() * 0.5})` : `rgba(45,40,38,${0.45 + Math.random() * 0.4})`;
      g.lineWidth = 0.6 + Math.random() * (bright ? 1.6 : 3.2);
      g.beginPath(); g.moveTo(x0, y);
      g.lineTo(Math.min(x0 + len, s - 2), y + (Math.random() - 0.5) * s * 0.05);
      g.stroke();
    }
    for (let i = 0; i < 22; i++) { // chipped paint flakes
      g.fillStyle = `rgba(55,50,46,${0.35 + Math.random() * 0.4})`;
      g.beginPath();
      g.ellipse(s * (0.05 + Math.random() * 0.9), s * (0.2 + Math.random() * 0.6), 1 + Math.random() * 4, 1 + Math.random() * 2, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // fade the edges so the decal has no visible border
    g.globalCompositeOperation = 'destination-in';
    const gr = g.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.5);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}

// crumpled, chipped paint: torn patches of bare metal and primer, scratches, dark creases where the metal folded,
// specks of dirt. A few random variants so repeated decals don't look the same.
function chipTexture(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return canvasTexture(512, (g, S) => {
    g.clearRect(0, 0, S, S);
    // torn paint: flakes stretched along the scrape, with ragged edges (two noise scales round the rim)
    const flake = (x, y, r, sx, sy, ph, fill) => {
      g.beginPath();
      const n = 40;
      for (let k = 0; k <= n; k++) {
        const a = k / n * Math.PI * 2;
        const rr = r * (0.78 + 0.22 * Math.sin(a * 2 + ph) + 0.12 * Math.sin(a * 5 + ph * 3) + (rnd() - 0.5) * 0.16);
        const px = x + Math.cos(a) * rr * sx, py = y + Math.sin(a) * rr * sy;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fillStyle = fill; g.fill();
    };
    for (let c = 0; c < 5; c++) {
      const cx = S * (0.22 + rnd() * 0.56), cy = S * (0.25 + rnd() * 0.5);
      for (let k = 0; k < 6; k++) {
        const x = cx + (rnd() - 0.5) * S * 0.3, y = cy + (rnd() - 0.5) * S * 0.12, r = S * (0.012 + rnd() * 0.045);
        const sx = 1.3 + rnd() * 1.3, sy = 0.45 + rnd() * 0.35, ph = rnd() * 6.3;
        // paint edge (a dark lip), the primer under it, then bare steel; now and then a rusty speck
        flake(x, y + 1, r * 1.22, sx, sy, ph, `rgba(${28 + rnd() * 12},${26 + rnd() * 10},${26 + rnd() * 8},0.7)`);
        flake(x, y, r * 1.12, sx, sy, ph, `rgba(${150 + rnd() * 25},${146 + rnd() * 22},${136 + rnd() * 18},0.92)`);
        flake(x, y, r * 0.82, sx, sy, ph + 0.4, `rgba(${104 + rnd() * 30},${108 + rnd() * 30},${114 + rnd() * 30},0.95)`);
        if (rnd() < 0.2) flake(x + r * 0.4, y, r * 0.35, sx, sy, ph, `rgba(${96 + rnd() * 30},${52 + rnd() * 16},${30 + rnd() * 10},0.65)`);
      }
    }
    // creases: dark folds with a light edge
    for (let k = 0; k < 7; k++) {
      let x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI;
      g.beginPath(); g.moveTo(x, y);
      const pts = [[x, y]];
      for (let j = 0; j < 8; j++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * S * 0.05; y += Math.sin(a) * S * 0.05; pts.push([x, y]); }
      for (const [px, py] of pts) g.lineTo(px, py);
      g.strokeStyle = `rgba(20,18,16,${0.45 + rnd() * 0.35})`; g.lineWidth = 2 + rnd() * 4; g.stroke();
      g.beginPath(); pts.forEach(([px, py], j) => (j ? g.lineTo(px + 2, py - 2) : g.moveTo(px + 2, py - 2)));
      g.strokeStyle = `rgba(235,235,238,${0.25 + rnd() * 0.3})`; g.lineWidth = 1 + rnd() * 1.5; g.stroke();
    }
    // scratches
    for (let k = 0; k < 45; k++) {
      const x = rnd() * S, y = rnd() * S, a = (rnd() - 0.5) * 0.6 + (rnd() < 0.5 ? 0 : Math.PI / 2 * rnd()), len = S * (0.05 + rnd() * 0.35);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      const bright = rnd() < 0.7;
      g.strokeStyle = bright ? `rgba(225,225,230,${0.3 + rnd() * 0.5})` : `rgba(40,36,34,${0.3 + rnd() * 0.4})`;
      g.lineWidth = 0.5 + rnd() * 1.8; g.stroke();
    }
    // dirt specks
    for (let k = 0; k < 220; k++) {
      g.fillStyle = `rgba(${70 + rnd() * 40},${62 + rnd() * 30},${50 + rnd() * 20},${0.2 + rnd() * 0.4})`;
      g.beginPath(); g.arc(rnd() * S, rnd() * S, 0.6 + rnd() * 2.2, 0, Math.PI * 2); g.fill();
    }
    // soft, ragged border
    g.globalCompositeOperation = 'destination-in';
    const gr = g.createRadialGradient(S / 2, S / 2, S * 0.22, S / 2, S / 2, S * 0.5);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  });
}

// cracked glass: radial cracks from the hit point plus broken rings
function crackTexture() {
  return canvasTexture(512, (g, s) => {
    g.clearRect(0, 0, s, s);
    const cx = s / 2, cy = s / 2;
    g.strokeStyle = 'rgba(230,236,242,0.9)';
    g.lineCap = 'round';
    const rays = 15 + Math.floor(Math.random() * 6);
    const ends = [];
    for (let i = 0; i < rays; i++) {
      let a = (i / rays) * Math.PI * 2 + Math.random() * 0.3, x = cx, y = cy;
      const len = s * (0.3 + Math.random() * 0.18);
      g.lineWidth = 1.2 + Math.random() * 1.6;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 1; k <= 6; k++) {
        a += (Math.random() - 0.5) * 0.35;
        x = cx + Math.cos(a) * len * k / 6; y = cy + Math.sin(a) * len * k / 6;
        g.lineTo(x, y);
      }
      g.stroke();
      ends.push((i / rays) * Math.PI * 2);
    }
    g.lineWidth = 1.1;
    for (const r of [0.05, 0.11, 0.19, 0.28]) {
      g.beginPath();
      for (let i = 0; i < ends.length; i++) {
        if (Math.random() < 0.3) continue;
        const a0 = ends[i], a1 = i + 1 < ends.length ? ends[i + 1] : ends[0] + Math.PI * 2;
        const r0 = s * r * (0.9 + Math.random() * 0.2), r1 = s * r * (0.9 + Math.random() * 0.2);
        g.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
        g.lineTo(cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1);
      }
      g.stroke();
    }
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.06);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, s * 0.06, 0, Math.PI * 2); g.fill();
  });
}

// ---------------------------------------------------------------------------
// GPU point particles with per-particle size, colour and alpha
// ---------------------------------------------------------------------------
const PARTICLE_VS = /* glsl */`
  attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
    vAlpha = aAlpha; vColor = aColor;
  }`;
const PARTICLE_FS = /* glsl */`
  uniform sampler2D uMap;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }`;

export class Particles {
  constructor(max, texture, additive = false) {
    this.max = max; this.count = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.lift = new Float32Array(max);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha); g.setAttribute('aColor', this.aColor);
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uScale: { value: 800 } },
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.geometry = g;
  }

  // color: THREE.Color (linear). lift: vertical acceleration (+ rises like smoke, −9.8 falls like a spark)
  emit(x, y, z, vx, vy, vz, life, s0, s1, alpha, color, drag = 1, lift = 0) {
    const i = this.count < this.max ? this.count++ : Math.floor(Math.random() * this.max);
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.col[j] = color.r; this.col[j + 1] = color.g; this.col[j + 2] = color.b;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha;
    this.drag[i] = drag; this.lift[i] = lift; this.size[i] = s0; this.alpha[i] = 0;
  }

  _move(from, to) {
    const a = from * 3, b = to * 3;
    for (let k = 0; k < 3; k++) { this.pos[b + k] = this.pos[a + k]; this.vel[b + k] = this.vel[a + k]; this.col[b + k] = this.col[a + k]; }
    this.age[to] = this.age[from]; this.life[to] = this.life[from]; this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.a0[to] = this.a0[from]; this.drag[to] = this.drag[from]; this.lift[to] = this.lift[from];
    this.size[to] = this.size[from]; this.alpha[to] = this.alpha[from];
  }

  // floorY: particles bounce off this height (sparks skitter on the ground)
  update(dt, pixelScale, floorY = -Infinity) {
    for (let i = 0; i < this.count;) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.count--; if (i !== this.count) this._move(this.count, i); continue; }
      const j = i * 3, k = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= k; this.vel[j + 2] *= k;
      this.vel[j + 1] = this.vel[j + 1] * k + this.lift[i] * dt;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < floorY) { this.pos[j + 1] = floorY; this.vel[j + 1] *= -0.3; this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6; }
      const t = this.age[i] / this.life[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      this.alpha[i] = this.a0[i] * Math.min(1, t / 0.1) * (1 - t) * (1 - t * 0.3);
      i++;
    }
    this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true; this.aColor.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count);
    this.material.uniforms.uScale.value = pixelScale;
  }
}

// ---------------------------------------------------------------------------
// Small vector helpers on plain arrays
// ---------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function qInvRotate(q, v) { // rotate v by the inverse of quaternion q
  const x = -q.x, y = -q.y, z = -q.z, w = q.w;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
const smooth01 = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function closestOnTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

// uniform grid over the car (cells of 25 cm): finds the vertices / triangles near a hit without scanning
// the whole mesh (the full-detail Datsun has a million vertices)
const GRID = 0.25;
const cellOf = (v) => Math.floor(v / GRID) + 2048;
const gridKey = (ix, iy, iz) => (ix * 4096 + iy) * 4096 + iz;
function gridAdd(map, x, y, z, item) {
  const k = gridKey(cellOf(x), cellOf(y), cellOf(z));
  let a = map.get(k);
  if (!a) { a = []; map.set(k, a); }
  a.push(item);
}
// call fn(item) for everything stored in cells overlapping the box (c ± r)
function gridQuery(map, c, r, fn) {
  const x0 = cellOf(c[0] - r), x1 = cellOf(c[0] + r), y0 = cellOf(c[1] - r), y1 = cellOf(c[1] + r), z0 = cellOf(c[2] - r), z1 = cellOf(c[2] + r);
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
    const a = map.get(gridKey(ix, iy, iz));
    if (a) for (let i = 0; i < a.length; i++) fn(a[i]);
  }
}
const MOVE = 1.0; // panels can be pushed this far from where the grid saw them
// small meshes (the low-poly Ferrari) are simply scanned; big ones go through the grid
function nearTris(e, c, r, fn) {
  if (!e.tgrid) { for (let t = 0; t < e.triCount; t++) fn(t); return; }
  gridQuery(e.tgrid, c, r, fn);
}
function nearVerts(e, c, r, fn) {
  if (!e.vgrid) { for (let i = 0, n = e.pos.length / 3; i < n; i++) fn(i); return; }
  gridQuery(e.vgrid, c, r, fn);
}

// Sutherland–Hodgman clip of a polygon (vertices carry decal-space d[3] and barycentric w[3]) against d[axis]*sign <= lim
function clipPoly(poly, axis, sign, lim) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = a.d[axis] * sign - lim, db = b.d[axis] * sign - lim;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push({
        d: [a.d[0] + (b.d[0] - a.d[0]) * t, a.d[1] + (b.d[1] - a.d[1]) * t, a.d[2] + (b.d[2] - a.d[2]) * t],
        w: [a.w[0] + (b.w[0] - a.w[0]) * t, a.w[1] + (b.w[1] - a.w[1]) * t, a.w[2] + (b.w[2] - a.w[2]) * t],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quantised models (KHR_mesh_quantization): nodes named "*_q" carry the de-quantisation transform.
// Turn their geometry into plain metres (float32) so dents and decals can work in real units.
// ---------------------------------------------------------------------------
function toFloat(attr) {
  const n = attr.count, k = attr.itemSize, out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    out[i * k] = attr.getX(i);
    if (k > 1) out[i * k + 1] = attr.getY(i);
    if (k > 2) out[i * k + 2] = attr.getZ(i);
  }
  return out;
}
export function bakeQuantized(model) {
  const nodes = [];
  model.traverse((o) => { if (/_q$/.test(o.name || '')) nodes.push(o); });
  const v = new THREE.Vector3();
  for (const node of nodes) {
    const s = node.scale.x, t = node.position.clone(), q = node.quaternion.clone();
    const meshes = [];
    node.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const g = mesh.geometry;
      const p = toFloat(g.attributes.position);
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i] * s, p[i + 1] * s, p[i + 2] * s).applyQuaternion(q).add(t);
        p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z;
      }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      if (g.attributes.normal) {
        const nr = toFloat(g.attributes.normal);
        for (let i = 0; i < nr.length; i += 3) {
          v.set(nr[i], nr[i + 1], nr[i + 2]).applyQuaternion(q).normalize();
          nr[i] = v.x; nr[i + 1] = v.y; nr[i + 2] = v.z;
        }
        g.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
      }
      g.boundingBox = null;
      g.computeBoundingSphere();
    }
    node.position.set(0, 0, 0); node.scale.set(1, 1, 1); node.quaternion.set(0, 0, 0, 1);
  }
  return nodes.length;
}

// ---------------------------------------------------------------------------
// Visible damage on the car body
// ---------------------------------------------------------------------------
export class CarDamageVisuals {
  // root: the object whose local frame is the physics frame (centre of mass, car axes)
  // opts.paletteGlass: the window glass is a dark cell of a palette texture (u > 0.5, v > 0.5) — the Ferrari model
  constructor(model, root, opts = {}) {
    this.root = root;
    this.paletteGlass = opts.paletteGlass !== false;
    this.entries = [];
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      for (let p = o; p; p = p.parent) if (/^Wheel_/.test(p.name || '')) return;
      this.entries.push(this._prepare(o));
    });
    this.decals = [];
    const decalMat = (map, rough, metal) => new THREE.MeshStandardMaterial({
      map, transparent: true, depthWrite: false, roughness: rough, metalness: metal,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.scratchMaterial = decalMat(scratchTexture(), 0.45, 0.5);
    this.chipMaterials = [11, 23, 37].map((sd) => decalMat(chipTexture(sd), 0.55, 0.55));
    this.crackMaterial = decalMat(crackTexture(), 0.1, 0.0);
  }

  _prepare(mesh) {
    const geo = mesh.geometry;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position, n = pos.count;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? idx.length / 3 : n / 3;
    const tri = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) tri[i] = idx ? idx[i] : i;
    // vertex -> triangles (CSR layout)
    const deg = new Uint32Array(n + 1);
    for (let i = 0; i < tri.length; i++) deg[tri[i] + 1]++;
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Uint32Array(tri.length), fill = deg.slice(0, n);
    for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) adj[fill[tri[t * 3 + k]]++] = t;
    // glass: a transparent material, or the dark window cell of the palette texture (u > 0.5, v > 0.5)
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const allGlass = !!(mat && (mat.transparent || /glass/i.test(mat.name || '')));
    const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
    const glass = new Uint8Array(n);
    for (let i = 0; i < n; i++) glass[i] = allGlass || (this.paletteGlass && uv && uv[i * 2] > 0.5 && uv[i * 2 + 1] > 0.5) ? 1 : 0;
    const triGlass = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) triGlass[t] = glass[tri[t * 3]] & glass[tri[t * 3 + 1]] & glass[tri[t * 3 + 2]];
    // longest triangle edge (quick distance rejects in the searches below)
    const pa = pos.array;
    let maxEdge = 0;
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const i0 = tri[t * 3 + k] * 3, i1 = tri[t * 3 + (k + 1) % 3] * 3;
        const l = Math.hypot(pa[i0] - pa[i1], pa[i0 + 1] - pa[i1 + 1], pa[i0 + 2] - pa[i1 + 2]);
        if (l > maxEdge) maxEdge = l;
      }
    }
    // transform chain from the car root down to this mesh
    const chain = [];
    for (let o = mesh; o && o !== this.root; o = o.parent) chain.push(o);
    chain.reverse();
    const big = triCount > 20000;
    const vgrid = big ? new Map() : null, tgrid = big ? new Map() : null;
    if (big) for (let i = 0; i < n; i++) gridAdd(vgrid, pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2], i);
    if (big) for (let t = 0; t < triCount; t++) {
      const i0 = tri[t * 3] * 3, i1 = tri[t * 3 + 1] * 3, i2 = tri[t * 3 + 2] * 3;
      gridAdd(tgrid, (pa[i0] + pa[i1] + pa[i2]) / 3, (pa[i0 + 1] + pa[i1 + 1] + pa[i2 + 1]) / 3, (pa[i0 + 2] + pa[i1 + 2] + pa[i2 + 2]) / 3, t);
    }
    return {
      mesh, tri, triCount, deg, adj, glass, triGlass, chain, maxEdge: maxEdge + 0.3, vgrid, tgrid,
      pos: pos.array, nrm: geo.attributes.normal.array,
      orig: Float32Array.from(pos.array), origN: Float32Array.from(geo.attributes.normal.array),
    };
  }

  // physics-frame point / direction -> mesh-local
  _pt(e, p) {
    let v = [p[0], p[1], p[2]];
    for (const o of e.chain) {
      v = qInvRotate(o.quaternion, [v[0] - o.position.x, v[1] - o.position.y, v[2] - o.position.z]);
      v[0] /= o.scale.x; v[1] /= o.scale.y; v[2] /= o.scale.z;
    }
    return v;
  }
  _dir(e, d) {
    let v = [d[0], d[1], d[2]];
    for (const o of e.chain) v = qInvRotate(o.quaternion, v);
    return norm(v);
  }

  // push panels in around the impact point by `depth` metres (the crush of the crash model) over radius R;
  // n points from the obstacle into the car (physics frame)
  dent(p, n, depth, R) {
    for (const e of this.entries) {
      const c = this._pt(e, p), dir = this._dir(e, n);
      const a = e.pos, o = e.orig;
      const touched = [];
      nearVerts(e, c, R + MOVE, (i) => {
        const j = i * 3;
        const dx = a[j] - c[0], dy = (a[j + 1] - c[1]) * 1.3, dz = a[j + 2] - c[2];
        const d2 = (dx * dx + dy * dy + dz * dz) / (R * R);
        if (d2 >= 1) return;
        // uneven crumple: the same jitter for vertices that share a position, so the mesh doesn't tear
        const f = (1 - d2) * (1 - d2) * (0.6 + 0.8 * hash3(o[j], o[j + 1], o[j + 2]));
        let nx = a[j] + dir[0] * depth * f, ny = a[j + 1] + dir[1] * depth * f, nz = a[j + 2] + dir[2] * depth * f;
        const ox = nx - o[j], oy = ny - o[j + 1], oz = nz - o[j + 2], len = Math.hypot(ox, oy, oz);
        if (len > 0.95) { const k = 0.95 / len; nx = o[j] + ox * k; ny = o[j + 1] + oy * k; nz = o[j + 2] + oz * k; }
        a[j] = nx; a[j + 1] = ny; a[j + 2] = nz;
        touched.push(i);
      });
      if (!touched.length) continue;
      this._fixNormals(e, touched);
      for (const d of this.decals) {
        if (d.e !== e) continue;
        const dc = d.center;
        if (Math.hypot(dc[0] - c[0], dc[1] - c[1], dc[2] - c[2]) < R + 1.2) this._rebuild(d);
      }
    }
  }

  // Crush against a flat obstacle (a wall, or the face of another car): everything in front of the crush plane —
  // `depth` metres behind the contact point p along n (n points into the car) — is pushed back onto it, so the
  // whole front / side folds in like a real crumple zone, not just a round dent. A little softer crumpling
  // behind the plane, wrinkles, and the panels buckle upwards a bit. halfW: half the width of the obstacle
  // across the car (Infinity for a wall); halfH: its half height (Infinity for a wall).
  // Big models take a while: this returns a job that works ~5 ms per call and returns true when it is done.
  // maxDisp: how far any point may end up from where it started (the sides fold in less than a crumple zone)
  // radius > 0: a round dent about the push line (the roof pressed down by the ground or another car)
  crushJob(p, n, depth, halfW = Infinity, halfH = Infinity, maxDisp = 0.95, radius = 0) {
    const soft = 0.45, jobs = this.entries.map((e) => ({ e, list: null, k: 0, touched: [], f: 0 }));
    let ei = 0;
    return () => {
      const t0 = performance.now();
      while (ei < jobs.length) {
        const J = jobs[ei], e = J.e;
        if (!J.list) {
          J.c = this._pt(e, p); J.dir = this._dir(e, n);
          const al = Math.hypot(J.dir[0], J.dir[2]) || 1;
          J.ax = [J.dir[2] / al, 0, -J.dir[0] / al];
          const reach = Math.min(Math.hypot(depth + soft + MOVE, Math.min(halfW, 2.6) + 0.5, Math.min(halfH, 1.8) + 0.5), 4.5);
          J.list = [];
          nearVerts(e, J.c, reach, (i) => J.list.push(i));
        }
        const a = e.pos, o = e.orig, c = J.c, dir = J.dir, ax = J.ax, L = J.list;
        while (J.k < L.length) {
          const end = Math.min(L.length, J.k + 4000);
          for (; J.k < end; J.k++) {
            const i = L[J.k], j = i * 3;
            const rx = a[j] - c[0], ry = a[j + 1] - c[1], rz = a[j + 2] - c[2];
            const s = rx * dir[0] + ry * dir[1] + rz * dir[2];
            if (s >= depth + soft) continue;
            let w = 1;
            if (radius > 0) {
              const lx = rx - s * dir[0], ly = ry - s * dir[1], lz = rz - s * dir[2];
              w *= smooth01((radius + 0.3 - Math.hypot(lx, ly, lz)) / (0.4 + radius * 0.5));
            }
            // another car: a rounded imprint of its nose — deepest at bumper height, easing off sideways and up
            // towards the stiff roof rail (the window line barely moves)
            if (halfW < Infinity) { const lat = Math.abs(rx * ax[0] + rz * ax[2]); w *= smooth01((halfW + 0.3 - lat) / (0.45 + halfW * 0.6)); }
            if (halfH < Infinity) { const vy = ry + 0.08; w *= smooth01((halfH + 0.2 - Math.abs(vy) * (vy > 0 ? 1.5 : 1)) / 0.55); }
            if (w <= 0) continue;
            // folds: a smooth wavy field over the original shape (shared positions move together, no spikes)
            const fx = o[j], fy = o[j + 1], fz = o[j + 2];
            const h = 1 + 0.13 * Math.sin(fx * 3.1 + Math.sin(fz * 2.3) * 1.5) * Math.sin(fy * 4.3 + fx * 1.1) * Math.sin(fz * 3.7 + fy * 1.7);
            let push = s < depth ? depth - s : 0;
            push += Math.max(0, 1 - Math.abs(s - depth) / soft) * depth * 0.1;   // the structure behind gives a little
            push *= w * h;
            if (push <= 1e-4) continue;
            const up = ry > 0.05 && Math.abs(dir[1]) < 0.5 ? push * 0.12 * h : 0;  // panels buckle up as they fold
            let nx = a[j] + dir[0] * push, ny = a[j + 1] + dir[1] * push + up, nz = a[j + 2] + dir[2] * push;
            const ox = nx - o[j], oy = ny - o[j + 1], oz = nz - o[j + 2], len = Math.hypot(ox, oy, oz);
            if (len > maxDisp) { const k = maxDisp / len; nx = o[j] + ox * k; ny = o[j + 1] + oy * k; nz = o[j + 2] + oz * k; }
            a[j] = nx; a[j + 1] = ny; a[j + 2] = nz;
            J.touched.push(i);
          }
          if (performance.now() - t0 > 5) return false;
        }
        // normals of what moved, in slices; one upload at the end
        while (J.f < J.touched.length) {
          const end = Math.min(J.touched.length, J.f + 20000);
          this._fixNormals(e, J.touched.slice(J.f, end), false);
          J.f = end;
          if (performance.now() - t0 > 5 && J.f < J.touched.length) return false;
        }
        if (J.touched.length) {
          this._upload(e);
          for (const d of this.decals) if (d.e === e) this._rebuild(d);
        }
        ei++;
        if (performance.now() - t0 > 5) return ei >= jobs.length;
      }
      return true;
    };
  }

  _fixNormals(e, touched, upload = true) {
    const a = e.pos, nA = e.nrm, tri = e.tri, n = a.length / 3;
    if (!e.stamp) { e.stamp = new Uint32Array(n); e.stampId = 0; e.vlist = new Uint32Array(n); }
    const id = ++e.stampId;
    let cnt = 0;
    for (const v of touched) {
      for (let k = e.deg[v]; k < e.deg[v + 1]; k++) {
        const t = e.adj[k] * 3;
        for (let c = 0; c < 3; c++) { const u = tri[t + c]; if (e.stamp[u] !== id) { e.stamp[u] = id; e.vlist[cnt++] = u; } }
      }
    }
    for (let j = 0; j < cnt; j++) {
      const v = e.vlist[j];
      let sx = 0, sy = 0, sz = 0;
      for (let k = e.deg[v]; k < e.deg[v + 1]; k++) {
        const t = e.adj[k];
        const i0 = tri[t * 3] * 3, i1 = tri[t * 3 + 1] * 3, i2 = tri[t * 3 + 2] * 3;
        const ux = a[i1] - a[i0], uy = a[i1 + 1] - a[i0 + 1], uz = a[i1 + 2] - a[i0 + 2];
        const wx = a[i2] - a[i0], wy = a[i2 + 1] - a[i0 + 1], wz = a[i2 + 2] - a[i0 + 2];
        sx += uy * wz - uz * wy; sy += uz * wx - ux * wz; sz += ux * wy - uy * wx;
      }
      const l = Math.hypot(sx, sy, sz);
      if (l < 1e-12) continue;
      const s = sx * e.origN[v * 3] + sy * e.origN[v * 3 + 1] + sz * e.origN[v * 3 + 2] < 0 ? -1 : 1;
      nA[v * 3] = s * sx / l; nA[v * 3 + 1] = s * sy / l; nA[v * 3 + 2] = s * sz / l;
    }
    if (upload) this._upload(e);
  }
  _upload(e) {
    const g = e.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    if (g.computeBoundingSphere) g.computeBoundingSphere();
  }

  // closest point on the car surface (glass or body triangles) to a physics-frame point
  _closest(p, maxDist, wantGlass) {
    let best = null, bd = maxDist * maxDist;
    for (const e of this.entries) {
      const c = this._pt(e, p), a = e.pos, tri = e.tri, nA = e.nrm;
      nearTris(e, c, maxDist + e.maxEdge + MOVE, (t) => {
        if (e.triGlass[t] !== wantGlass) return;
        const i0 = tri[t * 3] * 3, i1 = tri[t * 3 + 1] * 3, i2 = tri[t * 3 + 2] * 3;
        const qx = a[i0] - c[0], qy = a[i0 + 1] - c[1], qz = a[i0 + 2] - c[2], lim = Math.sqrt(bd) + e.maxEdge;
        if (qx * qx + qy * qy + qz * qz > lim * lim) return;
        const A = [a[i0], a[i0 + 1], a[i0 + 2]], B = [a[i1], a[i1 + 1], a[i1 + 2]], C = [a[i2], a[i2 + 1], a[i2 + 2]];
        const q = closestOnTri(c, A, B, C), dx = q[0] - c[0], dy = q[1] - c[1], dz = q[2] - c[2], d = dx * dx + dy * dy + dz * dz;
        if (d >= bd) return;
        const vn = norm([nA[i0] + nA[i1] + nA[i2], nA[i0 + 1] + nA[i1 + 1] + nA[i2 + 1], nA[i0 + 2] + nA[i1 + 2] + nA[i2 + 2]]);
        let fn = norm(cross(sub(B, A), sub(C, A)));
        if (dot(fn, vn) < 0) fn = fn.map((v) => -v);
        bd = d; best = { e, point: q, normal: fn };
      });
    }
    return best;
  }

  // Project a decal onto the mesh's triangles (only glass ones, or only body ones). Every decal vertex
  // remembers its source triangle and barycentric weights, so it follows the panel when it is dented later.
  _project(e, center, normal, xAxis, sx, sy, depth, glass, material) {
    const yAxis = norm(cross(normal, xAxis));
    const tri = e.tri, a = e.pos, nA = e.nrm;
    const bind = [], wts = [], uvs = [], sgn = [];
    const hx = sx / 2, hy = sy / 2, hz = depth / 2, reach = Math.hypot(hx, hy, hz);
    nearTris(e, center, reach + e.maxEdge + MOVE, (t) => {
      if (e.triGlass[t] !== glass) return;
      const i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
      { const qx = a[i0 * 3] - center[0], qy = a[i0 * 3 + 1] - center[1], qz = a[i0 * 3 + 2] - center[2], lim = reach + e.maxEdge;
        if (qx * qx + qy * qy + qz * qz > lim * lim) return; }
      const P = [i0, i1, i2].map((i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]);
      const D = P.map((p) => { const r = sub(p, center); return [dot(r, xAxis), dot(r, yAxis), dot(r, normal)]; });
      let out = false;
      for (let ax = 0; ax < 3 && !out; ax++) {
        const h = ax === 0 ? hx : ax === 1 ? hy : hz;
        if (D[0][ax] > h && D[1][ax] > h && D[2][ax] > h) out = true;
        if (D[0][ax] < -h && D[1][ax] < -h && D[2][ax] < -h) out = true;
      }
      if (out) return;
      // only surfaces facing the decal direction (not the inside of the panel or the far side)
      const vn = [nA[i0 * 3] + nA[i1 * 3] + nA[i2 * 3], nA[i0 * 3 + 1] + nA[i1 * 3 + 1] + nA[i2 * 3 + 1], nA[i0 * 3 + 2] + nA[i1 * 3 + 2] + nA[i2 * 3 + 2]];
      if (dot(norm(vn), normal) < 0.25) return;
      const fn = cross(sub(P[1], P[0]), sub(P[2], P[0]));
      const s = dot(fn, vn) < 0 ? -1 : 1;
      let poly = [{ d: D[0], w: [1, 0, 0] }, { d: D[1], w: [0, 1, 0] }, { d: D[2], w: [0, 0, 1] }];
      poly = clipPoly(poly, 0, 1, hx); if (poly.length < 3) return;
      poly = clipPoly(poly, 0, -1, hx); if (poly.length < 3) return;
      poly = clipPoly(poly, 1, 1, hy); if (poly.length < 3) return;
      poly = clipPoly(poly, 1, -1, hy); if (poly.length < 3) return;
      poly = clipPoly(poly, 2, 1, hz); if (poly.length < 3) return;
      poly = clipPoly(poly, 2, -1, hz); if (poly.length < 3) return;
      for (let k = 1; k + 1 < poly.length; k++) {
        for (const v of [poly[0], poly[k], poly[k + 1]]) {
          bind.push(t); wts.push(v.w[0], v.w[1], v.w[2]); sgn.push(s);
          uvs.push(v.d[0] / sx + 0.5, v.d[1] / sy + 0.5);
        }
      }
    });
    if (!bind.length) return null;
    const n = bind.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    const mesh = new THREE.Mesh(geo, material);
    mesh.renderOrder = 1;
    mesh.castShadow = false; mesh.receiveShadow = true;
    const d = { e, mesh, bind: Uint32Array.from(bind), w: Float32Array.from(wts), sgn: Int8Array.from(sgn), center, glass };
    this._rebuild(d);
    e.mesh.add(mesh);
    this.decals.push(d);
    while (this.decals.length > 80) this._remove(this.decals.shift());
    return d;
  }

  _rebuild(d) {
    const e = d.e, a = e.pos, tri = e.tri;
    const P = d.mesh.geometry.attributes.position, N = d.mesh.geometry.attributes.normal;
    const pa = P.array, na = N.array;
    for (let k = 0; k < d.bind.length; k++) {
      const t = d.bind[k];
      const i0 = tri[t * 3] * 3, i1 = tri[t * 3 + 1] * 3, i2 = tri[t * 3 + 2] * 3;
      const w0 = d.w[k * 3], w1 = d.w[k * 3 + 1], w2 = d.w[k * 3 + 2];
      const ux = a[i1] - a[i0], uy = a[i1 + 1] - a[i0 + 1], uz = a[i1 + 2] - a[i0 + 2];
      const vx = a[i2] - a[i0], vy = a[i2 + 1] - a[i0 + 1], vz = a[i2 + 2] - a[i0 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = (Math.hypot(nx, ny, nz) || 1) * d.sgn[k];
      nx /= l; ny /= l; nz /= l;
      for (let c = 0; c < 3; c++) pa[k * 3 + c] = w0 * a[i0 + c] + w1 * a[i1 + c] + w2 * a[i2 + c];
      pa[k * 3] += nx * 0.004; pa[k * 3 + 1] += ny * 0.004; pa[k * 3 + 2] += nz * 0.004;
      na[k * 3] = nx; na[k * 3 + 1] = ny; na[k * 3 + 2] = nz;
    }
    P.needsUpdate = true; N.needsUpdate = true;
    if (d.mesh.geometry.computeBoundingSphere) d.mesh.geometry.computeBoundingSphere();
  }

  _remove(d) {
    if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
    if (d.mesh.geometry.dispose) d.mesh.geometry.dispose();
  }

  _crowded(e, c, glass, r) {
    let n = 0;
    for (const d of this.decals) if (d.e === e && d.glass === glass && Math.hypot(d.center[0] - c[0], d.center[1] - c[1], d.center[2] - c[2]) < r) n++;
    return n;
  }

  // scraped paint at a physics-frame point; t = sliding direction (physics frame) or null
  scratch(p, t, size = 0.7) {
    const hit = this._closest(p, 0.7, 0);
    if (!hit) return null;
    const e = hit.e, c = hit.point, nrm = hit.normal;
    if (this._crowded(e, c, 0, 0.2) >= 2) return null;
    let x = t ? this._dir(e, t) : norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    x = sub(x, nrm.map((v) => v * dot(x, nrm)));
    if (Math.hypot(...x) < 1e-3) x = cross(nrm, Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    x = norm(x);
    return this._project(e, c, nrm, x, size, size * 0.45, 0.3, 0, this.scratchMaterial);
  }

  // chipped, scratched paint where the body crumpled (physics-frame point; finds the surface within 0.9 m)
  chip(p, size = 0.6) {
    const hit = this._closest(p, 0.9, 0);
    if (!hit) return null;
    const e = hit.e, c = hit.point, nrm = hit.normal;
    if (this._crowded(e, c, 0, size * 0.45) >= 3) return null;
    let x = norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    x = sub(x, nrm.map((v) => v * dot(x, nrm)));
    if (Math.hypot(...x) < 1e-3) x = cross(nrm, Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    x = norm(x);
    const mat = this.chipMaterials[Math.floor(Math.random() * this.chipMaterials.length)];
    return this._project(e, c, nrm, x, size, size * (0.6 + Math.random() * 0.5), 0.4, 0, mat);
  }

  // cracked glass near a physics-frame point (headlights, windscreen, side windows)
  crack(p, severity, reach) {
    const hit = this._closest(p, reach, 1);
    if (!hit) return null;
    const e = hit.e, c = hit.point, nrm = hit.normal;
    if (this._crowded(e, c, 1, 0.3) >= 1) return null;
    const x = norm(cross(nrm, Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const ang = Math.random() * Math.PI * 2, y = cross(nrm, x);
    const xr = norm([x[0] * Math.cos(ang) + y[0] * Math.sin(ang), x[1] * Math.cos(ang) + y[1] * Math.sin(ang), x[2] * Math.cos(ang) + y[2] * Math.sin(ang)]);
    const size = 0.5 + 0.6 * Math.min(severity, 1);
    return this._project(e, c, nrm, xr, size, size, 0.35, 1, this.crackMaterial);
  }

  repair() {
    for (const e of this.entries) {
      e.pos.set(e.orig); e.nrm.set(e.origN);
      const g = e.mesh.geometry;
      g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
      if (g.computeBoundingSphere) g.computeBoundingSphere();
    }
    for (const d of this.decals) this._remove(d);
    this.decals.length = 0;
  }
}
