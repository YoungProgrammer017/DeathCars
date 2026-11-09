// audio.js — every sound of the game, synthesised with WebAudio (no sound files):
//   engines (pitch from the rpm, tone from the throttle; other cars in 3D around the camera), tyre squeal,
//   crashes (thump + crunch + ringing metal), scraping, explosions, talents, the crowd, countdown and upgrader.
// Nothing here can break the game: without WebAudio every call is a no-op.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// cylinders → firing pulses per revolution / 2 (sets the engine's note)
const ENGINE = {
  smallcar: { cyl: 4, tone: 1.0 }, zuk: { cyl: 4, tone: 0.8 }, vaz2107: { cyl: 4, tone: 0.9 }, punto: { cyl: 4, tone: 1.15 },
  datsun: { cyl: 6, tone: 1.0 }, fulvia: { cyl: 4, tone: 1.2 }, alfa33: { cyl: 8, tone: 1.25 }, porsche930: { cyl: 6, tone: 1.1 },
  charger: { cyl: 8, tone: 0.75 }, police: { cyl: 8, tone: 1.0 }, gt3r: { cyl: 6, tone: 1.35 }, m3a1: { cyl: 6, tone: 0.6 },
  armored: { cyl: 8, tone: 0.5 },
};

export class GameAudio {
  constructor() {
    this.ctx = null; this.master = null; this.volume = 0.8; this.muted = false;
    this.cars = new Map();        // key -> engine voice
    this.ok = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  // browsers start audio only after a click / key press
  unlock() {
    if (!this.ok) return;
    try {
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { this.ok = false; }
  }
  setVolume(v) { this.volume = v; this._applyVolume(); }
  toggleMute() { this.muted = !this.muted; this._applyVolume(); return this.muted; }
  _applyVolume() { if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05); }

  _build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();              // crashes stacked on engines shouldn't clip
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    this._applyVolume();
    // 2 s of white noise, looped by every noisy sound
    const n = ctx.sampleRate * 2, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // soft clipping for the engines' grit
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 2.2); }
    this.curve = curve;
    // the crowd: a low murmur that swells now and then
    const crowd = this._noiseSrc(), cf = ctx.createBiquadFilter(), cg = ctx.createGain();
    cf.type = 'bandpass'; cf.frequency.value = 520; cf.Q.value = 0.6;
    cg.gain.value = 0.035;
    crowd.connect(cf); cf.connect(cg); cg.connect(this.master); crowd.start();
    this.crowdGain = cg;
  }

  _noiseSrc() { const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true; s.loopStart = Math.random(); return s; }
  _panner(p) {
    const pn = this.ctx.createPanner();
    pn.panningModel = 'equalpower'; pn.distanceModel = 'inverse'; pn.refDistance = 7; pn.rolloffFactor = 1.1; pn.maxDistance = 400;
    if (p) this._place(pn, p);
    return pn;
  }
  _place(pn, p) {
    const t = this.ctx.currentTime;
    if (pn.positionX) { pn.positionX.setTargetAtTime(p[0], t, 0.02); pn.positionY.setTargetAtTime(p[1], t, 0.02); pn.positionZ.setTargetAtTime(p[2], t, 0.02); }
    else pn.setPosition(p[0], p[1], p[2]);
  }
  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ---------------------------------------------------------------- per frame
  // cars: [{ key, carId, pos:[x,y,z], rpm, throttle, speed (m/s), slip (m/s), alive, boost }]
  update(dt, camera, cars, crowdLevel = 1) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime, L = ctx.listener;
    // the listener rides with the camera
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10], ux = e[4], uy = e[5], uz = e[6];
    if (L.positionX) {
      L.positionX.setTargetAtTime(e[12], t, 0.02); L.positionY.setTargetAtTime(e[13], t, 0.02); L.positionZ.setTargetAtTime(e[14], t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02); L.forwardY.setTargetAtTime(fy, t, 0.02); L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.setTargetAtTime(ux, t, 0.02); L.upY.setTargetAtTime(uy, t, 0.02); L.upZ.setTargetAtTime(uz, t, 0.02);
    } else { L.setPosition(e[12], e[13], e[14]); L.setOrientation(fx, fy, fz, ux, uy, uz); }
    this.crowdGain.gain.setTargetAtTime(0.03 * crowdLevel, t, 0.5);

    const seen = new Set();
    for (const c of cars) {
      seen.add(c.key);
      let v = this.cars.get(c.key);
      if (!v || v.carId !== c.carId) { if (v) this._dropVoice(v); v = this._engineVoice(c.carId); this.cars.set(c.key, v); }
      this._place(v.pan, c.pos);
      const eng = ENGINE[c.carId] || ENGINE.smallcar;
      const on = c.alive;
      const f = Math.max(c.rpm, 600) / 60 * eng.cyl / 2 * eng.tone;
      const thr = clamp(c.throttle, 0, 1), load = on ? 0.35 + 0.65 * thr : 0;
      v.o1.frequency.setTargetAtTime(f, t, 0.03);
      v.o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
      v.o3.frequency.setTargetAtTime(f * 2.01, t, 0.03);
      v.lp.frequency.setTargetAtTime(300 + f * (2.5 + 5 * thr) + (c.boost ? 1500 : 0), t, 0.05);
      v.eg.gain.setTargetAtTime(on ? (0.05 + 0.11 * load) * (c.boost ? 1.4 : 1) : 0, t, on ? 0.05 : 0.4);
      // tyres: squeal once the wheels slide
      const sq = on || c.speed > 1 ? clamp((c.slip - 2.5) / 7, 0, 1) * clamp(c.speed / 6, 0.3, 1) : 0;
      v.sg.gain.setTargetAtTime(sq * 0.16, t, 0.04);
      v.sf.frequency.setTargetAtTime(700 + 500 * sq + c.speed * 4, t, 0.05);
      // scraping metal fades by itself
      v.scrape *= Math.exp(-dt * 7);
      v.cg.gain.setTargetAtTime(v.scrape * 0.2, t, 0.03);
      // wind for fast cars (heard mostly from your own: it's close to the camera)
      v.wg.gain.setTargetAtTime(clamp((c.speed - 15) / 50, 0, 1) * 0.05, t, 0.2);
    }
    for (const [k, v] of this.cars) if (!seen.has(k)) { this._dropVoice(v); this.cars.delete(k); }
  }

  _engineVoice(carId) {
    const ctx = this.ctx, pan = this._panner();
    pan.connect(this.master);
    const v = { carId, pan, scrape: 0 };
    // engine: saw + sub square + a buzzy overtone, soft-clipped, low-passed (opens with the throttle)
    v.o1 = ctx.createOscillator(); v.o1.type = 'sawtooth';
    v.o2 = ctx.createOscillator(); v.o2.type = 'square';
    v.o3 = ctx.createOscillator(); v.o3.type = 'triangle';
    const g1 = ctx.createGain(), g2 = ctx.createGain(), g3 = ctx.createGain();
    g1.gain.value = 0.5; g2.gain.value = 0.35; g3.gain.value = 0.18;
    const ws = ctx.createWaveShaper(); ws.curve = this.curve;
    v.lp = ctx.createBiquadFilter(); v.lp.type = 'lowpass'; v.lp.Q.value = 1.4;
    v.eg = ctx.createGain(); v.eg.gain.value = 0;
    v.o1.connect(g1); v.o2.connect(g2); v.o3.connect(g3);
    g1.connect(ws); g2.connect(ws); g3.connect(ws);
    // a little noise in the intake
    v.n = this._noiseSrc(); const nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.7; ng.gain.value = 0.08;
    v.n.connect(nf); nf.connect(ng); ng.connect(ws);
    ws.connect(v.lp); v.lp.connect(v.eg); v.eg.connect(pan);
    // tyres
    v.sf = ctx.createBiquadFilter(); v.sf.type = 'bandpass'; v.sf.Q.value = 6;
    v.sg = ctx.createGain(); v.sg.gain.value = 0;
    v.n.connect(v.sf); v.sf.connect(v.sg); v.sg.connect(pan);
    // scraping
    const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 2600; cf.Q.value = 2;
    v.cg = ctx.createGain(); v.cg.gain.value = 0;
    v.n.connect(cf); cf.connect(v.cg); v.cg.connect(pan);
    // wind
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 500;
    v.wg = ctx.createGain(); v.wg.gain.value = 0;
    v.n.connect(wf); wf.connect(v.wg); v.wg.connect(pan);
    for (const o of [v.o1, v.o2, v.o3, v.n]) o.start();
    v.nodes = [v.o1, v.o2, v.o3, v.n];
    return v;
  }
  _dropVoice(v) {
    const t = this.ctx.currentTime;
    v.eg.gain.setTargetAtTime(0, t, 0.05); v.sg.gain.setTargetAtTime(0, t, 0.05);
    for (const o of v.nodes) { try { o.stop(t + 0.3); } catch (_) { /* ignore */ } }
    setTimeout(() => { try { v.pan.disconnect(); } catch (_) { /* ignore */ } }, 600);
  }

  scrape(key, speed) {
    const v = this.cars.get(key);
    if (v) v.scrape = Math.max(v.scrape, clamp(speed / 18, 0.2, 1));
  }

  // ---------------------------------------------------------------- one-shots
  _ready() { return this.ctx && this.ctx.state === 'running'; }

  // a crash: a low thump, the crunch of folding metal and a short ring; s 0..1.5
  impact(p, s, kind = 'car') {
    if (!this._ready() || s < 0.03) return;
    // both cars of a crash report it: one sound
    const lt = this._lastHit, now = this.ctx.currentTime;
    if (lt && now - lt.t < 0.06 && Math.hypot(p[0] - lt.p[0], p[2] - lt.p[2]) < 3) return;
    this._lastHit = { t: now, p: [p[0], p[1], p[2]] };
    const ctx = this.ctx, t = ctx.currentTime, pan = this._panner(p), out = ctx.createGain();
    out.gain.value = clamp(0.35 + s * 0.7, 0, 1.2);
    out.connect(pan); pan.connect(this.master);
    // thump
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(kind === 'wall' ? 75 : 95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    this._env(og, t, 0.9, 0.005, 0.3); o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.4);
    // crunch
    const n = this._noiseSrc(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 1200 + Math.random() * 900; nf.Q.value = 0.8;
    this._env(ng, t, 0.8, 0.004, 0.18 + 0.35 * Math.min(s, 1)); n.connect(nf); nf.connect(ng); ng.connect(out); n.start(t); n.stop(t + 0.7);
    // crackle of the crumpling: a few short clicks
    for (let i = 0; i < 2 + Math.round(s * 4); i++) {
      const c = this._noiseSrc(), cf = ctx.createBiquadFilter(), cg = ctx.createGain(), tt = t + 0.02 + Math.random() * 0.15 * (1 + s);
      cf.type = 'highpass'; cf.frequency.value = 2500;
      this._env(cg, tt, 0.4, 0.002, 0.04); c.connect(cf); cf.connect(cg); cg.connect(out); c.start(tt); c.stop(tt + 0.1);
    }
    // ringing sheet metal
    for (let i = 0; i < 3; i++) {
      const m = ctx.createOscillator(), mg = ctx.createGain();
      m.type = 'triangle'; m.frequency.value = 280 + Math.random() * 900;
      this._env(mg, t, 0.06 * Math.min(s, 1), 0.003, 0.25 + Math.random() * 0.3); m.connect(mg); mg.connect(out); m.start(t); m.stop(t + 0.7);
    }
    setTimeout(() => { try { pan.disconnect(); } catch (_) { /* ignore */ } }, 1500);
  }

  explode(p) {
    if (!this._ready()) return;
    const ctx = this.ctx, t = ctx.currentTime, pan = this._panner(p), out = ctx.createGain();
    out.gain.value = 1.4; out.connect(pan); pan.connect(this.master);
    const n = this._noiseSrc(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(150, t + 1.4);
    this._env(g, t, 1.0, 0.01, 1.6); n.connect(lp); lp.connect(g); g.connect(out); n.start(t); n.stop(t + 1.8);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    this._env(og, t, 1.0, 0.01, 0.9); o.connect(og); og.connect(out); o.start(t); o.stop(t + 1.0);
    this.cheer(0.8);
    setTimeout(() => { try { pan.disconnect(); } catch (_) { /* ignore */ } }, 2500);
  }

  // the crowd roars
  cheer(s = 0.6) {
    if (!this._ready()) return;
    const ctx = this.ctx, t = ctx.currentTime, n = this._noiseSrc(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12 * s, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    n.connect(f); f.connect(g); g.connect(this.master); n.start(t); n.stop(t + 2.8);
  }

  // talents and other little things
  fx(kind, p) {
    if (!this._ready()) return;
    const ctx = this.ctx, t = ctx.currentTime, pan = this._panner(p), out = ctx.createGain();
    out.gain.value = 0.7; out.connect(pan); pan.connect(this.master);
    const tone = (type, f0, f1, dur, peak = 0.5, at = t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      this._env(g, at, peak, 0.01, dur); o.connect(g); g.connect(out); o.start(at); o.stop(at + dur + 0.05);
    };
    const hiss = (type, f0, f1, dur, peak = 0.5, q = 1, at = t) => {
      const n = this._noiseSrc(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, at); f.frequency.exponentialRampToValueAtTime(f1, at + dur);
      this._env(g, at, peak, 0.02, dur); n.connect(f); f.connect(g); g.connect(out); n.start(at); n.stop(at + dur + 0.05);
    };
    switch (kind) {
      case 'nitro': hiss('bandpass', 400, 3000, 0.9, 0.7, 1.2); tone('sawtooth', 120, 420, 0.8, 0.15); break;
      case 'jump': tone('sine', 180, 720, 0.35, 0.5); hiss('lowpass', 800, 200, 0.3, 0.4); break;
      case 'oil': case 'glue': hiss('lowpass', 900, 120, 0.5, 0.8); break;
      case 'spikes': for (let i = 0; i < 4; i++) tone('square', 1800 + i * 300, 900, 0.08, 0.15, t + i * 0.05); break;
      case 'harpoon': hiss('highpass', 1500, 5000, 0.25, 0.5); tone('square', 600, 120, 0.2, 0.2, t + 0.25); break;
      case 'smoke': hiss('lowpass', 2500, 400, 1.6, 0.6); break;
      case 'decoy': case 'swap': tone('sine', 300, 1400, 0.5, 0.3); tone('sine', 1400, 300, 0.5, 0.2, t + 0.15); break;
      case 'repair': for (let i = 0; i < 6; i++) hiss('highpass', 3000, 3000, 0.03, 0.4, 1, t + i * 0.08); break;
      case 'puncture': hiss('highpass', 2000, 900, 0.6, 0.7); break;
      case 'wheel': tone('square', 900, 260, 0.12, 0.25); tone('triangle', 420, 380, 0.5, 0.12, t + 0.02); hiss('bandpass', 1800, 900, 0.25, 0.5, 2); break;
      default: tone('sine', 600, 900, 0.15, 0.2);
    }
    setTimeout(() => { try { pan.disconnect(); } catch (_) { /* ignore */ } }, 2500);
  }

  // UI: countdown beeps, the start, the upgrader wheel
  beep(f = 660, dur = 0.12, peak = 0.25, type = 'square') {
    if (!this._ready()) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f; this._env(g, t, peak, 0.005, dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  tick() { this.beep(1800, 0.025, 0.08, 'square'); }
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, 0.18, 'triangle'), i * 110)); }
  lose() { [392, 330, 262].forEach((f, i) => setTimeout(() => this.beep(f, 0.22, 0.16, 'triangle'), i * 140)); }
  horn() { this.beep(330, 0.5, 0.25, 'sawtooth'); this.beep(415, 0.5, 0.18, 'sawtooth'); }
}
