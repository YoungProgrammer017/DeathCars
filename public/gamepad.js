// Gamepads.
// Any pad works through the browser's Gamepad API (sticks, triggers, buttons, plain rumble where the browser has it).
// A DualSense can also be opened through WebHID (Chrome/Edge): then the game drives its adaptive triggers, its
// rumble motors and its light bar itself, over USB or Bluetooth.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const SONY = 0x054c, DUALSENSE = [0x0ce6, 0x0df2];   // DualSense, DualSense Edge
const BTN = ['cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2b', 'r2b', 'create', 'options', 'l3', 'r3', 'up', 'down', 'left', 'right', 'ps', 'touch'];
const HAT = [[1, 0, 0, 0], [1, 0, 0, 1], [0, 0, 0, 1], [0, 1, 0, 1], [0, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 0], [1, 0, 1, 0]]; // up, down, left, right

// ---------------------------------------------------------------- DualSense trigger effects (11 bytes each)
// The trigger's travel is split into 10 zones; each zone gets its own force (resistance) or vibration amplitude 1..8.
export function trigOff() { return [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }
function zones(code, str, freq) {
  let active = 0, force = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.round(str[i] || 0);
    if (s > 0) { active |= 1 << i; force += ((Math.min(s, 8) - 1) & 7) * 2 ** (3 * i); }
  }
  const f = [force % 256, Math.floor(force / 256) % 256, Math.floor(force / 65536) % 256, Math.floor(force / 16777216) % 256];
  return code === 0x21 ? [0x21, active & 255, active >> 8, f[0], f[1], f[2], f[3], 0, 0, 0, 0]
    : [0x26, active & 255, active >> 8, f[0], f[1], f[2], f[3], 0, 0, clamp(Math.round(freq), 1, 255), 0];
}
// resistance per zone (0 = free, 1..8)
export const trigFeedback = (str) => zones(0x21, str);
// vibration per zone (0 = none, 1..8) at `freq` Hz
export const trigVibration = (amp, freq) => zones(0x26, amp, freq);

// CRC-32 (Bluetooth output reports carry one)
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes, crc = 0xffffffff) { for (const b of bytes) crc = CRC_T[(crc ^ b) & 255] ^ (crc >>> 8); return crc >>> 0; }

