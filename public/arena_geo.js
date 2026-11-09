// arena_geo.js — small geometry kit for the arena (no three.js geometry classes needed): a builder that collects
// vertices / normals / uvs / indices, primitives (box, cylinder, lathe, arch bay, disc) and placing copies.
// Coordinates: y up. "Polar" placement: angle θ, world x = r·sinθ, z = r·cosθ; local z = outward, local x = tangent.

export class Geo {
  constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, nx, ny, nz, u, v) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  // triangle with the winding that matches the wanted normal
  tri(a, b, c, nx, ny, nz) {
    const P = this.p;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  quad(a, b, c, d, nx, ny, nz) { this.tri(a, b, c, nx, ny, nz); this.tri(a, c, d, nx, ny, nz); }

  // flat quad from 4 corners (in order around), normal given
  face(c, n, uvs) {
    const k = c.map((q, j) => this.vert(q[0], q[1], q[2], n[0], n[1], n[2], uvs[j][0], uvs[j][1]));
    this.quad(k[0], k[1], k[2], k[3], n[0], n[1], n[2]);
  }

  // axis-aligned box (before placement). uvScale: metres per texture repeat
  box(cx, cy, cz, sx, sy, sz, uvScale = 1, faces = 'all') {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const s = 1 / uvScale;
    const F = {
      px: [[[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [1, 0, 0], [[z0 * s, y0 * s], [z1 * s, y0 * s], [z1 * s, y1 * s], [z0 * s, y1 * s]]],
      nx: [[[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], [-1, 0, 0], [[z1 * s, y0 * s], [z0 * s, y0 * s], [z0 * s, y1 * s], [z1 * s, y1 * s]]],
      py: [[[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], [[x0 * s, z0 * s], [x1 * s, z0 * s], [x1 * s, z1 * s], [x0 * s, z1 * s]]],
      ny: [[[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], [0, -1, 0], [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]]],
      pz: [[[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], [0, 0, 1], [[x1 * s, y0 * s], [x0 * s, y0 * s], [x0 * s, y1 * s], [x1 * s, y1 * s]]],
      nz: [[[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], [[x0 * s, y0 * s], [x1 * s, y0 * s], [x1 * s, y1 * s], [x0 * s, y1 * s]]],
    };
    for (const k of Object.keys(F)) if (faces === 'all' || faces.includes(k)) this.face(F[k][0], F[k][1], F[k][2]);
    return this;
  }

  // vertical cylinder / cone frustum along y (smooth sides), optional caps
  cylinder(cx, cy0, cz, r0, r1, h, segs = 16, caps = true, uvScale = 1, uRepeat = 1) {
    const base = this.count, slope = (r0 - r1) / h, ny = slope / Math.hypot(1, slope), nl = 1 / Math.hypot(1, slope);
    for (let k = 0; k <= segs; k++) {
      const a = k / segs * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      this.vert(cx + s * r0, cy0, cz + c * r0, s * nl, ny, c * nl, k / segs * uRepeat, 0);
      this.vert(cx + s * r1, cy0 + h, cz + c * r1, s * nl, ny, c * nl, k / segs * uRepeat, h / uvScale);
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 2, am = (k + 0.5) / segs * Math.PI * 2;
      this.quad(a, a + 2, a + 3, a + 1, Math.sin(am), 0, Math.cos(am));
    }
    if (caps) {
      for (const [y, r, up] of [[cy0 + h, r1, 1], [cy0, r0, -1]]) {
        if (r <= 1e-4) continue;
        const c0 = this.vert(cx, y, cz, 0, up, 0, 0.5, 0.5);
        const ring = [];
        for (let k = 0; k <= segs; k++) {
          const a = k / segs * Math.PI * 2;
          ring.push(this.vert(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r, 0, up, 0, 0.5 + Math.sin(a) * 0.5, 0.5 + Math.cos(a) * 0.5));
        }
        for (let k = 0; k < segs; k++) this.tri(c0, ring[k], ring[k + 1], 0, up, 0);
      }
    }
    return this;
  }

  // surface of revolution around y. prof: [[r, y], ...]. Each profile segment gets its own (flat) normal:
  // n = (-dy, dr) in the (r, y) plane — walking the profile inside→out / bottom→top it faces the centre / up.
  // smooth: share normals between segments (round shapes). uv: u = arc length / uScale, v = profile length / vScale
  lathe(prof, segs, a0 = 0, a1 = Math.PI * 2, { cx = 0, cz = 0, uScale = 1, vScale = 1, smooth = false, flip = false } = {}) {
    const m = prof.length;
    const segN = [];
    for (let j = 0; j < m - 1; j++) {
      let dr = prof[j + 1][0] - prof[j][0], dy = prof[j + 1][1] - prof[j][1];
      const l = Math.hypot(dr, dy) || 1;
      segN.push(flip ? [dy / l, -dr / l] : [-dy / l, dr / l]);
    }
    const vAcc = [0];
    for (let j = 0; j < m - 1; j++) vAcc.push(vAcc[j] + Math.hypot(prof[j + 1][0] - prof[j][0], prof[j + 1][1] - prof[j][1]));
    const ang = (k) => a0 + (a1 - a0) * k / segs;
    if (smooth) {
      const vn = prof.map((_, j) => {
        const A = segN[Math.max(0, j - 1)], B = segN[Math.min(m - 2, j)];
        const x = A[0] + B[0], y = A[1] + B[1], l = Math.hypot(x, y) || 1;
        return [x / l, y / l];
      });
      const base = this.count;
      for (let k = 0; k <= segs; k++) {
        const a = ang(k), s = Math.sin(a), c = Math.cos(a);
        for (let j = 0; j < m; j++) {
          const [r, y] = prof[j];
          this.vert(cx + s * r, y, cz + c * r, s * vn[j][0], vn[j][1], c * vn[j][0], a * r / uScale, vAcc[j] / vScale);
        }
      }
      for (let k = 0; k < segs; k++) for (let j = 0; j < m - 1; j++) {
        const a = base + k * m + j, b = a + m, am = ang(k + 0.5);
        const N = segN[j];
        this.quad(a, b, b + 1, a + 1, Math.sin(am) * N[0], N[1], Math.cos(am) * N[0]);
      }
    } else {
      for (let j = 0; j < m - 1; j++) {
        const N = segN[j], base = this.count;
        const [r0, y0] = prof[j], [r1, y1] = prof[j + 1];
        for (let k = 0; k <= segs; k++) {
          const a = ang(k), s = Math.sin(a), c = Math.cos(a);
          this.vert(cx + s * r0, y0, cz + c * r0, s * N[0], N[1], c * N[0], a * (r0 + r1) / 2 / uScale, vAcc[j] / vScale);
          this.vert(cx + s * r1, y1, cz + c * r1, s * N[0], N[1], c * N[0], a * (r0 + r1) / 2 / uScale, vAcc[j + 1] / vScale);
        }
        for (let k = 0; k < segs; k++) {
          const a = base + k * 2, am = ang(k + 0.5);
          this.quad(a, a + 2, a + 3, a + 1, Math.sin(am) * N[0], N[1], Math.cos(am) * N[0]);
        }
      }
    }
    return this;
  }

  // flat disc (or ring) in the xz plane at height y, facing up. uv from a function (x, z) -> [u, v]
  disc(r0, r1, segs, rings, y, uvf) {
    const base = this.count;
    for (let j = 0; j <= rings; j++) {
      const r = r0 + (r1 - r0) * j / rings;
      for (let k = 0; k <= segs; k++) {
        const a = k / segs * Math.PI * 2, x = Math.sin(a) * r, z = Math.cos(a) * r;
        const [u, v] = uvf(x, z);
        this.vert(x, y, z, 0, 1, 0, u, v);
      }
    }
    for (let j = 0; j < rings; j++) for (let k = 0; k < segs; k++) {
      const a = base + j * (segs + 1) + k, b = a + segs + 1;
      this.quad(a, a + 1, b + 1, b, 0, 1, 0);
    }
    return this;
  }

  // Wall bay with an arched opening, in local coords: width w along x (centred), height h, front face at z = 0
  // facing −z, back face at z = d. Opening: width 2a, arch springs at ys. uvScale metres per repeat.
  archBay(w, h, d, a, ys, segs = 12, uvScale = 4, { back = true, soffit = true } = {}) {
    const s = 1 / uvScale, W = w / 2;
    const ring = [];
    for (let k = 0; k <= segs; k++) { const f = Math.PI * (1 - k / segs); ring.push([Math.cos(f) * a, ys + Math.sin(f) * a]); }
    for (const [z, nz] of back ? [[0, -1], [d, 1]] : [[0, -1]]) {
      const V = (x, y) => this.vert(x, y, z, 0, 0, nz, x * s, y * s);
      // piers below the springing line
      this.quad(V(-W, 0), V(-a, 0), V(-a, ys), V(-W, ys), 0, 0, nz);
      this.quad(V(a, 0), V(W, 0), V(W, ys), V(a, ys), 0, 0, nz);
      // spandrels: fans from the arch to the top corners
      const TL = V(-W, h), TR = V(W, h), BL = V(-W, ys), BR = V(W, ys);
      const R = ring.map(([x, y]) => V(x, y));
      const mid = segs / 2;
      this.tri(BL, R[0], TL, 0, 0, nz);
      for (let k = 0; k < mid; k++) this.tri(R[k], R[k + 1], TL, 0, 0, nz);
      this.tri(TL, R[mid], TR, 0, 0, nz);
      for (let k = mid; k < segs; k++) this.tri(R[k], R[k + 1], TR, 0, 0, nz);
      this.tri(R[segs], BR, TR, 0, 0, nz);
    }
    if (soffit) {
      // inside of the arch and the jambs (facing into the opening)
      for (let k = 0; k < segs; k++) {
        const [x0, y0] = ring[k], [x1, y1] = ring[k + 1];
        const mx = -(x0 + x1) / 2, my = ys - (y0 + y1) / 2, ml = Math.hypot(mx, my) || 1;
        const v0 = this.vert(x0, y0, 0, mx / ml, my / ml, 0, k / segs * Math.PI * a * s, 0);
        const v1 = this.vert(x1, y1, 0, mx / ml, my / ml, 0, (k + 1) / segs * Math.PI * a * s, 0);
        const v2 = this.vert(x1, y1, d, mx / ml, my / ml, 0, (k + 1) / segs * Math.PI * a * s, d * s);
        const v3 = this.vert(x0, y0, d, mx / ml, my / ml, 0, k / segs * Math.PI * a * s, d * s);
        this.quad(v0, v1, v2, v3, mx / ml, my / ml, 0);
      }
      for (const [x, nx] of [[-a, 1], [a, -1]]) {
        const v0 = this.vert(x, 0, 0, nx, 0, 0, 0, 0), v1 = this.vert(x, ys, 0, nx, 0, 0, 0, ys * s);
        const v2 = this.vert(x, ys, d, nx, 0, 0, d * s, ys * s), v3 = this.vert(x, 0, d, nx, 0, 0, d * s, 0);
        this.quad(v0, v1, v2, v3, nx, 0, 0);
      }
    }
    return this;
  }

  // add a copy of g: scaled (s or [sx,sy,sz]), turned by ry around y, moved to (x, y, z)
  add(g, x = 0, y = 0, z = 0, ry = 0, s = 1) {
    const sx = Array.isArray(s) ? s[0] : s, sy = Array.isArray(s) ? s[1] : s, sz = Array.isArray(s) ? s[2] : s;
    const c = Math.cos(ry), sn = Math.sin(ry), base = this.count;
    const P = g.p, N = g.n;
    for (let k = 0; k < P.length; k += 3) {
      const px = P[k] * sx, py = P[k + 1] * sy, pz = P[k + 2] * sz;
      this.p.push(x + px * c + pz * sn, y + py, z - px * sn + pz * c);
      let nx = N[k] / sx, ny = N[k + 1] / sy, nz = N[k + 2] / sz;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      this.n.push(nx * c + nz * sn, ny, -nx * sn + nz * c);
    }
    for (const u of g.uv) this.uv.push(u);
    for (const i of g.i) this.i.push(i + base);
    return this;
  }
  // place a copy at polar angle th and radius r (local z → outward), lifted by y
  addPolar(g, th, r, y = 0, s = 1, local = [0, 0]) {
    const sx = Math.sin(th), cz = Math.cos(th);
    const x = sx * r + Math.cos(th) * local[0], z = cz * r - Math.sin(th) * local[0];
    return this.add(g, x, y, z, th, s);
  }

  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(new THREE.BufferAttribute(this.count > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), 1));
    if (g.computeBoundingSphere) g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------- noise
export function makeNoise(seed = 1) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = new Float32Array(512);
  for (let i = 0; i < 512; i++) G[i] = perm[i] / 255 * 2 - 1;
  const fade = (t) => t * t * (3 - 2 * t);
  // tileable value noise (period in cells)
  function noise(x, y, period = 256) {
    const xi = Math.floor(x), yi = Math.floor(y), tx = fade(x - xi), ty = fade(y - yi);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const h = (a, b) => G[perm[(a & 255) + perm[b & 255]]];
    const a = h(x0, y0), b = h(x1, y0), c = h(x0, y1), d = h(x1, y1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
  function fbm(x, y, oct = 4, period = 256) {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < oct; o++) { v += amp * noise(x * f, y * f, period * f); amp *= 0.5; f *= 2; }
    return v;
  }
  return { noise, fbm, rnd };
}
