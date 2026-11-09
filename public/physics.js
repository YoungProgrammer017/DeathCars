// physics.js — vehicle dynamics for the racing game. No dependencies.
// Coordinate system: +Y up, car local +Z forward, +X left (matches the GLB models).
// Units: metres, kilograms, seconds, newtons, radians.

export const GRAVITY = 9.81;
const RPM_TO_RAD = Math.PI / 30;

// ---------------------------------------------------------------------------
// Worlds: something that answers "how high is the ground here" and
// "how far is the nearest wall" (signed distance, negative = inside a wall).
// ---------------------------------------------------------------------------
export class GridWorld {
  // bytes: per cell [height in cm, signed-distance code], `stride` bytes apart (2 for the packed grid, 4 for RGBA)
  constructor(meta, bytes, stride = 2) {
    this.meta = meta;
    this.cell = meta.cell;
    this.ox = meta.originX;
    this.oz = meta.originZ;
    this.w = meta.width;
    this.hgt = meta.height;
    const n = this.w * this.hgt;
    this.H = new Float32Array(n);
    this.D = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.H[i] = bytes[i * stride] / 100;
      this.D[i] = (bytes[i * stride + 1] - 128) * meta.sdfUnit;
    }
  }
  _sample(arr, x, z, outside) {
    const fx = (x - this.ox) / this.cell - 0.5;
    const fz = (z - this.oz) / this.cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= this.w - 1 || fz >= this.hgt - 1) return outside;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const i = iz * this.w + ix;
    const a = arr[i] + (arr[i + 1] - arr[i]) * tx;
    const b = arr[i + this.w] + (arr[i + this.w + 1] - arr[i + this.w]) * tx;
    return a + (b - a) * tz;
  }
  height(x, z) { return this._sample(this.H, x, z, 0); }
  sdf(x, z) { return this._sample(this.D, x, z, -1); }
}

// Flat test world, optionally with a wall plane (x >= wallX is solid) and a curb (x >= curbX is raised).
export class FlatWorld {
  constructor({ wallX = null, curbX = null, curbH = 0.2 } = {}) {
    this.cell = 0.25; this.wallX = wallX; this.curbX = curbX; this.curbH = curbH;
  }
  height(x, z) {
    if (this.curbX === null) return 0;
    const t = Math.min(Math.max((x - this.curbX) / 0.25 + 0.5, 0), 1);
    return t * this.curbH;
  }
  sdf(x, z) { return this.wallX === null ? 6 : Math.min(this.wallX - x, 6); }
}

// Round arena: flat floor, a solid wall all round at `radius` (everything outside is wall, so nothing can get
// through it however hard it hits). Exact distances, exact normals (radial).
export class ArenaWorld {
  constructor(radius) { this.radius = radius; this.cell = 0.25; }
  height(x, z) { return 0; }
  sdf(x, z) { return this.radius - Math.hypot(x, z); }
}