// the 47-byte body of an output report
export function dsCommon(o) {
  const c = new Uint8Array(47);
  c[0] = 0x02 | (o.v2 ? 0 : 0x01) | (o.trig ? 0x0c : 0);     // rumble (classic style) + both trigger effects
  c[1] = 0x04 | 0x10;                                          // light bar colour + player LEDs
  c[2] = Math.round(clamp(o.weak, 0, 1) * 255);                // right motor: light, fast buzz
  c[3] = Math.round(clamp(o.strong, 0, 1) * 255);              // left motor: heavy thump
  if (o.trig) { c.set(o.r2, 10); c.set(o.l2, 21); }
  c[38] = (o.v2 ? 0x04 : 0) | (o.setup ? 0x02 : 0);
  if (o.setup) c[41] = 0x02;                                   // let go of the default blue glow so our colour shows
  c[42] = 0;                                                   // LED brightness: full
  c[43] = o.leds || 0x04;
  c[44] = o.rgb[0]; c[45] = o.rgb[1]; c[46] = o.rgb[2];
  return c;
}
// Bluetooth report 0x31: [seq, tag, common(47), 24 zero bytes, crc32] — the CRC also covers 0xA2 and the report id
export function dsBluetooth(common, seq) {
  const d = new Uint8Array(77);
  d[0] = (seq & 15) << 4; d[1] = 0x10;
  d.set(common, 2);
  const crc = ~crc32(d.subarray(0, 73), crc32([0xa2, 0x31])) >>> 0;
  d[73] = crc & 255; d[74] = (crc >>> 8) & 255; d[75] = (crc >>> 16) & 255; d[76] = crc >>> 24;
  return d;
}
// an input report (without its id) → pad state; USB 0x01 (63 bytes), Bluetooth 0x31 (77) or Bluetooth's short 0x01 (9)
export function dsParse(id, d) {
  let lx, ly, rx, ry, l2, r2, b0, b1, b2;
  if (id === 0x01 && d.byteLength < 20) {
    [lx, ly, rx, ry, b0, b1, b2, l2, r2] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => d.getUint8(i));
  } else {
    const o = id === 0x31 ? 1 : 0;
    if (d.byteLength < o + 10) return null;
    [lx, ly, rx, ry, l2, r2] = [0, 1, 2, 3, 4, 5].map((i) => d.getUint8(o + i));
    b0 = d.getUint8(o + 7); b1 = d.getUint8(o + 8); b2 = d.getUint8(o + 9);
  }
  const ax = (v) => clamp((v - 128) / 127.5, -1, 1);
  const hat = HAT[b0 & 15] || [0, 0, 0, 0];
  const b = {
    square: !!(b0 & 0x10), cross: !!(b0 & 0x20), circle: !!(b0 & 0x40), triangle: !!(b0 & 0x80),
    l1: !!(b1 & 1), r1: !!(b1 & 2), l2b: !!(b1 & 4), r2b: !!(b1 & 8), create: !!(b1 & 16), options: !!(b1 & 32), l3: !!(b1 & 64), r3: !!(b1 & 128),
    ps: !!(b2 & 1), touch: !!(b2 & 2), up: !!hat[0], down: !!hat[1], left: !!hat[2], right: !!hat[3],
  };
  return { lx: ax(lx), ly: ax(ly), rx: ax(rx), ry: ax(ry), l2: l2 / 255, r2: r2 / 255, b };
}

const hexRgb = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0x3d8bff; return [n >> 16, (n >> 8) & 255, n & 255]; };

export class Pads {
  constructor() {
    this.state = null;          // {lx, ly, rx, ry, l2, r2, b:{...}} of the pad in use
    this.prev = {};
    this.kind = '';             // 'dualsense' (WebHID) | 'pad' (Gamepad API) | ''
    this.name = '';
    this.hid = null;            // {dev, bt, seq, last, v2, sent, sentAt, state, at}
    this.rumbleMul = 0.8;
    this.trigOn = true;
    this.lightRgb = [61, 139, 255];
    this.impulses = [];
    this.tele = { air: 0, vy: 0, gear: 1, shift: 0 };
    this.out = { strong: 0, weak: 0, r2: trigOff(), l2: trigOff() };
    this.onStatus = () => {};
    this.gpLast = 0;
    if (typeof navigator !== 'undefined' && navigator.hid) {
      navigator.hid.addEventListener('disconnect', (e) => { if (this.hid && e.device === this.hid.dev) { this.hid = null; this.onStatus('DualSense отключён'); } });
      navigator.hid.addEventListener('connect', (e) => { if (!this.hid && this._isDs(e.device)) this._open(e.device); });
    }
  }
  get hidSupported() { return typeof navigator !== 'undefined' && !!navigator.hid; }
  _isDs(d) { return d.vendorId === SONY && DUALSENSE.includes(d.productId); }

