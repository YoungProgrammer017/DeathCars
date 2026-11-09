// netcodec.js — what the online server sends 20 times a second and how a browser puts it back into its own copy
// of the game (shared by server.js and main.js).

const R3 = (x) => Math.round(x * 1000) / 1000;
const R4 = (x) => Math.round(x * 10000) / 10000;

export function packVehicle(v) {
  const d = v.damage, c = v.ctl || {};
  const o = [
    R3(v.pos[0]), R3(v.pos[1]), R3(v.pos[2]), R4(v.q[0]), R4(v.q[1]), R4(v.q[2]), R4(v.q[3]),
    R3(v.vel[0]), R3(v.vel[1]), R3(v.vel[2]),
    Math.round(v.rpm || 0), R3(c.throttle || 0), R3(c.brake || 0), v.gear || 1, R3(v.speed || 0), R3(v.boost || 0),
    (v.misfire ? 1 : 0) | (v.destroyed ? 2 : 0) | (v.frozen ? 4 : 0), R3(v.pushBar ?? 0),
    R3(d.engine), R3(d.gearbox), R3(d.body), R3(d.driver),
  ];
  for (let i = 0; i < 4; i++) o.push(R3(d.wheels[i]), R3(d.susp[i]), R3(d.brakes[i]));
  for (const wh of v.wheels) {
    o.push(R3(wh.length), R3(wh.steer), R3(wh.spin), R3(wh.omega), R3(wh.vLong || 0), R3(wh.vLat || 0),
      (wh.contact ? 1 : 0) | (wh.detached ? 2 : 0), R3(wh.cp[0]), R3(wh.cp[1]), R3(wh.cp[2]));
  }
  o.push(v.crush.length);
  for (let i = 0; i < v.crush.length; i++) o.push(R3(v.crush[i]));
  return o;
}

// first: no previous state to blend from (just created / teleported)
export function unpackVehicle(v, a, first) {
  let i = 0;
  if (first) { v.prevPos[0] = a[0]; v.prevPos[1] = a[1]; v.prevPos[2] = a[2]; }
  else v.prevPos.set(v.pos);
  v.prevQ.set(first ? [a[3], a[4], a[5], a[6]] : v.q);
  v.pos[0] = a[i++]; v.pos[1] = a[i++]; v.pos[2] = a[i++];
  v.q[0] = a[i++]; v.q[1] = a[i++]; v.q[2] = a[i++]; v.q[3] = a[i++];
  const ql = Math.hypot(v.q[0], v.q[1], v.q[2], v.q[3]) || 1;
  for (let k = 0; k < 4; k++) v.q[k] /= ql;
  v.vel[0] = a[i++]; v.vel[1] = a[i++]; v.vel[2] = a[i++];
  v.rpm = a[i++]; v.ctl.throttle = a[i++]; v.ctl.brake = a[i++]; v.gear = a[i++]; v.speed = a[i++]; v.boost = a[i++];
  const f = a[i++];
  v.misfire = !!(f & 1); v.destroyed = !!(f & 2); v.frozen = !!(f & 4);
  v.pushBar = a[i++];
  const d = v.damage;
  d.engine = a[i++]; d.gearbox = a[i++]; d.body = a[i++]; d.driver = a[i++];
  for (let k = 0; k < 4; k++) { d.wheels[k] = a[i++]; d.susp[k] = a[i++]; d.brakes[k] = a[i++]; }
  for (const wh of v.wheels) {
    wh.length = a[i++]; wh.steer = a[i++]; wh.spin = a[i++]; wh.omega = a[i++]; wh.vLong = a[i++]; wh.vLat = a[i++];
    const g = a[i++];
    wh.contact = !!(g & 1); wh.detached = !!(g & 2);
    wh.cp[0] = a[i++]; wh.cp[1] = a[i++]; wh.cp[2] = a[i++];
  }
  const n = a[i++];
  for (let k = 0; k < n && k < v.crush.length; k++) v.crush[k] = a[i + k];
}

export function packPlayer(p) {
  return {
    id: p.id, n: p.name, r: p.role, c: p.color, car: p.car, g: p.garage, m: p.money, a: p.alive, w: p.wreck || null,
    rd: !!p.ready, h: !!p.remote, wins: p.wins || 0, ch: p.charges, re: p.roundEarn, me: p.matchEarn || 0,
    at: Math.round((p.aliveTime || 0) * 10) / 10, k: p.roundKills || 0, v: packVehicle(p.vehicle),
  };
}

// events carry live objects (players, zones, decoys): send ids instead
export function eventReplacer(k, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v instanceof Set || v instanceof Map) return undefined;
    if (v.garage && v.vehicle) return v.id;                        // a player
    if (v.spec && v.wheels) return undefined;                      // a vehicle
    if (v.vehicle && v._nid) return { $d: v._nid };                // a decoy
    if (v.type && v._nid && k === 'zone') return { $z: v._nid };   // a zone
  }
  return v;
}

export function packZone(zn) {
  const o = {};
  for (const key in zn) {
    if (key === 'hit' || key === 'owner') continue;
    const val = zn[key];
    o[key] = typeof val === 'number' ? R3(val) : val;
  }
  return o;
}