function groundNormal(world, x, z, out) {
  const e = world.cell || 0.25;
  const dx = (world.height(x + e, z) - world.height(x - e, z)) / (2 * e);
  const dz = (world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  out[0] = -dx / l; out[1] = 1 / l; out[2] = -dz / l;
}

function sdfGradient(world, x, z, out, e = 0.2) {
  const gx = world.sdf(x + e, z) - world.sdf(x - e, z);
  const gz = world.sdf(x, z + e) - world.sdf(x, z - e);
  const l = Math.hypot(gx, gz);
  if (l < 1e-9) { out[0] = 0; out[1] = 0; out[2] = 0; return false; }
  out[0] = gx / l; out[1] = 0; out[2] = gz / l;
  return true;
}

// ---------------------------------------------------------------------------
// Small math helpers (allocation-free in hot paths)
// ---------------------------------------------------------------------------
function qRotate(q, vx, vy, vz, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}
function qRotateInv(q, vx, vy, vz, out) {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerpTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

// ---------------------------------------------------------------------------
// Car specification: Ferrari F599 GTB (figures close to the real car)
// ---------------------------------------------------------------------------
export const F599 = {
  name: 'Ferrari F599 GTB (tuned, AWD)',
  mass: 1765,                      // kg, with driver and fuel
  inertia: [2600, 2850, 600],      // pitch (x), yaw (y), roll (z) — kg·m²
  com: [0, 0.28, -0.013],          // centre of mass in model coordinates (47/53 split); very low (ballast in the floor) so ~2 g of grip can't roll it
  halfExtents: [0.99, 0.66, 2.31], // body box for wall/ground contacts
  bodyBottom: 0.13,                // ground clearance of the body (model coords)
  bodyTop: 1.30,
  wheels: [
    { node: 'Wheel_FL', pos: [0.818, 0.348, 1.443], radius: 0.339, inertia: 1.3, mass: 40, front: true, side: 1 },
    { node: 'Wheel_FR', pos: [-0.818, 0.348, 1.443], radius: 0.339, inertia: 1.3, mass: 40, front: true, side: -1 },
    { node: 'Wheel_RL', pos: [0.800, 0.365, -1.304], radius: 0.364, inertia: 1.6, mass: 45, front: false, side: 1 },
    { node: 'Wheel_RR', pos: [-0.800, 0.365, -1.304], radius: 0.364, inertia: 1.6, mass: 45, front: false, side: -1 },
  ],
  suspension: {
    staticLength: 0.15, travelUp: 0.12, travelDown: 0.10,
    tireK: 240000, tireC: 1500,    // tyre vertical stiffness / damping
    // soft road setup: ~1.35 Hz ride, long travel — rides over curbs instead of bouncing off them
    front: { k: 30000, bump: 2400, rebound: 3800, arb: 20000 },
    rear: { k: 34000, bump: 2700, rebound: 4200, arb: 12000 },
    bumpStopK: 250000,
  },
  tire: {
    mu: 2.4, frontGrip: 1.04, rearGrip: 1.07, // arcade-grippy race slicks; rear tyres are wider (keeps the extra power in check)
    peakSlipRatio: 0.11,
    peakSlipAngleFront: 7.0 * Math.PI / 180,
    peakSlipAngleRear: 6.5 * Math.PI / 180,
    shapeC: 1.3,                   // Pacejka shape; sliding grip ≈ 89% of peak (grip doesn't fall off a cliff)
    shapeCFront: 1.3,
    loadSensitivity: -0.12, nominalLoad: 4300,
    rollingResistance: 0.013,
    longGrip: 1.35,                // drag-style compound: 35% more grip along the tyre (launch/braking) than sideways
    lowSpeed: 3.0,                 // m/s, slip denominator floor (keeps low-speed maths stable)
  },
  engine: {
    idle: 1000, redline: 8400, limiter: 8500, inertia: 0.25, launchRpm: 4200,
    // heavily tuned V12: stock curve × 1.885 (≈ 1150 hp) — about 40% quicker than the 800 hp version
    torque: [[1000, 300], [2000, 420], [3000, 500], [4000, 560], [5000, 600], [5600, 608],
             [6500, 595], [7600, 573], [8400, 520], [8600, 480]].map(([r, t]) => [r, t * 1.885]),
    engineBrake: [25, 0.012],      // Nm = -(a + b·rpm) when off throttle
  },
  gearbox: {
    ratios: [3.15, 2.18, 1.57, 1.19, 0.94, 0.76], reverse: 3.0, final: 4.55, efficiency: 0.9,
    // engine map limits torque in 1st and reverse so the tyres can put it down (no wheelspin, no electronics)
    torqueLimit: [0.80, 1, 1, 1, 1, 1], reverseTorqueLimit: 0.6,
    shiftTime: 0.12,
  },
  // all-wheel drive: centre diff sends 30% front / 70% rear (weight moves to the rear when launching hard),
  // viscous coupling evens out axle speeds
  drive: { frontShare: 0.3, center: { preload: 150, lockRatio: 0.5, stiffness: 400 },
           front: { preload: 30, lockRatio: 0.1, stiffness: 60 }, rear: { preload: 80, lockRatio: 0.35, stiffness: 150 } },
  // no ABS: brake torque is sized so a full stop sits right at the tyres' grip limit without locking
  brakes: { front: 4500, rear: 2000, handbrake: 6000 },
  steering: { lock: 0.56, rate: 6.0, returnRate: 9.0 }, // 32° at the wheels; full lock in ~0.17 s
  aero: { cdA: 0.336 * 2.0, clA: 0.15 * 2.0, rho: 1.225 },
};

// Datsun 240K GT (1972), built as the hunter's car. Same weight, power and tyres as the Ferrari so the chase stays
// fair; its own size, wheel positions and smaller wheels (final drive and brakes scaled so the forces match).
const _wr = 0.297;                                   // wheel radius
export const DATSUN = {
  ...F599,
  name: 'Datsun 240K GT (hunter build)',
  inertia: [2000, 2200, 460],                        // shorter and narrower than the Ferrari
  com: [0, 0.23, 0.07],                              // narrower track → keep the centre of mass even lower so it can't roll
  halfExtents: [0.86, 0.56, 2.06],
  bodyBottom: 0.14,
  bodyTop: 1.25,
  wheels: [
    { node: 'Wheel_FL', pos: [0.6605, 0.2989, 1.2817], radius: _wr, inertia: 1.1, mass: 36, front: true, side: 1 },
    { node: 'Wheel_FR', pos: [-0.6605, 0.2989, 1.2817], radius: _wr, inertia: 1.1, mass: 36, front: true, side: -1 },
    { node: 'Wheel_RL', pos: [0.6605, 0.2989, -1.1313], radius: _wr, inertia: 1.2, mass: 38, front: false, side: 1 },
    { node: 'Wheel_RR', pos: [-0.6605, 0.2989, -1.1313], radius: _wr, inertia: 1.2, mass: 38, front: false, side: -1 },
  ],
  gearbox: { ...F599.gearbox, final: F599.gearbox.final * _wr / 0.364 },
  brakes: { front: Math.round(F599.brakes.front * _wr / 0.339), rear: Math.round(F599.brakes.rear * _wr / 0.364), handbrake: Math.round(F599.brakes.handbrake * _wr / 0.364) },
};

export const CAR_SPECS = { f599: F599, datsun: DATSUN };

// Physics spec of a car from its measured geometry (wheel pivots/radii, body bounds) and its stats (see cars.js).
// The body for contacts when the car isn't on its wheels: the outline (dented) as a prism from the floor up to the
// top line top(z) (bonnet, windscreen, roof, boot), its sides leaning in from the shoulder (ys) to the roof (hwTop).
function bodyShape(geo, comH, comZ) {
  const g = geo.shape, yb = Math.max(geo.lo[1], 0.08) - comH;
  if (g) return { z: g.z.map((z) => z - comZ), top: g.top.map((t) => t - comH), ys: g.ys - comH, roof: g.roof - comH, hwTop: g.hwTop, yb };
  const top = Math.max(geo.hi[1], comH + 0.5) - comH;
  return { z: [geo.lo[2] - comZ, geo.hi[2] - comZ], top: [top, top], ys: top - 0.3, roof: top, hwTop: 0.75 * geo.hi[0], yb };
}

// Everything is scaled from the reference car (F599 tuning) so cars differ only where the stats say so.
function scaleAxle(a, k) { return { k: a.k * k, bump: a.bump * Math.sqrt(k) * Math.sqrt(k), rebound: a.rebound * k, arb: a.arb * k }; }
export function makeSpec(id, geo, st) {
  const B = F599, k = st.mass / B.mass;
  const W = geo.wheels, fl = W.FL, rl = W.RL;
  const len = geo.hi[2] - geo.lo[2], width = geo.hi[0] - geo.lo[0], height = geo.hi[1] - geo.lo[1];
  const track = Math.min(2 * fl.p[0], 2 * rl.p[0]);
  // centre of mass: low enough for the narrowest track not to roll over at ~2 g (same margin as the reference car)
  const comH = clamp(0.17 * track, 0.17, 0.42);
  const comZ = (fl.p[2] + rl.p[2]) / 2 + (st.engine === 'rear' ? -0.15 : st.engine === 'mid' ? -0.05 : 0.08);
  const wheels = ['FL', 'FR', 'RL', 'RR'].map((n) => {
    const w = W[n];
    return { node: 'Wheel_' + n, pos: w.p.slice(), radius: w.r, inertia: 1.4 * (w.r / 0.34) ** 2 * Math.sqrt(k),
      mass: 40 * Math.sqrt(k), front: n[0] === 'F', side: n[1] === 'L' ? 1 : -1 };
  });
  const iF = 0.77 * st.mass / 12;
  return {
    ...B, id, name: st.name, mass: st.mass, layout: st.engine || 'front', armor: st.armor || 1,
    inertia: [iF * (len * len + 0.6 * height * height), iF * (len * len + width * width), iF * (width * width + 0.6 * height * height)],
    com: [0, comH, comZ],
    halfExtents: [width / 2, Math.min(height / 2, 0.8), len / 2],
    // the body's real footprint around the centre of mass (which sits off the middle): x0, x1 (right, left), z0, z1 (rear, front)
    // (a push bar sticks out a little in front)
    outline: [geo.lo[0], geo.hi[0], geo.lo[2] - comZ, geo.hi[2] - comZ + (st.pushBar ? 0.14 : 0)],
    bodyFront: geo.hi[2] - comZ,
    bodyBottom: Math.max(geo.lo[1], 0.08),
    bodyTop: Math.max(geo.hi[1], comH + 0.5),
    // the body's shape for roll-overs: the top line along the car and the sides leaning in above the shoulder
    shape: bodyShape(geo, comH, comZ),
    wheels,
    suspension: { ...B.suspension, front: scaleAxle(B.suspension.front, k), rear: scaleAxle(B.suspension.rear, k),
      bumpStopK: B.suspension.bumpStopK * k, tireK: B.suspension.tireK * k, tireC: B.suspension.tireC * Math.sqrt(k) },
    tire: { ...B.tire, mu: B.tire.mu * st.grip, nominalLoad: B.tire.nominalLoad * k },
    // power-to-weight sets the acceleration; the final drive follows the wheel size so the gears feel the same
    engine: { ...B.engine, torque: B.engine.torque.map(([r, t]) => [r, t * st.accel * k]),
      engineBrake: [B.engine.engineBrake[0] * k, B.engine.engineBrake[1] * k] },
    gearbox: { ...B.gearbox, final: B.gearbox.final * rl.r / 0.364 },
    vmax: st.top / 3.6,
    brakes: { front: B.brakes.front * k * fl.r / 0.339, rear: B.brakes.rear * k * rl.r / 0.364, handbrake: B.brakes.handbrake * k * rl.r / 0.364 },
    steering: { ...B.steering, lock: B.steering.lock * st.steer },
    // a big rear wing and diffuser (GT3 R): downforce lift coefficient × area, m²
    aero: st.downforce ? { ...B.aero, clA: st.downforce } : B.aero,
  };
}

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(spec, world, opts = {}) {
    this.spec = spec;
    this.world = world;
    this.m = spec.mass;
    this.I = spec.inertia.slice();
    this.pos = new Float64Array(3);
    this.vel = new Float64Array(3);
    this.q = new Float64Array([0, 0, 0, 1]);
    this.w = new Float64Array(3); // angular velocity, world frame
    this.prevPos = new Float64Array(3);
    this.prevQ = new Float64Array([0, 0, 0, 1]);

    const s = spec.suspension;
    const com = spec.com;
    const wf = spec.wheels.filter(w => w.front)[0].pos[2] - com[2];
    const wr = com[2] - spec.wheels.filter(w => !w.front)[0].pos[2];
    const frontShare = wr / (wf + wr);
    this.unsprungMass = spec.wheels.reduce((a, w) => a + w.mass, 0);
    this.sprungMass = this.m - this.unsprungMass;
    this.wheelbase = wf + wr;
    this.track = Math.abs(spec.wheels[0].pos[0] - spec.wheels[1].pos[0]);
    this.wheels = spec.wheels.map((w, idx) => {
      const axle = w.front ? s.front : s.rear;
      const staticLoad = this.sprungMass * GRAVITY * (w.front ? frontShare : 1 - frontShare) / 2;
      const local = [w.pos[0] - com[0], w.pos[1] - com[1], w.pos[2] - com[2]];
      return {
        ...w, axle, idx, baseRadius: w.radius, toeSign: 0, toe: 0, bump: 0,
        gripMul: 1, rrMul: 1, kMul: 1, cMul: 1, sag: 0, vLat: 0,
        center: local,                                    // wheel centre at static ride height (relative to COM)
        mount: [local[0], local[1] + s.staticLength, local[2]],
        restLength: s.staticLength + staticLoad / axle.k, // spring free length
        minLength: s.staticLength - s.travelUp,
        maxLength: s.staticLength + s.travelDown,
        length: s.staticLength, prevLength: s.staticLength, lengthVel: 0, touch: undefined, prevTouch: 0, suspForce: 0,
        staticDeflection: (staticLoad + w.mass * GRAVITY) / s.tireK,
        omega: 0, spin: 0, steer: 0,
        contact: false, load: 0, slipRatio: 0, slipAngle: 0, fx: 0, fy: 0, vLong: 0,
        cp: new Float64Array(3), n: new Float64Array([0, 1, 0]),
        inertiaEff: w.inertia, driveTorque: 0, brakeTorque: 0,
        zoneGrip: 1,                                      // oil on the road etc. (set by the game each frame)
      };
    });

    // driver controls (smoothed) and drivetrain state
    this.ctl = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.gear = 1;          // -1 reverse, 1..6
    this.shiftTimer = 0;
    this.rpm = spec.engine.idle;
    this.clutchEngaged = false;
    this.autoShift = true; // automatic gearbox only
    this.lastImpact = 0;    // m/s, strongest wall/ground hit since last read
    // damage of the parts: 0 = intact, 1 = destroyed (driver: 1 = killed). See the crash model below.
    this.damage = { engine: 0, gearbox: 0, body: 0, driver: 0, wheels: [0, 0, 0, 0], susp: [0, 0, 0, 0], brakes: [0, 0, 0, 0] };
    if (!spec.shape) {                // a hand-made spec: a box for a body
      const he = spec.halfExtents, c = spec.com, top = (spec.bodyTop || c[1] + 0.8) - c[1];
      spec.shape = { z: [-he[2], he[2]], top: [top, top], ys: top - 0.3, roof: top, hwTop: 0.75 * he[0], yb: (spec.bodyBottom || 0.15) - c[1] };
    }
    this._buildCrashModel();
    this.capV = Infinity;   // m/s: the fastest the wreck can still go (broken suspension, dead driver); Infinity = no limit
    this.events = [];       // impacts / scrapes for the renderer (dents, scratches, sparks)
    this.misfire = false;
    this._misfireTimer = 0;
    this._scrapeDist = 0;
    this._stepImpact = null;
    this._stepScrape = null;
    this._seed = opts.seed || 0x2f6b9a1d;
    // game hooks
    this.input = null;            // controls used by Simulation.step
    this.frozen = false;          // held on the brakes (start of a round)
    this.destroyed = false;       // wrecked: engine dead, rolls to a stop
    this.wallDamageScale = 1;     // how much wall hits break parts of this car
    this.wallCrushFactor = 1;     // share of a wall hit's energy this car's body takes (the game's rule; softer = less crush)
    this._wc = { s: 0, target: 0, k: 0, v0: 0, nx: 0, nz: 0, last: -9, lp: [0, 0], start: -9, hard: 0 }; // the crumple of the current wall crash
    this.boost = 0;               // seconds of nitro left
    this.extDamp = 0;             // 1/s horizontal velocity damping (glue)
    this.extForce = new Float64Array(3); // m/s² extra acceleration (harpoon rope)
    this.speed = 0;         // forward speed m/s (signed)
    this.accum = 0;
    this.dt = 1 / 480;
    this.time = 0;

    // scratch
    this._a = new Float64Array(3); this._b = new Float64Array(3); this._c = new Float64Array(3);
    this._f = new Float64Array(3); this._l = new Float64Array(3); this._u = new Float64Array(3);
    this._F = new Float64Array(3); this._T = new Float64Array(3);
    this._accUp = 0;
  }

  repair() {
    const D = this.damage;
    D.engine = 0; D.gearbox = 0; D.body = 0; D.driver = 0; D.wheels.fill(0); D.susp.fill(0); D.brakes.fill(0);
    this.crush.fill(0); this.dent.fill(0); this.capV = Infinity; this.roofDriver = 0; this.roofMax = 0;
    this._wc.s = 0; this._wc.target = 0; this._wc.start = -9;
    for (const w of this.wheels) { w.toeSign = 0; w.zoneGrip = 1; w.detached = false; }
    this.misfire = false;
    this.destroyed = false; this.boost = 0; this.extDamp = 0; this.extForce.fill(0);
  }

  _rand() { // mulberry32
    let t = (this._seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  _emit(ev) {
    this.events.push(ev);
    if (this.events.length > 64) this.events.shift();
  }

  // The strongest wall/ground hit of this physics step: reported to the game (which applies the damage rules).
  _applyImpact(c) {
    if (c.speed <= 2.5) return;
    const local = qRotateInv(this.q, c.px - this.pos[0], c.py - this.pos[1], c.pz - this.pos[2], new Float64Array(3));
    const ln = qRotateInv(this.q, c.nx, c.ny, c.nz, new Float64Array(3));
    this._emit({ type: 'hit', p: Array.from(local), n: Array.from(ln), speed: c.speed, mu: c.mu, kind: c.kind });
  }

  // ---- crash model ------------------------------------------------------------------------------------------
  // The body outline has crush stations (front, rear, sides, corners). A hit's energy crushes the body there:
  // crush = √(2E / k), k = the stiffness of that side (front > rear > sides; heavier and tougher cars are stiffer).
  // Crush of repeated hits adds up like energy (√(c1² + c2²)). Parts sit at their places inside the body and get
  // damaged when the crush reaches them: engine, gearbox, driver (left seat), and at every wheel the tyre/rim,
  // the brake (disc + caliper in the hub) and the suspension arms.
  _buildCrashModel() {
    const sp = this.spec, he = sp.halfExtents, hx = he[0], hz = he[2];
    const [x0, x1, z0, z1] = sp.outline || [-hx, hx, -hz, hz];
    const zm = (z0 + z1) / 2, zh = (z1 - z0) / 2;
    // the stations go round the body (counter-clockwise seen from above, +x left, +z front): they are also the
    // outline the car collides with. `dent` = how far each one has been pushed in by crashes (physically).
    const st = [];
    const d = Math.SQRT1_2;
    const add = (x, z, nx, nz) => st.push({ x, z, nx, nz, ext: x * nx + z * nz });
    add(x1, z1, d, d);
    for (const f of [0.6, 0, -0.6]) add(f * x1, z1, 0, 1);
    add(x0, z1, -d, d);
    for (const f of [0.75, 0.375, 0, -0.375, -0.75]) add(x0, zm + f * zh, -1, 0);
    add(x0, z0, -d, -d);
    for (const f of [-0.6, 0, 0.6]) add(f * x1, z0, 0, -1);
    add(x1, z0, d, -d);
    for (const f of [-0.75, -0.375, 0, 0.375, 0.75]) add(x1, zm + f * zh, 1, 0);
    this.stations = st;
    this.crush = new Float64Array(st.length);   // crush for the damage model (game rules)
    this.dent = new Float64Array(st.length);    // the outline as it is now (physics)
    this._olx = new Float64Array(st.length); this._olz = new Float64Array(st.length);
    this._olw = new Float64Array(st.length * 3);
    const L = sp.layout || 'front';
    const parts = [];
    const part = (key, i, x, z, r, tough) => parts.push({ key, i, x, z, r, tough });
    part('engine', -1, 0, L === 'front' ? z1 - 0.67 : L === 'mid' ? zm - 0.35 * zh : z0 + 0.62, 0.32, 1.0);
    part('gearbox', -1, 0, L === 'front' ? z1 - 1.35 : L === 'mid' ? z0 + 0.8 : z0 + 1.3, 0.25, 1.2);
    part('driver', -1, Math.max(x1 - 0.55, 0.2), zm - 0.15, 0.28, 0.75);
    for (const wh of this.wheels) {
      const x = wh.center[0], z = wh.center[2], s = Math.sign(x) || 1;
      part('wheels', wh.idx, x, z, wh.radius * 0.9, 1.3);
      part('brakes', wh.idx, x - s * 0.12, z, 0.15, 1.5);
      part('susp', wh.idx, x - s * 0.28, z, 0.22, 1.6);
    }
    this.parts = parts;
    const m = sp.mass / 1500, armor = sp.armor || 1;
    // N/m: a 1500 kg car crushes ~0.6 m in a 56 km/h barrier test
    this.stiff = { front: 1.0e6 * m / armor, rear: 0.8e6 * m / armor, side: 0.45e6 * m / armor, roof: 0.5e6 * m / armor };
    // the roof: crushed over the driver's seat (front left) it can kill him
    this.driverSeat = [Math.max(x1 - 0.55, 0.2), zm - 0.15];
    this.roofDriver = 0; this.roofMax = 0;
    // very stiff bodies (the armoured cars) hardly crumple, but some dent must still show: their visible dents
    // are made deeper than the physical crush, the more the stiffer the body (an ordinary car: as it is)
    this.lookBoost = Math.max(1, Math.sqrt(m / armor / 0.583 / 2));
  }

  // A hit on the roof (rolling over, landing upside down, the roof against a wall or another car): p, n local, n
  // into the car. The roof sinks by C = √(2E/k); over the driver's head more than ~8 cm starts to hurt him,
  // ~26 cm kills him.
  absorbRoof(p, n, energy) {
    const C = energy > 0 ? Math.min(Math.sqrt(2 * energy / this.stiff.roof), 0.9) : 0;
    const D = this.damage;
    if (C > 0.005) {
      const reach = 1.2 + 0.5 * C, ds = this.driverSeat;   // a roof panel sinks as a whole
      const wd = clamp(1 - Math.hypot(p[0] - ds[0], p[2] - ds[1]) / reach, 0, 1);
      this.roofDriver = Math.min(Math.hypot(this.roofDriver, C * wd), 1.2);
      this.roofMax = Math.min(Math.hypot(this.roofMax, C), 1.2);
      const hurt = clamp((this.roofDriver - 0.08) / 0.18, 0, 1);
      if (hurt > D.driver) D.driver = hurt;
      this._recomputeCap();
    }
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    this._emit({ type: 'impact', p: Array.from(p), n: [n[0] / nl, n[1] / nl, n[2] / nl], crush: C, look: C * this.lookBoost,
      severity: clamp(C / 0.4, 0, 1.5), kind: 'roof' });
    return C;
  }

  // ---- the body as a solid (for cars that aren't on their wheels: on the side, on the roof) ----
  topAt(lz) {
    const sh = this.spec.shape, Z = sh.z, T = sh.top, n = Z.length;
    if (lz <= Z[0]) return T[0];
    if (lz >= Z[n - 1]) return T[n - 1];
    const f = (lz - Z[0]) / (Z[n - 1] - Z[0]) * (n - 1), i = Math.min(Math.floor(f), n - 2), t = f - i;
    return T[i] + (T[i + 1] - T[i]) * t;
  }
  halfWidthAt(ly) {
    const sh = this.spec.shape, W = this.spec.outline ? this.spec.outline[1] : this.spec.halfExtents[0];
    if (ly <= sh.ys) return W;
    return W - (W - sh.hwTop) * Math.min(1, (ly - sh.ys) / Math.max(sh.roof - sh.ys, 0.05));
  }
  // not on its wheels: on its side, on the roof, rolling (with a margin, so contacts don't flip-flop between the
  // flat outline and the whole body while a car rocks back onto its wheels)
  tilted() {
    const up = 1 - 2 * (this.q[0] * this.q[0] + this.q[2] * this.q[2]);
    if (this._tilted ? up > 0.95 : up < 0.85) this._tilted = !this._tilted;
    if (this._tilted) this._tiltUntil = this.time + 1.5;
    return this._tilted;
  }
  // tilted now or a moment ago (it may have landed on its wheels half on top of another car)
  wasTilted() { return this.tilted() || this.time < (this._tiltUntil || -1); }
  // points all over the body (world): the outline at bumper height, near the floor and at the shoulder/bonnet line,
  // and along the top (roof edges and middle). Only used while the car is tilted.
  bodyPointsWorld() {
    const sh = this.spec.shape, [X, Z] = this.outlineLocal(), n = X.length;
    const L = this._bpl || (this._bpl = []);
    L.length = 0;
    for (let i = 0; i < n; i++) {
      L.push(X[i], OUTLINE_Y, Z[i]);
      L.push(X[i] * 0.97, sh.yb + 0.06, Z[i]);
      const y = Math.min(this.topAt(Z[i]), sh.ys) - 0.03, hw = this.halfWidthAt(y) * 0.98;
      L.push(clamp(X[i], -hw, hw), y, Z[i]);
    }
    let zlo = Infinity, zhi = -Infinity;
    for (let i = 0; i < n; i++) { if (Z[i] < zlo) zlo = Z[i]; if (Z[i] > zhi) zhi = Z[i]; }
    for (let k = 0; k < sh.z.length; k += 2) {
      const z = clamp(sh.z[k], zlo + 0.03, zhi - 0.03), y = this.topAt(sh.z[k]) - 0.02, hw = this.halfWidthAt(y) * 0.95;
      L.push(hw, y, z, 0, y, z, -hw, y, z);
    }
    const out = this._bpw && this._bpw.length === L.length ? this._bpw : (this._bpw = new Float64Array(L.length));
    const p = this._c;
    for (let i = 0; i < L.length; i += 3) {
      qRotate(this.q, L[i], L[i + 1], L[i + 2], p);
      out[i] = p[0] + this.pos[0]; out[i + 1] = p[1] + this.pos[1]; out[i + 2] = p[2] + this.pos[2];
    }
    return out;
  }
  // Is world point (px,py,pz) inside the body? Then out = [depth, nx, ny, nz]: the shortest way out (world normal).
  bodyContains(px, py, pz, out) {
    const l = qRotateInv(this.q, px - this.pos[0], py - this.pos[1], pz - this.pos[2], this._f);
    const lx = l[0], ly = l[1], lz = l[2], sh = this.spec.shape;
    if (ly < sh.yb || ly > sh.roof) return false;
    const top = this.topAt(lz);
    if (ly > top) return false;
    const tapered = ly > sh.ys, hw = tapered ? this.halfWidthAt(ly) : Infinity;
    if (Math.abs(lx) > hw) return false;
    const [BX, BZ] = this.outlineLocal(), m = BX.length;
    let inside = false;
    for (let k = 0, j = m - 1; k < m; j = k++) {
      if ((BZ[k] > lz) !== (BZ[j] > lz) && lx < (BX[j] - BX[k]) * (lz - BZ[k]) / (BZ[j] - BZ[k]) + BX[k]) inside = !inside;
    }
    if (!inside) return false;
    // the nearest way out: an outline edge, the top line, the floor or a leaning side. out = [depth, n (world)]
    let best = Infinity, bx = 0, by = 0, bz = 0;
    const tryFace = (d, nx, ny, nz) => { if (d < best) { best = d; bx = nx; by = ny; bz = nz; } };
    for (let k = 0, j = m - 1; k < m; j = k++) {
      const ex = BX[k] - BX[j], ez = BZ[k] - BZ[j], el = Math.hypot(ex, ez) || 1e-9;
      const t = clamp(((lx - BX[j]) * ex + (lz - BZ[j]) * ez) / (el * el), 0, 1);
      tryFace(Math.hypot(lx - (BX[j] + ex * t), lz - (BZ[j] + ez * t)), ez / el, 0, -ex / el);
    }
    {
      const dz = 0.15, slope = (this.topAt(lz + dz) - this.topAt(lz - dz)) / (2 * dz), nl = Math.hypot(slope, 1);
      tryFace((top - ly) / nl, 0, 1 / nl, -slope / nl);
    }
    tryFace(ly - sh.yb, 0, -1, 0);
    if (tapered) {
      const k = (this.halfWidthAt(-1e9) - sh.hwTop) / Math.max(sh.roof - sh.ys, 0.05), nl = Math.hypot(1, k);
      tryFace((hw - Math.abs(lx)) / nl, Math.sign(lx) / nl, k / nl, 0);
    }
    const w = qRotate(this.q, bx, by, bz, this._u);
    out[0] = best; out[1] = w[0]; out[2] = w[1]; out[3] = w[2];
    return true;
  }

  // the (dented) outline in local x/z
  outlineLocal() {
    const S = this.stations, D = this.dent;
    for (let i = 0; i < S.length; i++) { this._olx[i] = S[i].x - S[i].nx * D[i]; this._olz[i] = S[i].z - S[i].nz * D[i]; }
    return [this._olx, this._olz];
  }
  // ...and in the world, at bumper height
  outlineWorld() {
    const [X, Z] = this.outlineLocal(), o = this._olw, p = this._c;
    for (let i = 0; i < X.length; i++) {
      qRotate(this.q, X[i], OUTLINE_Y, Z[i], p);
      o[i * 3] = p[0] + this.pos[0]; o[i * 3 + 1] = p[1] + this.pos[1]; o[i * 3 + 2] = p[2] + this.pos[2];
    }
    return o;
  }
  // A crash pushes the outline in by g metres at local point (cx, cz), pushed along local n (into the car).
  // planar (a wall): every point of the face that meets the plane goes in the same; otherwise around the point.
  pushIn(cx, cz, nx, nz, g, planar = false) {
    if (!(g > 0)) return;
    const S = this.stations, D = this.dent;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (-(s.nx * nx + s.nz * nz) < 0.3) continue;
      const px = s.x - s.nx * D[i], pz = s.z - s.nz * D[i];
      let w;
      if (planar) w = (px - cx) * nx + (pz - cz) * nz < 0.25 ? 1 : 0;   // on the plane (or in front of it)
      else w = 1 - Math.hypot(px - cx, pz - cz) / 1.2;
      // the sides have no crumple zone, just a door and a sill: they fold in only so far
      const fz = s.nz * s.nz, cap = 0.8 * s.ext * fz + SIDE_CRUSH_MAX * (1 - fz);
      if (w > 0) D[i] = Math.min(D[i] + g * w, cap);
    }
  }

  toLocal(p, out = new Float64Array(3)) { return qRotateInv(this.q, p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2], out); }
  dirToLocal(d, out = new Float64Array(3)) { return qRotateInv(this.q, d[0], d[1], d[2], out); }

  // stiffness of the body against a push along local direction n (pointing into the car)
  stiffnessAt(n) {
    // pushed on the roof or the floor (a car on its side): those don't crumple here — a rigid contact
    if (Math.abs(n[1] || 0) > 0.6 * Math.hypot(n[0], n[1] || 0, n[2])) return Infinity;
    const l = Math.hypot(n[0], n[2]) || 1, nx = n[0] / l, nz = n[2] / l, k = this.stiff;
    return k.front * Math.max(0, -nz) ** 2 + k.rear * Math.max(0, nz) ** 2 + k.side * nx * nx;
  }

  // is this local point on the front bumper (pushed from the front)?
  isFrontHit(p, n) {
    const l = Math.hypot(n[0], n[2]) || 1;
    return -n[2] / l > 0.6 && p[2] > this.spec.halfExtents[2] * 0.45;
  }

  _contrib(pt, s, c) {
    if (c <= 0) return 0;
    const dx = s.x - pt.x, dz = s.z - pt.z;
    const depth = dx * s.nx + dz * s.nz;                 // how deep inside the body the part sits, seen from s
    const lat = Math.abs(dx * s.nz - dz * s.nx);
    const lw = 0.7 + 0.5 * c;                            // the crushed zone widens as it goes in
    if (lat >= lw) return 0;
    const ce = c * (1 - lat / lw);                       // off to the side of the station the crush is shallower
    return clamp((ce - (depth - pt.r)) / (2 * pt.r * pt.tough), 0, 1);
  }

  // Absorb a hit: p, n in local coordinates (n points into the car), energy in J. Returns the crush depth (m).
  absorbHit(p, n, energy, kind) {
    const l = Math.hypot(n[0], n[2]);
    if (l < 1e-6) return 0;
    const nx = n[0] / l, nz = n[2] / l;
    const C = energy > 0 ? Math.min(Math.sqrt(2 * energy / this.stiffnessAt([nx, 0, nz])), 1.6) : 0;
    const he = this.spec.halfExtents, [ox0, ox1, oz0, oz1] = this.spec.outline || [-he[0], he[0], -he[2], he[2]];
    // where the hit lands on the outline
    let sx = clamp(p[0], ox0, ox1), sz = clamp(p[2], oz0, oz1);
    if (Math.abs(nz) >= Math.abs(nx)) sz = nz < 0 ? oz1 : oz0; else sx = nx < 0 ? ox1 : ox0;
    if (kind === 'wall' && Math.abs(nz) > 0.85) sx *= 0.3;   // square into a wall: the whole bumper takes it
    const D = this.damage, St = this.stations, old = this.crush.slice();
    if (C > 0.005) {
      let reach = 0.45 + 0.5 * C;
      // a wall is flat: it meets the whole front / rear / side at once
      if (kind === 'wall') reach = Math.max(reach, Math.abs(nz) > Math.abs(nx) ? he[0] * 1.1 : he[2] * 0.8);
      for (let i = 0; i < St.length; i++) {
        const s = St[i];
        if (-(s.nx * nx + s.nz * nz) < 0.3) continue;   // faces away from the hit
        const w = clamp(1 - Math.hypot(s.x - sx, s.z - sz) / reach, 0, 1);
        if (w > 0) this.crush[i] = Math.min(Math.hypot(this.crush[i], C * w), 1.8);
      }
      // parts: what the new crush adds
      for (const pt of this.parts) {
        let add = 0;
        for (let i = 0; i < St.length; i++) {
          if (this.crush[i] === old[i]) continue;
          add = Math.max(add, this._contrib(pt, St[i], this.crush[i]) - this._contrib(pt, St[i], old[i]));
        }
        if (add <= 0) continue;
        if (pt.i < 0) D[pt.key] = Math.min(1, D[pt.key] + add);
        else {
          D[pt.key][pt.i] = Math.min(1, D[pt.key][pt.i] + add);
          // a knock on the wheel may bend the suspension arms behind it as well
          if (pt.key === 'wheels' && this._rand() < clamp(0.15 + 1.5 * add, 0, 0.8))
            D.susp[pt.i] = Math.min(1, D.susp[pt.i] + add * (0.3 + 0.6 * this._rand()));
          if (pt.key === 'wheels' && !this.wheels[pt.i].toeSign) this.wheels[pt.i].toeSign = this._rand() < 0.5 ? -1 : 1;
        }
      }
      let mx = 0; for (const c of this.crush) mx = Math.max(mx, c);
      D.body = clamp(mx / 0.9, 0, 1);
      this._recomputeCap();
    }
    this._emit({ type: 'impact', p: Array.from(p), n: [nx, 0, nz], crush: C, look: C * this.lookBoost, severity: clamp(C / 0.5, 0, 1.5), kind });
    return C;
  }

  repairParts(f) {   // the repair kit: parts f of the way back (the crushed body only partly)
    const D = this.damage;
    D.engine *= 1 - f; D.gearbox *= 1 - f;
    for (const k of ['wheels', 'susp', 'brakes']) for (let i = 0; i < 4; i++) D[k][i] *= 1 - f;
    for (let i = 0; i < this.crush.length; i++) { this.crush[i] *= 1 - 0.4 * f; this.dent[i] *= 1 - 0.4 * f; }
    this._recomputeCap();
  }

  // the wheel comes off (smashed rim or broken suspension): that corner sits down on the body
  detachWheel(i) {
    const wh = this.wheels[i];
    if (wh.detached) return false;
    wh.detached = true; wh.contact = false; wh.load = 0;
    this.damage.wheels[i] = 1; this.damage.susp[i] = 1;
    this._recomputeCap();
    return true;
  }

  _recomputeCap() {
    const D = this.damage;
    const broken = D.susp.filter((d) => d >= 1).length;
    this.capV = D.driver >= 1 || broken >= 2 ? 0 : broken === 1 ? 25 / 3.6 : Infinity;
  }

  // Net push the drivetrain can still give at speed v on flat ground (N), with today's damage. Does not depend on
  // what the car is doing now: a healthy car standing still can obviously drive.
  _netForceAt(v) {
    const sp = this.spec, e = sp.engine, g = sp.gearbox, D = this.damage;
    let drive = 0;
    if (D.gearbox < 1 && D.engine < 1) {
      const r = this.wheels[2].radius, lim = e.limiter - 3000 * D.engine;
      for (let gi = 0; gi < this._maxGear(); gi++) {
        const ratio = g.ratios[gi] * g.final;
        let rpm = v / r * ratio / RPM_TO_RAD;
        if (gi === 0 && rpm < e.launchRpm) rpm = Math.min(e.launchRpm, lim - 1);   // pulling away: the clutch slips
        if (rpm >= lim || rpm < e.idle * 0.8) continue;
        let t = lerpTable(e.torque, rpm) * this._powerFactor();
        drive = Math.max(drive, t * ratio * g.efficiency * g.torqueLimit[gi] * this._gearboxFactor() / r);
      }
    }
    const a = sp.aero;
    let resist = 0.5 * a.rho * a.cdA * (1 + 0.25 * D.body) * v * v;
    for (const wh of this.wheels) resist += sp.tire.rollingResistance * wh.rrMul * this.m * GRAVITY / 4;
    return drive - resist;
  }
  _gearboxFactor() {
    const d = this.damage.gearbox;
    return d >= 1 ? 0 : 1 - 0.6 * clamp((d - 0.4) / 0.6, 0, 1);
  }
  _powerFactor() {
    const d = this.damage.engine;
    const misfire = d > 0.3 ? 1 - 0.85 * clamp((d - 0.3) * 0.9, 0, 1) : 1;
    return Math.pow(Math.max(0, 1 - d), 1.2) * misfire;
  }

  // Why this car can't drive any more (null = it still can): it is a wreck when it can't go faster than `minSpeed`
  wreckReason(minSpeed) {
    const D = this.damage;
    if (D.driver >= 1) return 'driver';
    if (this.capV < minSpeed) return 'suspension';
    if (D.engine >= 1) return 'engine';
    if (D.gearbox >= 1) return 'gearbox';
    this._applyDamageState(0);
    // drive it (on paper) from a standstill: if it can't get past minSpeed within ~20 s it can't really drive
    let v = 0.5, t = 0;
    while (v < minSpeed) {
      const a = this._netForceAt(v) / this.m;
      if (a < 0.05 || t > 20) return D.engine > D.gearbox ? 'engine' : 'gearbox';
      v += a * 0.25; t += 0.25;
    }
    return null;
  }

  // Per-step effect of damage on wheels, suspension, engine misfires.
  _applyDamageState(dt) {
    const D = this.damage;
    for (const wh of this.wheels) {
      const d = D.wheels[wh.idx], ds = D.susp[wh.idx], broken = ds >= 1;
      const flat = clamp((d - 0.6) / 0.4, 0, 1);
      wh.radius = wh.baseRadius - 0.035 * flat;          // tyre going flat
      wh.gripMul = (1 - 0.4 * d) * (1 - 0.3 * ds) * (broken ? 0.35 : 1);  // bent rim / torn tyre / wheel at an angle
      wh.rrMul = 1 + 12 * flat + (broken ? 25 : 0);      // a flat tyre drags, a collapsed corner scrapes
      wh.kMul = (1 - 0.35 * d) * (1 - 0.6 * ds); wh.cMul = (1 - 0.5 * d) * (1 - 0.7 * ds); // bent spring / leaking damper
      wh.sag = 0.05 * d + 0.06 * ds + (broken ? 0.1 : 0); // that corner sits lower
      if (ds > 0 && !wh.toeSign) wh.toeSign = this._rand() < 0.5 ? -1 : 1;
      const wobble = d > 0.15 ? Math.sin(wh.spin) : 0;   // bent wheel: once per revolution
      const toeMax = wh.front ? 0.035 : 0.015;            // rear toe is far more destabilising: keep it smaller
      wh.toe = wh.toeSign * toeMax * Math.min(1, d + 1.2 * ds) + 0.02 * d * wobble; // knocked-out alignment pulls the car
      wh.bump = 0.012 * d * wobble;
    }
    if (D.engine > 0.3 && dt > 0) {
      this._misfireTimer -= dt;
      if (this._misfireTimer <= 0) {
        this.misfire = this._rand() < (D.engine - 0.3) * 0.9;
        this._misfireTimer = 0.04 + this._rand() * 0.12;
      }
    } else if (D.engine <= 0.3) this.misfire = false;
  }

  _maxGear() {
    const g = this.damage.gearbox, n = this.spec.gearbox.ratios.length;
    return g > 0.9 ? n - 3 : g > 0.75 ? n - 2 : g > 0.5 ? n - 1 : n;     // (g ≥ 1: no drive at all, see _fixedStep)
  }

  reset(x, z, heading) {
    const ground = this.world.height(x, z);
    // place body so that wheels sit at static ride height
    this.pos[0] = x; this.pos[2] = z;
    const defl = this.wheels.reduce((a, w) => a + w.staticDeflection, 0) / 4;
    this.pos[1] = ground + this.spec.com[1] - defl;
    this.q[0] = 0; this.q[1] = Math.sin(heading / 2); this.q[2] = 0; this.q[3] = Math.cos(heading / 2);
    this.vel.fill(0); this.w.fill(0);
    for (const wh of this.wheels) {
      wh.omega = 0; wh.length = wh.prevLength = this.spec.suspension.staticLength; wh.steer = 0;
      wh.lengthVel = 0; wh.touch = undefined;
    }
    this.gear = 1; this.shiftTimer = 0; this.rpm = this.spec.engine.idle;
    this.ctl.steer = 0; this.ctl.throttle = 0; this.ctl.brake = 0;
    this.prevPos.set(this.pos); this.prevQ.set(this.q);
  }

  // Keep the car where it is but put it back on its wheels, facing its current heading.
  recover() {
    const f = qRotate(this.q, 0, 0, 1, this._a);
    const heading = Math.atan2(f[0], f[2]);
    const x = this.pos[0], z = this.pos[2];
    // if inside/too close to a wall, nudge out along the distance-field gradient
    let px = x, pz = z;
    for (let i = 0; i < 40 && this.world.sdf(px, pz) < 2.6; i++) {
      if (!sdfGradient(this.world, px, pz, this._b)) break;
      px += this._b[0] * 0.25; pz += this._b[2] * 0.25;
    }
    this.reset(px, pz, heading);
  }

  // inverse world inertia applied to vector (x,y,z) -> out
  _invInertiaWorld(x, y, z, out) {
    const l = qRotateInv(this.q, x, y, z, this._c);
    const bx = l[0] / this.I[0], by = l[1] / this.I[1], bz = l[2] / this.I[2];
    return qRotate(this.q, bx, by, bz, out);
  }

  _applyImpulse(px, py, pz, jx, jy, jz) {
    this.vel[0] += jx / this.m; this.vel[1] += jy / this.m; this.vel[2] += jz / this.m;
    const rx = px - this.pos[0], ry = py - this.pos[1], rz = pz - this.pos[2];
    const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    const d = this._invInertiaWorld(tx, ty, tz, this._b);
    this.w[0] += d[0]; this.w[1] += d[1]; this.w[2] += d[2];
  }

  // Tyre force (combined slip, Pacejka-style). Returns [fx, fy] into out.
  _tire(wh, kappa, tanAlpha, load, out) {
    const t = this.spec.tire;
    const sx = kappa / t.peakSlipRatio;
    const sy = tanAlpha / Math.tan(wh.front ? t.peakSlipAngleFront : t.peakSlipAngleRear);
    const s = Math.hypot(sx, sy);
    if (s < 1e-9 || load <= 0) { out[0] = 0; out[1] = 0; return out; }
    let mu = t.mu * (wh.front ? t.frontGrip : t.rearGrip) * wh.gripMul * wh.zoneGrip;
    mu *= clamp(1 + t.loadSensitivity * (load / t.nominalLoad - 1), 0.75, 1.15);
    const C = wh.front ? t.shapeCFront : t.shapeC, B = Math.tan(Math.PI / (2 * C)); // peak exactly at s = 1
    const f = load * mu * Math.sin(C * Math.atan(B * s));
    out[0] = f * sx / s * t.longGrip; // friction ellipse: more grip along the tyre (traction/braking) than sideways
    out[1] = -f * sy / s;
    return out;
  }

  _engineTorque(rpm, throttle) {
    const e = this.spec.engine;
    const dmg = this.damage.engine;
    // top speed of the car (stat): the engine fades out over the last 3 m/s
    const vmax = Math.min(this.spec.vmax || Infinity, this.capV);
    if (vmax < Infinity && this.speed > 0) throttle *= clamp((vmax - this.speed) / 3, 0, 1);
    if (rpm >= e.limiter - 3000 * dmg) throttle = 0;   // damaged engine can't rev
    let on = lerpTable(e.torque, clamp(rpm, e.idle, e.limiter + 200)) * throttle * Math.pow(Math.max(0, 1 - dmg), 1.2);
    if (this.misfire) on *= 0.15;
    const off = -(e.engineBrake[0] + e.engineBrake[1] * rpm) * (1 - throttle);
    return on + (rpm > e.idle + 150 ? off : 0);
  }

  // ---- driver input → smoothed controls, gear logic ----
  _controls(dt, input) {
    const c = this.ctl, st = this.spec.steering;
    if (this.frozen || this.destroyed) {   // held at the start line / wrecked: no driver input
      c.throttle = 0; c.handbrake = 0;
      c.brake = this.destroyed ? 0.35 : 1;
      c.steer *= Math.exp(-dt * 3);
      if (this.gear === -1) this.gear = 1;
      return;
    }
    const fwdSpeed = this.speed;
    // pedals: in reverse the keys swap roles
    let wantThrottle = input.throttle, wantBrake = input.brake;
    if (this.gear === -1) { wantThrottle = input.brake; wantBrake = input.throttle; }
    const pedalRate = 7;
    c.throttle += clamp(wantThrottle - c.throttle, -pedalRate * dt, pedalRate * dt);
    c.brake += clamp(wantBrake - c.brake, -pedalRate * 1.5 * dt, pedalRate * dt);
    c.handbrake = input.handbrake ? 1 : 0;

    // steering: the wheel angle depends only on A/D (full lock at any speed); the wheels just turn a bit slower at speed
    const v = Math.abs(fwdSpeed);
    const target = clamp(input.steer, -1, 1) * st.lock;
    const returning = Math.abs(target) < Math.abs(c.steer) || Math.sign(target) !== Math.sign(c.steer);
    const rate = (returning ? st.returnRate : st.rate) / (1 + v / 60);
    c.steer += clamp(target - c.steer, -rate * st.lock * dt, rate * st.lock * dt);

    // S brakes while rolling forward and drops straight into reverse as the car slows below ~10 km/h —
    // no stop-and-wait; the reverse drive then finishes the stop and pulls backwards. W does the same the other way.
    if (this.gear > 0 && input.brake > 0.5 && input.throttle < 0.1 && fwdSpeed < 3.0) {
      this.gear = -1; this.shiftTimer = 0; c.throttle = c.brake; c.brake = 0;
    } else if (this.gear === -1 && input.throttle > 0.5 && input.brake < 0.1 && fwdSpeed > -3.0) {
      this.gear = 1; this.shiftTimer = 0; c.throttle = c.brake; c.brake = 0;
    }
  }

  _autoShift(dt) {
    this._shiftHold = Math.max(0, (this._shiftHold || 0) - dt);
    if (!this.autoShift || this.gear < 1 || this.shiftTimer > 0) return;
    const g = this.spec.gearbox, e = this.spec.engine;
    const thr = this.ctl.throttle;
    // upshift on actual engine speed (never sit on the limiter); downshift on road speed (wheelspin can't cause hunting)
    const roadRpm = (gear) => Math.max(this.speed, 0) / this.wheels[2].radius * g.ratios[gear - 1] * g.final / RPM_TO_RAD;
    const limiter = e.limiter - 3000 * this.damage.engine;            // a damaged engine revs lower: shift earlier
    const up = Math.min(6200 + 1900 * thr, limiter - 400), down = Math.min(2600 + 2000 * thr, up * 0.5);
    const engineRpm = Math.max(this.rpm, roadRpm(this.gear));
    if (this.gear > this._maxGear()) { this.shift(-1); return; }
    if (this.gear < g.ratios.length && engineRpm > up && this.clutchEngaged) { this.shift(+1); this._shiftHold = 1.0; }
    else if (this.gear > 1 && (this._shiftHold === 0 || this.ctl.brake > 0.1) && roadRpm(this.gear) < down && roadRpm(this.gear - 1) < e.redline - 600) this.shift(-1);
  }

  shift(dir) {
    const n = this.spec.gearbox.ratios.length;
    if (this.shiftTimer > 0) return;
    if (this.gear === -1) { if (dir > 0) this.gear = 1; return; }
    const next = clamp(this.gear + dir, 1, Math.min(n, this._maxGear()));
    if (next !== this.gear) { this.gear = next; this.shiftTimer = this.spec.gearbox.shiftTime * (1 + 4 * this.damage.gearbox); }
  }

  // propshaft speed seen by the gearbox (rear-wheel reference; front wheels are smaller so they spin faster)
  _drivenOmega() {
    const w = this.wheels, sf = w[0].radius / w[2].radius, share = this.spec.drive.frontShare;
    const front = (w[0].omega + w[1].omega) * 0.5 * sf, rear = (w[2].omega + w[3].omega) * 0.5;
    return front * share + rear * (1 - share);
  }

  // ---- one fixed physics step ----
  _fixedStep(dt, input) {
    const sp = this.spec, W = this.world;
    this._controls(dt, input);
    this._applyDamageState(dt);
    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this._autoShift(dt);

    const F = this._F, T = this._T; F.fill(0); T.fill(0);
    const fwd = qRotate(this.q, 0, 0, 1, this._f);
    const left = qRotate(this.q, 1, 0, 0, this._l);
    const up = qRotate(this.q, 0, 1, 0, this._u);
    this.speed = this.vel[0] * fwd[0] + this.vel[1] * fwd[1] + this.vel[2] * fwd[2];

    // ---- drivetrain ----
    const g = sp.gearbox, e = sp.engine;
    const ratio = this.gear === -1 ? -g.reverse * g.final : g.ratios[this.gear - 1] * g.final;
    const wheelRpm = this._drivenOmega() * ratio / RPM_TO_RAD; // engine rpm if clutch locked
    const throttle = this.ctl.throttle;
    const gearLimit = this.gear === -1 ? g.reverseTorqueLimit : g.torqueLimit[this.gear - 1];
    const shifting = this.shiftTimer > 0;
    let engineRpm, driveTorque = 0;
    // clutch slips when pulling away (1st/reverse) or when the engine would otherwise stall in a high gear
    const launching = wheelRpm < ((this.gear === 1 || this.gear === -1) ? e.launchRpm * 0.95 : e.idle * 1.3);
    if (shifting) {
      this.clutchEngaged = false;
      engineRpm = Math.max(wheelRpm, e.idle);
    } else if (launching) {
      // clutch slips: engine revs towards launch rpm, full engine torque goes through
      this.clutchEngaged = false;
      const free = e.idle + throttle * (e.launchRpm - e.idle);
      engineRpm = Math.max(wheelRpm, free);
      driveTorque = throttle > 0.01 ? this._engineTorque(engineRpm, throttle) * ratio * g.efficiency * gearLimit : 0;
    } else {
      this.clutchEngaged = true;
      engineRpm = Math.max(wheelRpm, e.idle);
      if (wheelRpm < e.idle) { this.clutchEngaged = false; } // would stall: clutch opens
      driveTorque = this.clutchEngaged ? this._engineTorque(engineRpm, throttle) * ratio * g.efficiency * gearLimit : 0;
    }
    driveTorque *= this._gearboxFactor();                // a wrecked gearbox slips / passes nothing
    this.rpm += (engineRpm - this.rpm) * Math.min(1, dt * 25);

    // all-wheel drive: centre diff + front/rear diffs, each with a limited-slip coupling
    const [fl, fr, rl, rr] = this.wheels;
    const drv = sp.drive, sf = fl.radius / rl.radius;
    const couple = (dfs, speedDiff, torque) => {
      const lim = dfs.preload + dfs.lockRatio * Math.abs(torque);
      return clamp(dfs.stiffness * speedDiff, -lim, lim);
    };
    const shaftF = (fl.omega + fr.omega) * 0.5 * sf, shaftR = (rl.omega + rr.omega) * 0.5;
    const toCenter = couple(drv.center, shaftR - shaftF, driveTorque); // faster axle gives torque to the slower one
    const tF = driveTorque * drv.frontShare + toCenter;
    const tR = driveTorque * (1 - drv.frontShare) - toCenter;
    const bF = couple(drv.front, (fl.omega - fr.omega) * sf, tF);
    const bR = couple(drv.rear, rl.omega - rr.omega, tR);
    fl.driveTorque = (tF * 0.5 - bF) * sf; fr.driveTorque = (tF * 0.5 + bF) * sf; // shaft → wheel torque
    rl.driveTorque = tR * 0.5 - bR; rr.driveTorque = tR * 0.5 + bR;
    const reflected = this.clutchEngaged ? e.inertia * ratio * ratio * 0.25 : 0;
    fl.inertiaEff = fl.inertia + reflected * sf * sf; fr.inertiaEff = fr.inertia + reflected * sf * sf;
    rl.inertiaEff = rl.inertia + reflected; rr.inertiaEff = rr.inertia + reflected;

    // steering angles (Ackermann)
    const d = this.ctl.steer;
    let dl = d, dr = d;
    if (Math.abs(d) > 1e-4) {
      const R = this.wheelbase / Math.tan(Math.abs(d));
      const inner = Math.atan(this.wheelbase / (R - this.track / 2));
      const outer = Math.atan(this.wheelbase / (R + this.track / 2));
      // positive steer = left turn; left wheel is inner
      if (d > 0) { dl = inner; dr = outer; } else { dl = -outer; dr = -inner; }
    }
    this.wheels[0].steer = dl + this.wheels[0].toe; this.wheels[1].steer = dr + this.wheels[1].toe;
    this.wheels[2].steer = this.wheels[2].toe; this.wheels[3].steer = this.wheels[3].toe;

    // ---- suspension: quarter-car model (sprung body, unsprung wheel mass, tyre spring) ----
    const susp = sp.suspension;
    const mountW = this._a, gN = this._b;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      qRotate(this.q, wh.mount[0], wh.mount[1], wh.mount[2], mountW);
      const mx = mountW[0] + this.pos[0], my = mountW[1] + this.pos[1], mz = mountW[2] + this.pos[2];
      const r = wh.radius + wh.bump, uy = up[1];
      // wheel centre for the current suspension length
      const wx = mx - up[0] * wh.length, wy = my - up[1] * wh.length, wz = mz - up[2] * wh.length;
      let touch = wh.maxLength + 1, bestO = 0, cx = wx, cz = wz;
      let hx = 0, hz = 1;
      if (uy > 0.2) {
        const cs = Math.cos(wh.steer), sn = Math.sin(wh.steer);
        hx = fwd[0] * cs + left[0] * sn; hz = fwd[2] * cs + left[2] * sn;
        const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        // The wheel is round: it meets a curb with its front before the centre gets there.
        // Required centre height = max over samples of ground(x) + sqrt(r² − x²).
        let t = (my - W.height(mx, mz)) / uy;
        for (let it = 0; it < 2; it++) {
          const bx = mx - up[0] * t, bz = mz - up[2] * t;
          let need = -1e9;
          for (let k = 0; k < WHEEL_PROFILE.length; k++) {
            const o = WHEEL_PROFILE[k] * r;
            const sx = bx + hx * o, sz = bz + hz * o;
            const g = W.height(sx, sz) + Math.sqrt(r * r - o * o);
            if (g > need) { need = g; bestO = o; cx = sx; cz = sz; }
          }
          t = (my - need) / uy;
        }
        touch = t; // suspension length at which the undeflected tyre just touches
      }
      wh.prevTouch = wh.touch === undefined ? touch : wh.touch;
      wh.touch = touch;
      const defl = wh.length - touch;
      if (defl > 0 && uy > 0.2 && !wh.detached) {
        wh.contact = true;
        const deflRate = wh.lengthVel - (touch - wh.prevTouch) / dt;
        // the tyre bottoms out on the rim at large deflection: cap the force (keeps curb strikes sane)
        wh.load = clamp(susp.tireK * defl + susp.tireC * deflRate, 0, 40000);
        // contact normal of a round wheel: from the touching point towards the wheel centre
        groundNormal(W, cx, cz, gN);
        // tyres envelope a curb edge, so the push-back is softer than a rigid wheel's: limit the tilt to ~25°
        const vert = Math.sqrt(r * r - bestO * bestO);
        const back = clamp(-bestO / vert, -0.47, 0.47);
        let nx = back * hx + gN[0], ny = gN[1], nz = back * hz + gN[2];
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        wh.n[0] = nx; wh.n[1] = ny; wh.n[2] = nz;
        wh.cp[0] = wx - nx * (r - defl); wh.cp[1] = wy - ny * (r - defl); wh.cp[2] = wz - nz * (r - defl);
      } else {
        wh.contact = false; wh.load = 0;
        wh.n[0] = up[0]; wh.n[1] = up[1]; wh.n[2] = up[2];
        wh.cp[0] = wx - up[0] * r; wh.cp[1] = wy - up[1] * r; wh.cp[2] = wz - up[2] * r;
      }
    }
    // spring / damper / anti-roll bar, then move the unsprung wheel along the strut
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i], other = this.wheels[i ^ 1];
      if (wh.detached) { wh.suspForce = 0; wh.length = wh.maxLength; wh.lengthVel = 0; continue; }
      const L = wh.length, rate = wh.lengthVel;
      let fs = wh.axle.k * wh.kMul * (wh.restLength - wh.sag - L);
      // digressive damper: firm at low shaft speed (body control), blows off on sharp hits (curbs)
      const c = (rate < 0 ? wh.axle.bump : wh.axle.rebound) * wh.cMul, av = Math.abs(rate), knee = 0.15;
      fs -= Math.sign(rate) * (av <= knee ? c * av : c * knee + c * 0.2 * (av - knee));
      fs += wh.axle.arb * (other.length - L);
      if (L < wh.minLength) fs += susp.bumpStopK * (wh.minLength - L);
      if (L > wh.maxLength) fs -= susp.bumpStopK * (L - wh.maxLength);
      wh.suspForce = fs;
    }
    for (const wh of this.wheels) {
      if (wh.detached) continue;
      const nUp = wh.n[0] * up[0] + wh.n[1] * up[1] + wh.n[2] * up[2];
      const acc = this._accUp + (wh.suspForce - wh.load * nUp) / wh.mass + GRAVITY * up[1];
      wh.lengthVel += acc * dt;
      wh.length += wh.lengthVel * dt;
      const hardMin = wh.minLength - 0.04, hardMax = wh.maxLength + 0.02;
      if (wh.length < hardMin) { wh.length = hardMin; if (wh.lengthVel < 0) wh.lengthVel = 0; }
      if (wh.length > hardMax) { wh.length = hardMax; if (wh.lengthVel > 0) wh.lengthVel = 0; }
    }

    // brakes (no ABS)
    const brakeIn = this.ctl.brake;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      let tb = brakeIn * (wh.front ? sp.brakes.front : sp.brakes.rear) * (1 - this.damage.brakes[i]); // damaged brake: weaker
      if (!wh.front && this.ctl.handbrake) tb += sp.brakes.handbrake;
      tb += sp.tire.rollingResistance * wh.rrMul * wh.load * wh.radius;
      wh.brakeTorque = tb;
    }

    // tyre forces, wheel spin (implicit), apply to body
    const tf = this._c;
    for (const wh of this.wheels) {
      if (!wh.contact) {
        // free wheel: brakes and drive act on the spinning wheel only
        const I = wh.inertiaEff;
        let om = wh.omega + wh.driveTorque / I * dt;
        const dOm = wh.brakeTorque / I * dt;
        om = Math.abs(om) <= dOm ? 0 : om - Math.sign(om) * dOm;
        wh.omega = om; wh.fx = wh.fy = 0; wh.slipRatio = 0; wh.slipAngle = 0;
        continue;
      }
      const n = wh.n;
      // wheel heading on the ground plane
      const cs = Math.cos(wh.steer), sn = Math.sin(wh.steer);
      let fx = fwd[0] * cs + left[0] * sn, fy = fwd[1] * cs + left[1] * sn, fz = fwd[2] * cs + left[2] * sn;
      const dn = fx * n[0] + fy * n[1] + fz * n[2];
      fx -= n[0] * dn; fy -= n[1] * dn; fz -= n[2] * dn;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      const sx = n[1] * fz - n[2] * fy, sy = n[2] * fx - n[0] * fz, sz = n[0] * fy - n[1] * fx; // n × f = left
      // contact patch velocity
      const rx = wh.cp[0] - this.pos[0], ry = wh.cp[1] - this.pos[1], rz = wh.cp[2] - this.pos[2];
      const vx = this.vel[0] + (this.w[1] * rz - this.w[2] * ry);
      const vy = this.vel[1] + (this.w[2] * rx - this.w[0] * rz);
      const vz = this.vel[2] + (this.w[0] * ry - this.w[1] * rx);
      const vLong = vx * fx + vy * fy + vz * fz;
      const vLat = vx * sx + vy * sy + vz * sz;
      const den = Math.max(Math.abs(vLong), sp.tire.lowSpeed);
      const tanA = vLat / den;
      const load = wh.load;
      const r = wh.radius;
      // force at current spin and its slope w.r.t. spin
      const k0 = (wh.omega * r - vLong) / den;
      this._tire(wh, k0, tanA, load, tf); const fx0 = tf[0];
      const eps = 0.05;
      this._tire(wh, k0 + eps * r / den, tanA, load, tf);
      const dFdOm = Math.max((tf[0] - fx0) / eps, 0);
      const I = wh.inertiaEff;
      const denom = I / dt + dFdOm * r;
      let om = wh.omega + (wh.driveTorque - fx0 * r) / denom;
      const dOm = wh.brakeTorque / denom;
      om = Math.abs(om) <= dOm ? 0 : om - Math.sign(om) * dOm;
      wh.omega = om;
      const k1 = (om * r - vLong) / den;
      this._tire(wh, k1, tanA, load, tf);
      wh.fx = tf[0]; wh.fy = tf[1];
      wh.slipRatio = k1; wh.slipAngle = Math.atan(tanA); wh.vLong = vLong; wh.vLat = vLat;
      // tyre friction + the part of the tyre normal force the suspension arms carry (not along the strut)
      const nUp = n[0] * up[0] + n[1] * up[1] + n[2] * up[2];
      const Fx = (n[0] - up[0] * nUp) * load + fx * wh.fx + sx * wh.fy;
      const Fy = (n[1] - up[1] * nUp) * load + fy * wh.fx + sy * wh.fy;
      const Fz = (n[2] - up[2] * nUp) * load + fz * wh.fx + sz * wh.fy;
      F[0] += Fx; F[1] += Fy; F[2] += Fz;
      T[0] += ry * Fz - rz * Fy; T[1] += rz * Fx - rx * Fz; T[2] += rx * Fy - ry * Fx;
    }
    // spring/damper forces act on the body along the strut, at the wheel
    for (const wh of this.wheels) {
      const fs = wh.suspForce;
      const rx = wh.cp[0] - this.pos[0], ry = wh.cp[1] - this.pos[1], rz = wh.cp[2] - this.pos[2];
      const Fx = up[0] * fs, Fy = up[1] * fs, Fz = up[2] * fs;
      F[0] += Fx; F[1] += Fy; F[2] += Fz;
      T[0] += ry * Fz - rz * Fy; T[1] += rz * Fx - rx * Fz; T[2] += rx * Fy - ry * Fx;
    }
    for (const wh of this.wheels) wh.spin = (wh.spin + wh.omega * dt) % (Math.PI * 2);

    // aerodynamics
    const a = sp.aero;
    const vmag = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
    const drag = 0.5 * a.rho * a.cdA * (1 + 0.25 * this.damage.body) * vmag; // bent panels add drag
    F[0] -= drag * this.vel[0]; F[1] -= drag * this.vel[1]; F[2] -= drag * this.vel[2];
    const down = 0.5 * a.rho * a.clA * this.speed * this.speed * Math.max(0, up[1]);  // the wing only presses while the car is upright
    F[0] -= up[0] * down; F[1] -= up[1] * down; F[2] -= up[2] * down;
    // gravity on the sprung body (the wheels carry their own weight through the tyres)
    F[1] -= this.sprungMass * GRAVITY;
    // nitro: extra push along the car while the tyres are on the ground; harpoon rope etc.
    if (this.boost > 0) {
      this.boost = Math.max(0, this.boost - dt);
      if (this.wheels.some((w) => w.contact)) { F[0] += fwd[0] * this.m * 7.5; F[1] += fwd[1] * this.m * 7.5; F[2] += fwd[2] * this.m * 7.5; }
    }
    F[0] += this.extForce[0] * this.m; F[1] += this.extForce[1] * this.m; F[2] += this.extForce[2] * this.m;
    this._accUp = (F[0] * up[0] + F[1] * up[1] + F[2] * up[2]) / this.m;

    // ---- integrate (semi-implicit Euler) ----
    for (let i = 0; i < 3; i++) this.vel[i] += F[i] / this.m * dt;
    // angular: body frame with gyroscopic term
    const wb = qRotateInv(this.q, this.w[0], this.w[1], this.w[2], this._a);
    const tb = qRotateInv(this.q, T[0], T[1], T[2], this._b);
    const I = this.I;
    const Lx = I[0] * wb[0], Ly = I[1] * wb[1], Lz = I[2] * wb[2];
    const gx = wb[1] * Lz - wb[2] * Ly, gy = wb[2] * Lx - wb[0] * Lz, gz = wb[0] * Ly - wb[1] * Lx;
    wb[0] += (tb[0] - gx) / I[0] * dt; wb[1] += (tb[1] - gy) / I[1] * dt; wb[2] += (tb[2] - gz) / I[2] * dt;
    qRotate(this.q, wb[0], wb[1], wb[2], this.w);
    if (this.extDamp > 0) { const k = Math.exp(-this.extDamp * dt); this.vel[0] *= k; this.vel[2] *= k; }
    for (let i = 0; i < 3; i++) this.pos[i] += this.vel[i] * dt;
    const q = this.q, w = this.w, h = 0.5 * dt;
    const nx = q[0] + h * (w[0] * q[3] + w[1] * q[2] - w[2] * q[1]);
    const ny = q[1] + h * (w[1] * q[3] + w[2] * q[0] - w[0] * q[2]);
    const nz = q[2] + h * (w[2] * q[3] + w[0] * q[1] - w[1] * q[0]);
    const nw = q[3] - h * (w[0] * q[0] + w[1] * q[1] + w[2] * q[2]);
    const ql = Math.hypot(nx, ny, nz, nw);
    q[0] = nx / ql; q[1] = ny / ql; q[2] = nz / ql; q[3] = nw / ql;

    this._collide();
    // A crash crumples the body and twists it: that soaks up part of the spin a rigid body would get from a corner
    // hit. For a moment after a hard wall crash the car's yaw rate dies out (the harder the crash, the more).
    const wc = this._wc, since = this.time - wc.start;
    if (since >= 0 && since < 0.3 && wc.hard > 0) this.w[1] *= Math.exp(-dt * 6 * wc.hard);
    if (this._stepImpact) { this._applyImpact(this._stepImpact); this._stepImpact = null; }
    if (this._stepScrape) {
      const c = this._stepScrape;
      this._scrapeDist += c.speed * dt;
      if (this._scrapeDist > 0.5) {  // a scratch every half metre of sliding contact
        this._scrapeDist = 0;
        const p = qRotateInv(this.q, c.px - this.pos[0], c.py - this.pos[1], c.pz - this.pos[2], new Float64Array(3));
        const n = qRotateInv(this.q, c.nx, c.ny, c.nz, new Float64Array(3));
        const t = qRotateInv(this.q, c.tx, c.ty, c.tz, new Float64Array(3));
        this._emit({ type: 'scrape', p: Array.from(p), n: Array.from(n), t: Array.from(t), speed: c.speed, kind: c.kind });
      }
      this._stepScrape = null;
    }
    this.time += dt;
  }

  // ---- contacts: walls (signed distance field) and body vs ground ----
  _collide() {
    const W = this.world, sp = this.spec;
    const he = sp.halfExtents, com = sp.com;
    const yMid = 0.02; // bumpers sit at about the height of the centre of mass: wall hits don't roll the car
    const p = this._a, nrm = this._b;
    // Wall contact: the outline points inside the wall make ONE contact (their centre, their mean normal) — a flat
    // bumper meets a flat wall as a whole, so a square hit stops the car instead of spinning it off a corner.
    // The body crumples: while the crumple zone (the crush of this hit, as in the crash model) gives way, the wall
    // pushes with k·s (s = how far it has crumpled so far) and the car keeps moving on — into its own front: the
    // outline is dented by exactly that much, so the car never sits inside the wall and nothing pushes it back out.
    const wc = this._wc;
    if (this.time - wc.last > 0.4) { wc.s = 0; wc.target = 0; }
    let n = 0, cx = 0, cy = 0, cz = 0, gx = 0, gz = 0, deepest = 0;
    const tilted = this.tilted();
    const O = tilted ? this.bodyPointsWorld() : this.outlineWorld(), NP = O.length / 3;
    if (!this._wallPts || this._wallPts.length < NP) this._wallPts = Array.from({ length: NP }, () => new Float64Array(3));
    const WP = this._wallPts;
    for (let i = 0; i < NP; i++) {
      const px = O[i * 3], py = O[i * 3 + 1], pz = O[i * 3 + 2];
      const dist = W.sdf(px, pz);
      if (dist >= 0) continue;
      if (!sdfGradient(W, px, pz, nrm, 0.45)) continue;
      WP[n][0] = px; WP[n][1] = py; WP[n][2] = pz;
      n++; cx += px; cy += py; cz += pz; gx += nrm[0]; gz += nrm[2];
      if (-dist > deepest) deepest = -dist;
    }
    if (n) {
      cx /= n; cy /= n; cz /= n;
      const gl = Math.hypot(gx, gz) || 1; gx /= gl; gz /= gl;
      wc.last = this.time;
      this._wallContact(cx, cy, cz, gx, gz, WP, n);
      if (deepest > 0.003) { this.pos[0] += gx * (deepest - 0.003); this.pos[2] += gz * (deepest - 0.003); }
    }
    // body vs ground (roll-overs, bottoming out)
    let lift = 0;
    const bodyUp = qRotate(this.q, 0, 1, 0, this._l);
    const upX = bodyUp[0], upY = bodyUp[1], upZ = bodyUp[2];
    const sh = sp.shape, nTop = sh.z.length;
    for (let ci = 0, nc = BODY_CORNERS.length + 2 * nTop; ci < nc; ci++) {
      let lx, ly, lz;
      if (ci < BODY_CORNERS.length) {
        const c = BODY_CORNERS[ci];
        if (c[1] > 0) continue;
        // overhangs are higher than the floor pan (approach / departure angle)
        const bottom = Math.abs(c[2]) === 1 ? sp.bodyBottom + 0.17 : sp.bodyBottom;
        lx = c[0] * he[0] * 0.95; ly = bottom - com[1]; lz = c[2] * he[2] * 0.95;
      } else {
        if (upY > 0.3) break;                         // the right way up: the top can't reach the ground
        // the top: bonnet, windscreen, roof and boot along the real top line, the roof as narrow as it is
        const k = ci - BODY_CORNERS.length, zi = k >> 1;
        lz = sh.z[zi] + (zi === 0 ? 0.05 : zi === nTop - 1 ? -0.05 : 0);
        ly = sh.top[zi];
        lx = (k & 1 ? 1 : -1) * Math.min(he[0] * 0.95, this.halfWidthAt(ly) * 0.97);
      }
      const c = ci < BODY_CORNERS.length ? BODY_CORNERS[ci] : TOP_MARK;
      qRotate(this.q, lx, ly, lz, p);
      const px = p[0] + this.pos[0], py = p[1] + this.pos[1], pz = p[2] + this.pos[2];
      const gh = W.height(px, pz);
      if (py >= gh) continue;
      // Upright car scraping its floor over a curb edge: the contact normal is the flat floor's normal
      // (the edge slides along the floor). Otherwise (roll-over) a body corner hits the ground face.
      if (c[1] < 0 && upY > 0.5) { nrm[0] = upX; nrm[1] = upY; nrm[2] = upZ; }
      else groundNormal(W, px, pz, nrm);
      this._resolveContact(px, py, pz, nrm[0], nrm[1], nrm[2], 0.0, 0.25, 'ground'); // body scraping: slides, doesn't bounce
      lift = Math.max(lift, gh - py);
    }
    if (lift > 0.002) this.pos[1] += lift - 0.002;
  }

  _wallContact(px, py, pz, nx, nz, pts, np) {
    let vn = this._pointVel(px, py, pz, nx, 0, nz);
    if (vn >= 0) {   // the middle of the contact isn't moving in — but a swinging end may be
      for (let i = 0; i < np; i++) if (this._pointVel(pts[i][0], pts[i][1], pts[i][2], nx, 0, nz) < -0.3) { vn = -1e-9; break; }
      if (vn >= 0) return;
    }
    const rx = px - this.pos[0], ry = py - this.pos[1], rz = pz - this.pos[2];
    const kn = this._effMass(rx, ry, rz, nx, 0, nz), wc = this._wc;
    this.lastImpact = Math.max(this.lastImpact, -vn);
    const lp = qRotateInv(this.q, rx, ry, rz, this._l);
    // a new crash, a harder one, or another part of the body slamming in (the tail swinging round): it crumples too
    const moved = Math.hypot(lp[0] - wc.lp[0], lp[2] - wc.lp[1]) > 1.0 && -vn > 2;
    if (wc.target === 0 || -vn > wc.v0 + 1.5 || moved) {
      wc.lp[0] = lp[0]; wc.lp[1] = lp[2];
      const ln = qRotateInv(this.q, nx, 0, nz, this._c);
      wc.k = this.stiffnessAt(ln) / Math.max(this.wallCrushFactor, 0.05) / (CRUSH_LOOK * CRUSH_LOOK);
      wc.target = Math.min(wc.s + Math.sqrt(vn * vn / kn / wc.k), 1.2);
      wc.v0 = -vn; wc.nx = nx; wc.nz = nz;
      if (-vn > 3) { wc.start = this.time; wc.hard = Math.min(-vn / 15, 1); }
      if (-vn > 2.5 && (!this._stepImpact || -vn > this._stepImpact.speed))
        this._stepImpact = { speed: -vn, px, py, pz, nx, ny: 0, nz, kind: 'wall', mu: 1 / kn };
    }
    const crumpling = wc.s < wc.target - 1e-4;
    const e = crumpling ? 0 : WALL_RESTITUTION;
    // every touching point pushes back (all at once, from the same motion — no point goes first), so a body lying
    // along the wall can't pivot off it; while crumpling, the total push is capped at k·s
    const lim = crumpling ? wc.k * Math.max(wc.s, 0.03) * this.dt : Infinity;
    if (!this._wallJ || this._wallJ.length < np) this._wallJ = new Float64Array(np);
    const J = this._wallJ;
    for (let it = 0; it < 3; it++) {
      let sum = 0;
      for (let i = 0; i < np; i++) {
        const q = pts[i], v = this._pointVel(q[0], q[1], q[2], nx, 0, nz);
        J[i] = v < 0 ? -(1 + e) * v / this._effMass(q[0] - this.pos[0], q[1] - this.pos[1], q[2] - this.pos[2], nx, 0, nz) / np : 0;
        sum += J[i];
      }
      if (sum <= 0) break;
      const f = Math.min(1, lim / sum);
      for (let i = 0; i < np; i++) {
        if (J[i] <= 0) continue;
        let ax = pts[i][0], ay = pts[i][1], az = pts[i][2];
        if (crumpling) {
          // the bumper beam and the crumpling structure spread a corner hit across the front (or side): the push
          // acts closer to the car's middle line, so a corner hit doesn't fling the car round
          const l = qRotateInv(this.q, ax - this.pos[0], ay - this.pos[1], az - this.pos[2], this._f);
          const ln = qRotateInv(this.q, nx, 0, nz, this._u);
          if (Math.abs(ln[2]) >= Math.abs(ln[0])) l[0] *= 0.35; else l[2] *= 0.35;
          const w = qRotate(this.q, l[0], l[1], l[2], this._f);
          ax = w[0] + this.pos[0]; ay = w[1] + this.pos[1]; az = w[2] + this.pos[2];
        }
        this._applyImpulse(ax, ay, az, nx * J[i] * f, 0, nz * J[i] * f);
      }
      if (crumpling) break;
    }
    // what is left of the approach this step goes into the crumple zone: the outline there is pushed in
    const left = this._pointVel(px, py, pz, nx, 0, nz);
    if (left < 0 && crumpling) {
      const g = Math.min(wc.target - wc.s, -left * this.dt);
      wc.s += g;
      const lc = qRotateInv(this.q, px - this.pos[0], 0, pz - this.pos[2], this._l), ln = qRotateInv(this.q, nx, 0, nz, this._u);
      this.pushIn(lc[0], lc[2], ln[0], ln[2], g, true);
    }
    // friction: crumpled metal grinding on the wall
    const vx = this.vel[0] + (this.w[1] * rz - this.w[2] * ry), vy = this.vel[1] + (this.w[2] * rx - this.w[0] * rz), vz = this.vel[2] + (this.w[0] * ry - this.w[1] * rx);
    const vnn = vx * nx + vz * nz;
    let tx = vx - vnn * nx, ty = vy, tz = vz - vnn * nz;
    const vt = Math.hypot(tx, ty, tz);
    if (vt > 1e-6) {
      tx /= vt; ty /= vt; tz /= vt;
      if (vt > 2.5 && (!this._stepScrape || vt > this._stepScrape.speed)) this._stepScrape = { speed: vt, px, py, pz, nx, ny: 0, nz, tx, ty, tz, kind: 'wall' };
      const jn = Math.max(0, -vn) / kn;
      const jt = Math.min(vt / this._effMass(rx, ry, rz, tx, ty, tz), 0.5 * Math.min(jn, lim));
      this._applyImpulse(px, py, pz, -tx * jt, -ty * jt, -tz * jt);
    }
  }

  _resolveContact(px, py, pz, nx, ny, nz, restitution, friction, kind) {
    const rx = px - this.pos[0], ry = py - this.pos[1], rz = pz - this.pos[2];
    const vx = this.vel[0] + (this.w[1] * rz - this.w[2] * ry);
    const vy = this.vel[1] + (this.w[2] * rx - this.w[0] * rz);
    const vz = this.vel[2] + (this.w[0] * ry - this.w[1] * rx);
    const vn = vx * nx + vy * ny + vz * nz;
    if (vn >= 0) return;
    this.lastImpact = Math.max(this.lastImpact, -vn);
    const kn = this._effMass(rx, ry, rz, nx, ny, nz);
    if (kind !== 'wall' && -vn > (this._stepImpact ? this._stepImpact.speed : 2.5)) this._stepImpact = { speed: -vn, px, py, pz, nx, ny, nz, kind, mu: 1 / kn };
    const e = -vn > 1.0 ? restitution : 0;
    const jn = -(1 + e) * vn / kn;
    // friction
    let tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    const vt = Math.hypot(tx, ty, tz);
    let jt = 0;
    if (vt > 1e-6) {
      tx /= vt; ty /= vt; tz /= vt;
      if (vt > 2.5 && (!this._stepScrape || vt > this._stepScrape.speed)) this._stepScrape = { speed: vt, px, py, pz, nx, ny, nz, tx, ty, tz, kind };
      const kt = this._effMass(rx, ry, rz, tx, ty, tz);
      jt = Math.min(vt / kt, friction * jn);
    }
    this._applyImpulse(px, py, pz, nx * jn - tx * jt, ny * jn - ty * jt, nz * jn - tz * jt);
  }

  // velocity of a body point along n
  _pointVel(px, py, pz, nx, ny, nz) {
    const rx = px - this.pos[0], ry = py - this.pos[1], rz = pz - this.pos[2];
    const vx = this.vel[0] + (this.w[1] * rz - this.w[2] * ry);
    const vy = this.vel[1] + (this.w[2] * rx - this.w[0] * rz);
    const vz = this.vel[2] + (this.w[0] * ry - this.w[1] * rx);
    return vx * nx + vy * ny + vz * nz;
  }

  _effMass(rx, ry, rz, nx, ny, nz) {
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    const ii = this._invInertiaWorld(cx, cy, cz, this._c);
    const kx = ii[1] * rz - ii[2] * ry, ky = ii[2] * rx - ii[0] * rz, kz = ii[0] * ry - ii[1] * rx;
    return 1 / this.m + (kx * nx + ky * ny + kz * nz);
  }

  // Advance by a frame time; returns interpolation alpha for rendering.
  update(frameDt, input) {
    this.accum += Math.min(frameDt, 0.1);
    while (this.accum >= this.dt) {
      this.prevPos.set(this.pos); this.prevQ.set(this.q);
      this._fixedStep(this.dt, input);
      this.accum -= this.dt;
    }
    return this.accum / this.dt;
  }

  // forward direction & handy telemetry
  telemetry() {
    return {
      speedKmh: this.speed * 3.6,
      rpm: this.rpm,
      gear: this.gear,

      throttle: this.ctl.throttle, brake: this.ctl.brake,
      slip: Math.max(...this.wheels.map(w => w.contact ? Math.hypot(w.slipRatio / 0.11, Math.tan(w.slipAngle) / 0.12) : 0)),
    };
  }
}