  // ------------------------------------------------------------ DualSense over WebHID
  async connectDualSense() {
    if (!this.hidSupported) throw new Error('Этот браузер не умеет WebHID — нужен Chrome или Edge на компьютере');
    const devs = await navigator.hid.requestDevice({ filters: DUALSENSE.map((productId) => ({ vendorId: SONY, productId })) });
    if (!devs.length) return false;
    await this._open(devs[0]);
    return true;
  }
  async autoConnect() {
    if (!this.hidSupported) return;
    try { const devs = (await navigator.hid.getDevices()).filter((d) => this._isDs(d)); if (devs.length) await this._open(devs[0]); } catch (_) { /* not allowed here */ }
  }
  async _open(dev) {
    if (!dev.opened) await dev.open();
    const bt = dev.collections.some((c) => (c.outputReports || []).some((r) => r.reportId === 0x31));
    const h = { dev, bt, seq: 0, v2: true, sent: '', sentAt: 0, setup: true, state: null, at: 0 };
    // firmware 2.21+ wants the newer rumble flag
    try {
      const f = await dev.receiveFeatureReport(0x20);
      const off = f.byteLength >= 64 ? 44 : 43;               // with or without the report id in front
      h.v2 = f.getUint16(off, true) >= 0x0215;
    } catch (_) { /* keep the newer style */ }
    // Bluetooth: reading the calibration switches the pad to its full reports (0x31)
    if (bt) { try { await dev.receiveFeatureReport(0x05); } catch (_) { /* ignore */ } }
    dev.addEventListener('inputreport', (e) => {
      const s = dsParse(e.reportId, e.data);
      if (s) { h.state = s; h.at = performance.now(); }
    });
    this.hid = h;
    this.onStatus(`DualSense подключён (${bt ? 'Bluetooth' : 'USB'}): триггеры и вибрация работают`);
    this._send(true);
  }
  _send(force) {
    const h = this.hid;
    if (!h) return;
    const now = performance.now();
    const o = this.out;
    const key = [Math.round(o.strong * 40), Math.round(o.weak * 40), o.r2.join(','), o.l2.join(','), this.lightRgb.join(',')].join('|');
    if (!force && (key === h.sent ? now - h.sentAt < 1000 : now - h.sentAt < 25)) return;
    h.sent = key; h.sentAt = now;
    const common = dsCommon({ strong: o.strong, weak: o.weak, trig: true, r2: o.r2, l2: o.l2, rgb: this.lightRgb, v2: h.v2, setup: h.setup });
    h.setup = false;
    const p = h.bt ? h.dev.sendReport(0x31, dsBluetooth(common, h.seq++)) : h.dev.sendReport(0x02, common);
    p.catch(() => {});
  }