// How deep the body really folds compared with the crash model's crush (which sets the damage to the parts):
// the visible dents and the collision outline use this share, so a crash looks and drives like a real one.
export const CRUSH_LOOK = 0.55;
export const SIDE_CRUSH_MAX = 0.3;   // the deepest a door/sill folds in (m)
// height of the collision outline above the centre of mass (bumpers: wall hits don't roll the car)
const OUTLINE_Y = 0.02;
// crashes crumple the body instead of bouncing: almost all the closing speed is lost in the hit
export const WALL_RESTITUTION = 0.04;
export const CAR_RESTITUTION = 0.05;

// body outline sample points (unit square: x = side, z = length)
const WALL_POINTS = [];
for (const z of [-1, -0.6, -0.2, 0.2, 0.6, 1]) { WALL_POINTS.push([1, z], [-1, z]); }
for (const x of [-0.5, 0, 0.5]) { WALL_POINTS.push([x, 1], [x, -1]); }
const WHEEL_PROFILE = [-0.7, -0.35, 0, 0.35, 0.7];
const TOP_MARK = [0, 1, 0];
const BODY_CORNERS = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, -0.3, 0.3, 1]) BODY_CORNERS.push([x, y, z]);

// ---------------------------------------------------------------------------
// Several cars in one world: fixed-step integration + car-to-car contacts
// ---------------------------------------------------------------------------
const IDLE_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const _p = new Float64Array(3), _l = new Float64Array(3), _n = new Float64Array(3);

export class Simulation {
  constructor(world) {
    this.world = world;
    this.cars = [];
    this.dt = 1 / 480;
    this.accum = 0;
    this.time = 0;
    this.restitution = CAR_RESTITUTION;
    this.friction = 0.55;            // crumpled sheet metal snags: the cars move on together
    this.onCarHit = null;            // (a, b, closingSpeed m/s, previousClosing, point[3], normal b→a [3], effective mass kg)
    this.canCollide = () => true;    // (a, b) => bool
    this._pairs = new Map();
    this._nextId = 1;
  }

  add(v) { v._simId = this._nextId++; this.cars.push(v); return v; }
  remove(v) { const i = this.cars.indexOf(v); if (i >= 0) this.cars.splice(i, 1); }

  // advance by a frame time; returns the interpolation alpha for rendering
  step(frameDt) {
    this.accum += Math.min(frameDt, 0.1);
    while (this.accum >= this.dt) {
      for (const v of this.cars) {
        v.prevPos.set(v.pos); v.prevQ.set(v.q);
        v._fixedStep(this.dt, v.input || IDLE_INPUT);
      }
      this._contacts(this.dt);
      this.accum -= this.dt;
      this.time += this.dt;
    }
    for (const v of this.cars) v.accum = this.accum;
    return this.accum / this.dt;
  }