  // ------------------------------------------------------------ reading
  poll() {
    this.prev = this.state ? this.state.b : {};
    const h = this.hid;
    if (h && h.state && performance.now() - h.at < 600) {
      this.state = h.state; this.kind = 'dualsense'; this.name = 'DualSense';
      return this.state;
    }
    let gp = null;
    const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of list) {
      if (!g || !g.connected) continue;
      if (h && /054c/i.test(g.id) && h.state) continue;            // the same DualSense, already read over HID
      if (!gp || (g.mapping === 'standard' && gp.mapping !== 'standard') || g.timestamp > gp.timestamp + 2000) gp = g;
    }
    if (!gp) { this.state = null; this.kind = ''; this.pad = null; return null; }
    const bv = (i) => { const x = gp.buttons[i]; return x ? (typeof x === 'object' ? x.value : x) : 0; };
    const b = {};
    BTN.forEach((n, i) => { b[n] = bv(i) > 0.5; });
    const a = (i) => clamp(gp.axes[i] || 0, -1, 1);
    this.state = { lx: a(0), ly: a(1), rx: a(2), ry: a(3), l2: bv(6), r2: bv(7), b };
    this.kind = 'pad'; this.name = gp.id; this.pad = gp;
    return this.state;
  }
  pressed(n) { return !!(this.state && this.state.b[n] && !this.prev[n]); }
  held(n) { return !!(this.state && this.state.b[n]); }
  // something touched (to wake things up)
  get busy() {
    const s = this.state;
    return !!s && (Math.abs(s.lx) > 0.3 || Math.abs(s.rx) > 0.3 || s.l2 > 0.1 || s.r2 > 0.1 || Object.values(s.b).some(Boolean));
  }
  // driving input: steering on the left stick (a little curve for fine control), R2 gas, L2 brake, Cross handbrake
  drive() {
    const s = this.state;
    if (!s) return null;
    const dz = 0.08, x = Math.abs(s.lx) < dz ? 0 : Math.sign(s.lx) * Math.pow((Math.abs(s.lx) - dz) / (1 - dz), 1.35);
    return { throttle: s.r2 < 0.04 ? 0 : s.r2, brake: s.l2 < 0.04 ? 0 : s.l2, steer: -x, handbrake: s.b.cross };
  }

  // ------------------------------------------------------------ feeling
  // a short kick: strong = heavy motor, weak = light motor, 0..1, for `dur` seconds (fades out)
  kick(strong, weak, dur) { this.impulses.push({ s: strong, w: weak, dur, t: 0 }); if (this.impulses.length > 12) this.impulses.shift(); }

  // v: the player's car while driving (null in menus, dead, etc); inp: what the player is pressing
  feedback(dt, v, inp) {
    let strong = 0, weak = 0, r2 = trigOff(), l2 = trigOff();
    const T = this.tele;
    if (T.shift > 0) T.shift -= dt;
    if (v) {
      const sp = v.spec, e = sp.engine;
      const speedFrac = clamp(Math.abs(v.speed) / sp.vmax, 0, 1);
      const rpmFrac = clamp((v.rpm - e.idle) / (e.limiter - e.idle), 0, 1);
      // tyres: wheelspin (positive slip under power), lock-up (negative under braking), sideways slide
      let spin = 0, lock = 0, slide = 0, onGround = 0, thump = 0;
      for (const w of v.wheels) {
        if (w.detached) continue;
        if (!w.contact) continue;
        onGround++;
        const vl = w.vLong || 0, s = (w.omega * w.radius - vl) / Math.max(2, Math.abs(vl));
        if (s > spin) spin = s;
        if (-s > lock) lock = -s;
        slide = Math.max(slide, Math.abs(w.vLat || 0));
        // a burst or bent wheel thumps once a turn
        if (w.gripMul !== undefined && w.gripMul < 0.75 && Math.sin(w.spin || 0) > 0.85) thump = Math.max(thump, 0.35 * clamp(Math.abs(vl) / 15, 0, 1));
      }
      spin = clamp(spin, 0, 2); lock = clamp(lock, 0, 1);
      const thr = inp ? inp.throttle : 0, brk = inp ? inp.brake : 0;
      // gear change: a little thump, and a kick in the gas trigger when shifting up under power
      if (v.gear !== T.gear) {
        if (T.gear !== undefined && v.gear > 0 && T.gear > 0) {
          if (v.gear > T.gear && thr > 0.3) T.shift = 0.09;
          this.kick(v.gear > T.gear ? 0.28 : 0.16, 0.12, 0.08);
        }
        T.gear = v.gear;
      }
      // landing after a jump
      if (onGround === 0) { T.air += dt; T.vy = Math.min(T.vy, v.vel[1]); }
      else { if (T.air > 0.25 && T.vy < -2) this.kick(clamp(-T.vy / 9, 0.2, 1), 0.3, 0.18); T.air = 0; T.vy = 0; }
      const limiter = v.rpm > e.limiter - 250 && thr > 0.8;
      const reversing = v.gear === -1;
      // continuous rumble: road under the tyres, engine, slides, wheelspin, lock-ups, a bad wheel
      if (onGround) {
        weak += 0.03 + 0.06 * speedFrac + 0.06 * thr * rpmFrac;
        weak += clamp((slide - 1.5) * 0.05, 0, 0.35);
        if (thr > 0.2 && spin > 0.25) weak += 0.18 * clamp(spin - 0.25, 0, 1);
        if (brk > 0.2 && lock > 0.3 && Math.abs(v.speed) > 3) strong += 0.22 * lock;
        if (limiter) weak += 0.12;
        strong += thump;
      }
      if (v.boost > 0) weak += 0.2;
      // ---- adaptive triggers
      // gas: gets heavier the faster you go; kicks on a gear change; shudders on wheelspin and on the rev limiter
      const gas = (sf) => { const s = []; for (let i = 0; i < 10; i++) s.push(clamp(1 + sf * 3.2 + i * (0.22 + 0.4 * sf), 1, 8)); return trigFeedback(s); };
      const ramp = (from, a) => { const s = []; for (let i = 0; i < 10; i++) s.push(i < from ? 0 : a); return s; };
      if (T.shift > 0 && !reversing) r2 = trigVibration(ramp(0, 8), 28);
      else if (!reversing && thr > 0.2 && spin > 0.3 && onGround) r2 = trigVibration(ramp(2, 2 + 6 * clamp((spin - 0.3) / 0.7, 0, 1)), 30 + 35 * clamp(spin, 0, 1));
      else if (limiter) r2 = trigVibration(ramp(5, 3), 70);
      else if (v.boost > 0) r2 = trigVibration(ramp(0, 3), 45);
      else if (reversing) r2 = trigFeedback(ramp(0, 3));                        // in reverse R2 is the brake
      else r2 = gas(speedFrac);
      // brake: a little free travel, then it firms up towards the end (firmer at speed); shudders when the wheels lock
      if (reversing) l2 = gas(speedFrac);                                       // ...and L2 is the gas
      else if (brk > 0.2 && lock > 0.3 && Math.abs(v.speed) > 3) l2 = trigVibration(ramp(2, 4 + 4 * lock), 18 + 14 * lock);
      else { const k = 0.55 + 0.45 * speedFrac, s = []; for (let i = 0; i < 10; i++) s.push(i < 2 ? 0 : clamp((2 + (i - 2) * 0.95) * k, 1, 8)); l2 = trigFeedback(s); }
    } else { T.gear = undefined; T.air = 0; T.vy = 0; T.shift = 0; }
    // impulses (hits, explosions, landings, shifts)
    for (let i = this.impulses.length - 1; i >= 0; i--) {
      const k = this.impulses[i];
      k.t += dt;
      if (k.t >= k.dur) { this.impulses.splice(i, 1); continue; }
      const f = 1 - k.t / k.dur;
      strong = Math.max(strong, k.s * f); weak = Math.max(weak, k.w * f);
    }
    const m = this.rumbleMul;
    this.out.strong = clamp(strong * m, 0, 1); this.out.weak = clamp(weak * m, 0, 1);
    this.out.r2 = this.trigOn ? r2 : trigOff(); this.out.l2 = this.trigOn ? l2 : trigOff();
    this._apply();
  }
  // everything off (menus, page hidden)
  quiet() { this.impulses.length = 0; this.out = { strong: 0, weak: 0, r2: trigOff(), l2: trigOff() }; this._apply(true); }
  setColor(hex) { this.lightRgb = hexRgb(hex); }

  _apply(force) {
    if (this.hid) { this._send(force); return; }
    // other pads: the browser's rumble (and the Xbox trigger motors where available)
    const g = this.pad, act = g && g.vibrationActuator;
    if (!act || !act.playEffect) return;
    const o = this.out, now = performance.now();
    const on = o.strong > 0.02 || o.weak > 0.02;
    if (!on && !this.gpOn) return;
    if (!force && now - this.gpLast < 70 && on) return;
    this.gpLast = now; this.gpOn = on;
    const fx = { startDelay: 0, duration: 120, strongMagnitude: o.strong, weakMagnitude: o.weak };
    try {
      if (!on && act.reset) act.reset().catch(() => {});
      else if (act.effects && act.effects.includes && act.effects.includes('trigger-rumble')) {
        const t = (e) => (e[0] === 0x26 ? 0.25 + e[9] / 255 : 0);
        act.playEffect('trigger-rumble', { ...fx, leftTrigger: t(o.l2) * 0.6, rightTrigger: t(o.r2) * 0.6 }).catch(() => {});
      } else act.playEffect('dual-rumble', fx).catch(() => {});
    } catch (_) { /* ignore */ }
  }
}