  _contacts(dt) {
    for (const st of this._pairs.values()) st.cool -= dt;
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        const dx = a.pos[0] - b.pos[0], dz = a.pos[2] - b.pos[2];
        if (dx * dx + dz * dz > 30) continue;          // far apart
        // one is jumping over (a car on its side or roof is taller and can land on the other: checked closer)
        if (Math.abs(a.pos[1] - b.pos[1]) > (a.wasTilted() || b.wasTilted() ? 3 : 1.1)) continue;
        if (!this.canCollide(a, b)) continue;
        this._pairContact(a, b);
      }
    }
  }

  // Outline points of `a` inside the (dented) outline of `b`, and the other way round. All touching points are
  // merged into one contact (their centroid, the deepest point's normal) so a square hit doesn't spin the cars.
  _pairContact(a, b) {
    const pts = this._pts || (this._pts = []);
    pts.length = 0;
    let best = null;
    // a car on its side or roof: points all over its body, against the other's whole body (roof, floor, leaning
    // sides); only the sideways part of the push is used (one resting on top of another is left to gravity)
    // ...also while one rests on top of the other (a car that landed on its wheels on someone's bonnet)
    const key = a._simId < b._simId ? a._simId * 100000 + b._simId : b._simId * 100000 + a._simId;
    const ps = this._pairs.get(key);
    if (a.wasTilted() || b.wasTilted() || Math.abs(a.pos[1] - b.pos[1]) > 0.3 || (ps && ps.restT > this.time - 0.5)) {
      const o = this._o4 || (this._o4 = new Float64Array(4));
      let top = null;                                 // one lying on the other: a contact facing up or down
      for (let pass = 0; pass < 2; pass++) {
        const A = pass === 0 ? a : b, B = pass === 0 ? b : a, s = A === a ? 1 : -1;
        const O = A.wasTilted() ? A.bodyPointsWorld() : A.outlineWorld();
        for (let i = 0; i < O.length; i += 3) {
          const px = O[i], py = O[i + 1], pz = O[i + 2];
          if (!B.bodyContains(px, py, pz, o)) continue;
          const h = Math.hypot(o[1], o[3]);
          if (h < 0.5) {
            if (!top || o[0] > top.depth) top = { depth: o[0], nx: o[1] * s, ny: o[2] * s, nz: o[3] * s, px, py, pz };
            continue;
          }
          const pt = { depth: Math.min(o[0] / h, 0.25), nx: o[1] / h * s, nz: o[3] / h * s, px, py, pz };
          pts.push(pt);
          if (!best || pt.depth > best.depth) best = pt;
        }
      }
      if (top) {
        this._restContact(a, b, top);
        let st = ps;
        if (!st) { st = { cool: 0, last: 0 }; this._pairs.set(key, st); }
        st.restT = this.time;
      }
    } else for (let pass = 0; pass < 2; pass++) {
      const A = pass === 0 ? a : b, B = pass === 0 ? b : a;
      const O = A.outlineWorld(), [BX, BZ] = B.outlineLocal(), m = BX.length;
      for (let i = 0; i < m; i++) {
        const px = O[i * 3], py = O[i * 3 + 1], pz = O[i * 3 + 2];
        qRotateInv(B.q, px - B.pos[0], py - B.pos[1], pz - B.pos[2], _l);
        if (Math.abs(_l[1]) > 0.8) continue;
        const lx = _l[0], lz = _l[2];
        // inside B's outline? (crossing test)
        let inside = false;
        for (let k = 0, j = m - 1; k < m; j = k++) {
          if ((BZ[k] > lz) !== (BZ[j] > lz) && lx < (BX[j] - BX[k]) * (lz - BZ[k]) / (BZ[j] - BZ[k]) + BX[k]) inside = !inside;
        }
        if (!inside) continue;
        // pushed out through the nearest edge
        let depth = Infinity, enx = 0, enz = 0;
        for (let k = 0, j = m - 1; k < m; j = k++) {
          const ex = BX[k] - BX[j], ez = BZ[k] - BZ[j], el = Math.hypot(ex, ez) || 1e-9;
          const t = clamp(((lx - BX[j]) * ex + (lz - BZ[j]) * ez) / (el * el), 0, 1);
          const dd = Math.hypot(lx - (BX[j] + ex * t), lz - (BZ[j] + ez * t));
          if (dd < depth) { depth = dd; enx = ez / el; enz = -ex / el; }   // outward normal of a CCW outline
        }
        qRotate(B.q, enx, 0, enz, _n);
        let nx = _n[0], nz = _n[2];
        const nl = Math.hypot(nx, nz) || 1;
        const s = A === a ? 1 : -1;                 // normal must point from b to a
        nx = nx / nl * s; nz = nz / nl * s;
        const pt = { depth, nx, nz, px, py, pz };
        pts.push(pt);
        if (!best || depth > best.depth) best = pt;
      }
    }
    if (!best) return;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const q of pts) if (q.nx * best.nx + q.nz * best.nz > 0.7) { cx += q.px; cy += q.py; cz += q.pz; n++; }
    this._resolve(a, b, cx / n, cy / n, cz / n, best.nx, best.nz);
    // whatever still overlaps (one step of motion) is pushed apart, half each — a deep overlap (a car landing on
    // another) over a few steps, not in one jump
    const corr = Math.min(Math.max(best.depth - 0.003, 0) * 0.5, 0.012);
    a.pos[0] += best.nx * corr; a.pos[2] += best.nz * corr;
    b.pos[0] -= best.nx * corr; b.pos[2] -= best.nz * corr;
  }

  // one car lying on (or under) another: a plain rigid contact along a 3D normal (from b to a), no crumpling
  _restContact(a, b, c) {
    const { px, py, pz, nx, ny, nz } = c;
    const rax = px - a.pos[0], ray = py - a.pos[1], raz = pz - a.pos[2];
    const rbx = px - b.pos[0], rby = py - b.pos[1], rbz = pz - b.pos[2];
    const rx = a.vel[0] + (a.w[1] * raz - a.w[2] * ray) - b.vel[0] - (b.w[1] * rbz - b.w[2] * rby);
    const ry = a.vel[1] + (a.w[2] * rax - a.w[0] * raz) - b.vel[1] - (b.w[2] * rbx - b.w[0] * rbz);
    const rz = a.vel[2] + (a.w[0] * ray - a.w[1] * rax) - b.vel[2] - (b.w[0] * rby - b.w[1] * rbx);
    const vn = rx * nx + ry * ny + rz * nz;
    if (vn < 0) {
      const kn = a._effMass(rax, ray, raz, nx, ny, nz) + b._effMass(rbx, rby, rbz, nx, ny, nz);
      const jn = -1.05 * vn / kn;
      let tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz, jt = 0;
      const vt = Math.hypot(tx, ty, tz);
      if (vt > 1e-6) {
        tx /= vt; ty /= vt; tz /= vt;
        const kt = a._effMass(rax, ray, raz, tx, ty, tz) + b._effMass(rbx, rby, rbz, tx, ty, tz);
        jt = Math.min(vt / kt, this.friction * jn);
      }
      const jx = nx * jn - tx * jt, jy = ny * jn - ty * jt, jz = nz * jn - tz * jt;
      a._applyImpulse(px, py, pz, jx, jy, jz);
      b._applyImpulse(px, py, pz, -jx, -jy, -jz);
    }
    // what still overlaps goes apart, the lighter car moving more
    const corr = Math.min(Math.max(c.depth - 0.004, 0), 0.05), ia = 1 / a.m, ib = 1 / b.m, fa = ia / (ia + ib);
    for (let k = 0; k < 3; k++) { const n = k === 0 ? nx : k === 1 ? ny : nz; a.pos[k] += n * corr * fa; b.pos[k] -= n * corr * (1 - fa); }
  }

  // stiffness of each body at the touching spot (the game can override it with its rules; Infinity = rigid)
  _stiffness(a, b, p, n) {
    if (this.contactStiffness) return this.contactStiffness(a, b, p, n);
    return { ka: a.stiffnessAt(a.dirToLocal(n)), kb: b.stiffnessAt(b.dirToLocal([-n[0], 0, -n[2]])) };
  }

  // Plastic crash: while the bodies crumple the push is k·s (s = how far they have crumpled so far, k = the two
  // stiffnesses in a row) — the cars run into each other and slow down over a few hundredths of a second, and the
  // ground they cover goes into dents in both outlines (the softer body takes more). Nothing is left overlapping,
  // so nothing pushes them back apart afterwards: no bounce, no getting stuck.
  _resolve(a, b, px, py, pz, nx, nz) {
    const rax = px - a.pos[0], ray = py - a.pos[1], raz = pz - a.pos[2];
    const rbx = px - b.pos[0], rby = py - b.pos[1], rbz = pz - b.pos[2];
    const vax = a.vel[0] + (a.w[1] * raz - a.w[2] * ray), vay = a.vel[1] + (a.w[2] * rax - a.w[0] * raz), vaz = a.vel[2] + (a.w[0] * ray - a.w[1] * rax);
    const vbx = b.vel[0] + (b.w[1] * rbz - b.w[2] * rby), vby = b.vel[1] + (b.w[2] * rbx - b.w[0] * rbz), vbz = b.vel[2] + (b.w[0] * rby - b.w[1] * rbx);
    const rx = vax - vbx, ry = vay - vby, rz = vaz - vbz;
    const vn = rx * nx + rz * nz;
    if (vn >= 0) return;
    const closing = -vn;
    // report the hit once per collision (and again if it gets harder while the cars are still touching)
    const key = a._simId < b._simId ? a._simId * 100000 + b._simId : b._simId * 100000 + a._simId;
    let st = this._pairs.get(key);
    if (!st) { st = { cool: 0, last: 0 }; this._pairs.set(key, st); }
    const kn = a._effMass(rax, ray, raz, nx, 0, nz) + b._effMass(rbx, rby, rbz, nx, 0, nz);
    if (closing > 2.0 && (st.cool <= 0 || closing > st.last + 1.5)) {
      const prev = st.cool > 0 ? st.last : 0;
      st.cool = 0.35; st.last = closing;
      const k = this._stiffness(a, b, [px, py, pz], [nx, 0, nz]);
      const ka = k.ka, kb = k.kb;
      st.ks = (ka === Infinity ? kb : kb === Infinity ? ka : ka * kb / (ka + kb)) / (CRUSH_LOOK * CRUSH_LOOK);
      st.shareA = ka === Infinity ? 0 : kb === Infinity ? 1 : kb / (ka + kb);
      if (prev === 0) st.s = 0;
      // how far the two bodies will crumple in this hit: ½·μ·v² = ½·k·s²
      st.target = Math.min((st.s || 0) + closing * Math.sqrt(1 / kn / st.ks), 1.6);
      if (this.onCarHit) this.onCarHit(a, b, closing, prev, [px, py, pz], [nx, 0, nz], 1 / kn);
    }
    if (st.cool <= 0) { st.target = 0; st.s = 0; }
    st.cool = Math.max(st.cool, 0.05);  // still touching
    const crumpling = st.target > 0 && st.s < st.target && st.ks < Infinity;
    let jn = -(1 + (crumpling || closing <= 1 ? 0 : this.restitution)) * vn / kn;
    if (crumpling) jn = Math.min(jn, st.ks * Math.max(st.s, 0.03) * this.dt);
    let tx = rx - vn * nx, ty = ry, tz = rz - vn * nz;
    const vt = Math.hypot(tx, ty, tz);
    let jt = 0;
    if (vt > 1e-6) {
      tx /= vt; ty /= vt; tz /= vt;
      const kt = a._effMass(rax, ray, raz, tx, ty, tz) + b._effMass(rbx, rby, rbz, tx, ty, tz);
      jt = Math.min(vt / kt, this.friction * jn);
    }
    const jx = nx * jn - tx * jt, jy = -ty * jt, jz = nz * jn - tz * jt;
    a._applyImpulse(px, py, pz, jx, jy, jz);
    b._applyImpulse(px, py, pz, -jx, -jy, -jz);
    if (crumpling) {
      // the approach left after this step's push goes into the dents
      const left = vn + jn * kn;
      if (left < 0) {
        const g = Math.min(st.target - st.s, -left * this.dt);
        st.s += g;
        const la = a.toLocal([px, py, pz], _p), lna = a.dirToLocal([nx, 0, nz], _l);
        a.pushIn(la[0], la[2], lna[0], lna[2], g * st.shareA);
        const lb = b.toLocal([px, py, pz], _p), lnb = b.dirToLocal([-nx, 0, -nz], _l);
        b.pushIn(lb[0], lb[2], lnb[0], lnb[2], g * (1 - st.shareA));
      }
    }
  }
}

// Put two cars in each other's place (position, orientation, motion)
export function swapVehicles(a, b) {
  for (const k of ['pos', 'q', 'vel', 'w', 'prevPos', 'prevQ']) {
    const t = Float64Array.from(a[k]); a[k].set(b[k]); b[k].set(t);
  }
  for (const v of [a, b]) {
    const f = qRotate(v.q, 0, 0, 1, v._a);
    const sp = v.vel[0] * f[0] + v.vel[1] * f[1] + v.vel[2] * f[2];
    for (const wh of v.wheels) wh.omega = sp / wh.radius;
    v.speed = sp;
  }
}
