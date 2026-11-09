// main.js — rendering, camera, input, HUD and menus. Rules live in game.js, physics in physics.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ArenaWorld, Vehicle, CRUSH_LOOK, SIDE_CRUSH_MAX } from './physics.js';
import { unpackVehicle } from './netcodec.js';
import { createGfx, LAYER_FULL, LAYER_PROXY } from './gfx.js';
import { MeshoptSimplifier } from './meshopt_simplifier.js';
import { GameAudio } from './audio.js';
import { buildArena, ARENA_R, SUN_DIR as ARENA_SUN, LIGHT as ARENA_LIGHT } from './arena.js';
import { Game, RULES, CARS, CAR_LIST, TALENTS, specFor } from './game.js';
import { CAR_GEO } from './cargeo.js';
import { Particles, CarDamageVisuals, puffTexture, sparkTexture, bakeQuantized } from './effects.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rnd = (a, b) => a + Math.random() * (b - a);
const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const progress = { arena: 0, car: 0, car2: 0 };
function setProgress(key, v) {
  progress[key] = v;
  if (!$('barFill')) return; // loading screen is gone: cars fetched for the match show up in the round status
  const total = progress.arena * 0.35 + progress.car * 0.22 + progress.car2 * 0.43;
  $('barFill').style.width = (total * 100).toFixed(0) + '%';
  $('loadText').textContent = `Загрузка… ${(total * 100).toFixed(0)}%`;
}


async function fetchBytes(url, key, onFrac) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось загрузить ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const report = (f) => { if (onFrac) onFrac(f); else if (key) setProgress(key, f); };
  if (!res.body || !total) { const b = await res.arrayBuffer(); report(0.95); return b; }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    report(Math.min(got / total, 1) * 0.95);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// big models: gzip'd GLB split into several base64 JSON parts (the host takes up to 20 MB per file)
async function loadGzParts(manifestUrl, key) {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Не удалось загрузить ${manifestUrl} (HTTP ${res.status})`);
  const man = await res.json();
  const done = new Array(man.parts.length).fill(0);
  const texts = await Promise.all(man.parts.map(async (name, i) => {
    const raw = await fetchBytes('./assets/' + name, null, (f) => { done[i] = f; setProgress(key, done.reduce((a, b) => a + b, 0) / done.length * 0.9); });
    return JSON.parse(new TextDecoder().decode(raw)).b64;
  }));
  // the parts are pieces of one base64 text: join first, then decode (a piece may end mid-group)
  const gz = base64ToBytes(texts.join(''));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = await new Response(stream).arrayBuffer();
  setProgress(key, 1);
  return out;
}
const gltfLoader = new GLTFLoader();
// Models are stored as {"glb": "<base64>"} JSON (the host serves .json but not .glb)
async function loadGLBBytes(url, key) {
  const raw = await fetchBytes(url, key);
  const wrapped = JSON.parse(new TextDecoder().decode(raw));
  return base64ToBytes(wrapped.glb).buffer;
}
function parseGLB(bytes, name) {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(bytes.slice(0), './assets/', resolve,
      (err) => reject(new Error(`Не удалось разобрать ${name}: ${err && err.message ? err.message : err}`)));
  });
}

// ---------------------------------------------------------------------------
// Renderer, scene, lights
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const canvas = renderer.domElement;
canvas.tabIndex = 0;
document.body.prepend(canvas);

const scene = new THREE.Scene();
const SUN_DIR = new THREE.Vector3(...ARENA_SUN);
// the sky (a painted golden-hour panorama) is set as background + environment once the arena is built
scene.fog = new THREE.Fog(ARENA_LIGHT.fog, 450, 1500);
const pmrem = new THREE.PMREMGenerator(renderer);
renderer.toneMappingExposure = ARENA_LIGHT.exposure;
scene.environmentIntensity = ARENA_LIGHT.envIntensity;

scene.add(new THREE.HemisphereLight(ARENA_LIGHT.hemiSky, ARENA_LIGHT.hemiGround, ARENA_LIGHT.hemiIntensity));
const sun = new THREE.DirectionalLight(ARENA_LIGHT.sun, ARENA_LIGHT.sunIntensity);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 900 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.09;
sun.position.copy(SUN_DIR).multiplyScalar(420);
sun.target.position.set(0, 0, 0);
scene.add(sun, sun.target);

// near plane 0.25 m (not 0.1): 2.5× finer depth far away — the stands and arches don't flicker
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 1500);
// reflections, light probe, bloom, AO — see gfx.js; quality comes from the menu
const gfx = createGfx(THREE, renderer, scene, camera, pmrem, { log: (m) => console.warn(m) });
if (camera.layers) camera.layers.enable(LAYER_FULL);
gfx.setSize(window.innerWidth, window.innerHeight);

const blobCanvas = document.createElement('canvas');
blobCanvas.width = blobCanvas.height = 128;
{
  const g = blobCanvas.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
}
const blobTexture = new THREE.CanvasTexture(blobCanvas);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  gfx.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// HUD helpers
// ---------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, ms = 1600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const hud = { speed: $('speed'), gear: $('gear'), rpmFill: $('rpmFill'), rpm: $('rpm'), fps: $('fps') };
const lastHud = {};
function setText(key, el, text) { if (el && lastHud[key] !== text) { lastHud[key] = text; el.textContent = text; } }
function setHTML(key, el, html) { if (el && lastHud[key] !== html) { lastHud[key] = html; el.innerHTML = html; } }
function feed(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  $('feed').prepend(el);
  setTimeout(() => el.remove(), 6200);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pName = (p) => `<b style="color:${p.color}">${esc(p.name)}</b>`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyR', 'KeyC', 'KeyH', 'Tab', 'Digit1', 'KeyE', 'KeyM']);
// sound (synthesised, see audio.js); browsers let it start only after a click or a key
const sfx = new GameAudio();
const SOUND_VOL = { loud: 0.9, quiet: 0.4, off: 0 };
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sfx.unlock(), { capture: true });
let game = null;
let started = false;
const pendingMods = [];
let spectateIdx = -1;

function overlayOpen() { return document.querySelector('.overlay.show') !== null; }
function onCommand(code) {
  if (!game || !game.human) return;
  const me = game.human;
  if (code === 'KeyH') { $('help').classList.toggle('hidden'); return; }
  if (code === 'KeyM') { toast(sfx.toggleMute() ? 'Звук выключен (M)' : 'Звук включён', 1200); return; }
  if (game.state !== 'chase' && game.state !== 'countdown') return;
  if (code === 'KeyR') {
    if (net.on) { net.send({ t: 'act', a: 'recover' }); return; }
    const v = me.vehicle;
    const upY = 1 - 2 * (v.q[0] * v.q[0] + v.q[2] * v.q[2]);
    if (me.alive && (upY < 0.5 || Math.abs(v.speed) < 3)) { v.recover(); toast('Машина снова на колёсах'); }
    return;
  }
  if (code === 'Tab') { spectateIdx++; return; }
  if (code === 'Digit1' || code === 'KeyE') pendingMods.push('talent');
}
window.addEventListener('keydown', (e) => {
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON');
  if (GAME_KEYS.has(e.code) && !(typing && overlayOpen())) e.preventDefault();
  hideClickHint();
  if (!e.repeat) onCommand(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function readInput() {
  const k = (c) => keys.has(c);
  return {
    throttle: k('KeyW') || k('ArrowUp') ? 1 : 0,
    brake: k('KeyS') || k('ArrowDown') ? 1 : 0,
    steer: (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0), // + = left
    handbrake: k('Space'),
  };
}

const cam = { yaw: 0, pitch: 0.2, dist: 7.0, smoothDist: 7.0, lastMouse: -10, dragging: false, head: 0, shake: 0, followId: -1 };
// while driving, a click hides the mouse and locks it: the camera then turns without holding any button (Esc gives the mouse back)
const canLock = () => !document.querySelector('.overlay.show') && game && (game.state === 'chase' || game.state === 'countdown');
const mouseLocked = () => document.pointerLockElement === canvas;
canvas.addEventListener('pointerdown', (e) => {
  if (!mouseLocked() && canLock() && canvas.requestPointerLock) {
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ }
  }
  cam.dragging = true;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  canvas.focus();
  hideClickHint();
});
canvas.addEventListener('pointermove', (e) => {
  if (!cam.dragging && !mouseLocked()) return;
  cam.yaw = wrap(cam.yaw - e.movementX * 0.006);   // kept within ±180°, so the camera swings back the short way
  cam.pitch = clamp(cam.pitch + e.movementY * 0.004, -0.08, 1.3);
  cam.lastMouse = performance.now() / 1000;
});
const endDrag = () => { cam.dragging = false; cam.lastMouse = performance.now() / 1000; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = clamp(cam.dist * Math.pow(1.1, Math.sign(e.deltaY)), 3.8, 18);
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
function hideClickHint() { if (started) $('clickHint').style.display = 'none'; }

// ---------------------------------------------------------------------------
// Particles and effects
// ---------------------------------------------------------------------------
let fxErrorShown = false;
function lin(hex) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return { r: f((hex >> 16) & 255), g: f((hex >> 8) & 255), b: f(hex & 255) };
}
const mixC = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const DUST = lin(0xb2a894), DUST2 = lin(0x9c917e), CONCRETE = lin(0xa3a29c);
const SMOKE_LIGHT = lin(0xc8c8c8), SMOKE_DARK = lin(0x1a1a1a), SMOKE_SCREEN = lin(0xd9dadb);
const SPARK_A = { r: 1.0, g: 0.78, b: 0.4 }, SPARK_B = { r: 1.0, g: 0.45, b: 0.12 }, FLAME = { r: 1.0, g: 0.42, b: 0.08 };
const NITRO = { r: 0.45, g: 0.6, b: 1.0 }, SWAP = { r: 0.75, g: 0.45, b: 1.0 };

const puffTex = puffTexture();
const fx = {
  dust: new Particles(2600, puffTex),
  smoke: new Particles(2200, puffTex),
  sparks: new Particles(1400, sparkTexture(), true),
  fire: new Particles(1600, puffTex, true),
};
scene.add(fx.dust.points, fx.smoke.points, fx.sparks.points, fx.fire.points);
// braziers round the arena: flames and a little smoke near the camera
const FIRE_A = { r: 1.0, g: 0.62, b: 0.18 }, FIRE_B = { r: 1.0, g: 0.32, b: 0.05 };
let flames = [], fireAcc = 0;
function tickFlames(dt) {
  fireAcc += dt * 60;
  const n = Math.floor(fireAcc); fireAcc -= n;
  if (!n) return;
  const cx = camera.position.x, cz = camera.position.z;
  for (const [x, y, z] of flames) {
    if (Math.hypot(x - cx, z - cz) > 170) continue;
    for (let k = 0; k < n; k++) {
      fx.fire.emit(x + rnd(-0.35, 0.35), y + rnd(0, 0.2), z + rnd(-0.35, 0.35), rnd(-0.3, 0.3), rnd(1.2, 2.6), rnd(-0.3, 0.3),
        rnd(0.35, 0.75), rnd(0.6, 1.0), rnd(0.15, 0.35), 0.75, mixC(FIRE_A, FIRE_B, Math.random()), 1.5, 2.5);
      if (Math.random() < 0.08) fx.smoke.emit(x, y + 1.2, z, rnd(-0.2, 0.2), rnd(0.8, 1.4), rnd(-0.2, 0.2), rnd(2, 3.5), 0.6, 2.4, 0.12, SMOKE_DARK, 0.6, 0.4);
    }
  }
}
const smokeEmitters = [];   // smoke screens being released

// per-car effect positions (model coordinates: ground at y = 0, front = +z, left = +x), from the measured body
function carLook(id) {
  const g = CAR_GEO[id], st = CARS[id];
  const L = g.hi[2], H = g.hi[1], W = g.hi[0];
  const bay = st.engine === 'rear' ? [0, 0.62 * H, -0.68 * L] : st.engine === 'mid' ? [0, 0.62 * H, -0.4 * L] : [0, Math.max(0.55, 0.68 * H), 0.62 * L];
  return {
    engineBay: bay,
    exhausts: [[0.33 * W, 0.28, -L + 0.06], [-0.33 * W, 0.28, -L + 0.06]],
    screens: [[0, 0.85 * H, 0.18 * L], [0, 0.8 * H, -0.45 * L]],
    blob: [2 * W * 1.3, 2 * L * 1.2],
    size: { L: 2 * L, W: 2 * W, H },
  };
}
const fromModelSpec = (spec, p) => [p[0] - spec.com[0], p[1] - spec.com[1], p[2] - spec.com[2]];

function localToWorld(v, p) {
  const q = v.q, x = p[0], y = p[1], z = p[2];
  const tx = 2 * (q[1] * z - q[2] * y), ty = 2 * (q[2] * x - q[0] * z), tz = 2 * (q[0] * y - q[1] * x);
  return [
    v.pos[0] + x + q[3] * tx + q[1] * tz - q[2] * ty,
    v.pos[1] + y + q[3] * ty + q[2] * tx - q[0] * tz,
    v.pos[2] + z + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}
function localDirToWorld(v, d) {
  const w = localToWorld(v, d);
  return [w[0] - v.pos[0], w[1] - v.pos[1], w[2] - v.pos[2]];
}

function sparkBurst(p, n, count, baseVel, along, alongSpeed, color) {
  for (let i = 0; i < count; i++) {
    let vx = baseVel[0] * 0.35 + n[0] * rnd(0.5, 3) + rnd(-3, 3), vy = rnd(1, 4), vz = baseVel[2] * 0.35 + n[2] * rnd(0.5, 3) + rnd(-3, 3);
    if (along) { const k = alongSpeed * rnd(0.2, 0.6); vx += along[0] * k; vy += along[1] * k; vz += along[2] * k; }
    fx.sparks.emit(p[0] + rnd(-0.1, 0.1), p[1] + rnd(-0.05, 0.1), p[2] + rnd(-0.1, 0.1), vx, vy, vz,
      rnd(0.25, 0.75), rnd(0.06, 0.1), 0.015, 1, color || mixC(SPARK_A, SPARK_B, Math.random()), 0.6, -9.8);
  }
}

// dents, scratches, cracks and sparks for one car
// dents / scratches / cracks are queued and done within a small time budget per frame (the detailed Datsun
// has a million vertices, a burst of hits shouldn't freeze the game)
const dmgQueue = [];
function runDamageQueue() {
  const t0 = performance.now();
  // a job that returns false has more to do (big crushes): it stays first in line for the next frame
  while (dmgQueue.length && (performance.now() - t0 < 6 || dmgQueue.length > 40)) {
    const job = dmgQueue[0];
    let done = true;
    try { done = job() !== false; } catch (e) { if (!fxErrorShown) { fxErrorShown = true; console.warn('damage fx:', e); } }
    if (done) dmgQueue.shift(); else break;
  }
}
function carHitFx(cv, ev) {
  const v = cv.player.vehicle;
  const p = localToWorld(v, ev.p), n = localDirToWorld(v, ev.n);
  const underside = ev.kind === 'ground' && ev.p[1] + v.spec.com[1] < 0.35;
  const dv = cv.damageVis;
  if (ev.type === 'impact') {
    // C: how deep the body was crushed here (m); look: how deep it shows (deeper than C on armoured bodies)
    const sev = ev.severity, C = ev.look !== undefined ? ev.look : ev.crush || 0;
    const vs = C / 0.45;
    if (dv && !underside && C > 0.015 && ev.kind === 'roof') {
      // the roof pressed in: a round dent, torn paint around it, the glass next to it cracks
      const D = Math.min(C * CRUSH_LOOK, 0.35), R = 0.5 + 0.45 * Math.min(C, 1);
      dmgQueue.push(dv.crushJob(ev.p, ev.n, D, Infinity, Infinity, 0.42, R));
      for (let k = 0, cnt = Math.min(6, 1 + Math.round(C * 8)); k < cnt; k++) {
        const q = [ev.p[0] + rnd(-R, R) + ev.n[0] * D, ev.p[1] + ev.n[1] * D * 0.9, ev.p[2] + rnd(-R, R) * 1.4 + ev.n[2] * D];
        dmgQueue.push(() => dv.chip(q, 0.3 + 0.4 * Math.random()));
        if (Math.random() < 0.5) dmgQueue.push(() => dv.scratch(q, null, 0.5 + 0.4 * Math.random()));
      }
      if (C > 0.1) dmgQueue.push(() => dv.crack(ev.p, Math.min(vs, 1), 0.6 + Math.min(vs, 1.4)));
    } else if (dv && !underside && C > 0.015) {
      // a wall flattens the whole face it hits; another car crushes about its own width; anything else: a round dent
      // how deep the metal really folds: the nose and tail crumple, a door/sill only gives so much
      const side = Math.abs(ev.n[0]) > Math.abs(ev.n[2]);
      const D = Math.min(C * CRUSH_LOOK, side ? SIDE_CRUSH_MAX : 0.8), maxDisp = side ? SIDE_CRUSH_MAX + 0.08 : 0.95;
      const halfW = ev.kind === 'car' ? 0.85 + 0.3 * Math.min(C, 1) : Infinity;
      if (ev.kind === 'wall') dmgQueue.push(dv.crushJob(ev.p, ev.n, D, Infinity, Infinity, maxDisp));
      else if (ev.kind === 'car') dmgQueue.push(dv.crushJob(ev.p, ev.n, D, halfW, 0.7, maxDisp));
      else dmgQueue.push(() => dv.dent(ev.p, ev.n, D, 0.42 + 0.75 * Math.min(C, 1.3)));
      // torn paint, bare metal and scratches spread over the crumpled area
      if (C > 0.04) {
        const [x0, x1, z0, z1] = v.spec.outline, nl = Math.hypot(ev.n[0], ev.n[2]) || 1, nx = ev.n[0] / nl, nz = ev.n[2] / nl;
        const across = Math.abs(nz) > Math.abs(nx) ? (x1 - x0) / 2 : (z1 - z0) / 2;
        const W = Math.min(halfW, across * 0.9), count = Math.min(9, 1 + Math.round(C * 9));
        for (let k = 0; k < count; k++) {
          const u = (Math.random() * 2 - 1) * W, h = rnd(-0.3, 0.55);
          const q = [ev.p[0] + nz * u + nx * D * 0.9, ev.p[1] + h, ev.p[2] - nx * u + nz * D * 0.9];
          const size = 0.35 + 0.45 * Math.min(C, 1) * Math.random() + 0.15;
          dmgQueue.push(() => dv.chip(q, size));
          if (Math.random() < 0.5) dmgQueue.push(() => dv.scratch(q, [nz, 0, -nx], 0.5 + 0.4 * Math.random()));
        }
      }
      if (C > 0.06) dmgQueue.push(() => dv.scratch(ev.p, null, 0.45 + 0.35 * Math.min(vs, 1.2)));
      if (C > 0.25) dmgQueue.push(() => dv.crack(ev.p, Math.min(vs, 1), 0.6 + Math.min(vs, 1.4)));
      if (C > 0.5 && Math.abs(ev.p[2]) > 1.5) {
        const sc = cv.screens[ev.p[2] > 0 ? 0 : 1];
        const at = fromModelSpec(v.spec, [rnd(-0.45, 0.45), sc[1], sc[2]]);
        dmgQueue.push(() => dv.crack(at, 1, 0.6));
      }
    }
    sparkBurst(p, n, Math.round(8 + 45 * Math.min(sev, 1)), v.vel);
    sfx.impact(p, sev, ev.kind);
    if (ev.kind === 'wall') {
      for (let i = 0; i < 6 + 14 * Math.min(sev, 1); i++) {
        fx.dust.emit(p[0] + rnd(-0.3, 0.3), p[1] + rnd(-0.2, 0.4), p[2] + rnd(-0.3, 0.3),
          n[0] * rnd(0.5, 2) + rnd(-1, 1), rnd(0.2, 1.2), n[2] * rnd(0.5, 2) + rnd(-1, 1),
          rnd(1.2, 2.4), rnd(0.3, 0.5), rnd(1.6, 2.8), 0.35, CONCRETE, 1.8, 0.1);
      }
    }
    if (cv.player === followed() && vs > 0.4) cam.shake = Math.min(1, cam.shake + vs * 0.4);
  } else if (ev.type === 'scrape') {
    const t = localDirToWorld(v, ev.t);
    sparkBurst(p, n, 5, v.vel, t, ev.speed);
    sfx.scrape(cv.player.decoy ? cv : cv.player.id, ev.speed);
    if (dv && !underside && dmgQueue.length < 30) dmgQueue.push(() => dv.scratch(ev.p, ev.t, 0.7));
  }
}

// little dust while rolling, a lot when braking, skidding or spinning the wheels
function emitWheelDust(cv, v, dt) {
  const vel = v.vel, vh = Math.hypot(vel[0], vel[2]);
  const brake = v.ctl.brake, hand = v.ctl.handbrake;
  for (let i = 0; i < 4; i++) {
    const wh = v.wheels[i];
    if (!wh.contact) { cv.dustAcc[i] = 0; continue; }
    const roll = Math.abs(wh.vLong);
    const slipV = Math.hypot(wh.omega * wh.radius - wh.vLong, wh.vLat);
    const braking = brake * Math.min(roll / 4, 1);
    const handbrake = !wh.front && hand ? Math.min(roll / 4, 1) : 0;
    const sliding = clamp((slipV - 1.2) / 5, 0, 1);
    const heavy = clamp(braking + handbrake + sliding, 0, 1);
    const rate = 3 * Math.min(vh / 15, 1) + 45 * braking + 35 * handbrake + 35 * sliding;
    cv.dustAcc[i] += rate * dt;
    while (cv.dustAcc[i] >= 1) {
      cv.dustAcc[i] -= 1;
      const k = rnd(0.1, 0.4);
      fx.dust.emit(wh.cp[0] + rnd(-0.15, 0.15), wh.cp[1] + rnd(0.02, 0.12), wh.cp[2] + rnd(-0.15, 0.15),
        vel[0] * k + rnd(-0.8, 0.8), rnd(0.2, 0.9), vel[2] * k + rnd(-0.8, 0.8),
        rnd(1.4, 2.4) + heavy * 1.2, rnd(0.25, 0.4), rnd(1.4, 2.2) + heavy * 1.6,
        0.09 + 0.22 * heavy, Math.random() < 0.5 ? DUST : DUST2, 1.6, 0.12);
    }
  }
}

// engine smoke (grey -> black), backfires, nitro flames, a burning wreck
function emitCarSmoke(cv, v, dt) {
  const d = v.destroyed ? 1 : v.damage.engine, vel = v.vel;
  if (d > 0.08) {
    const k = (d - 0.08) / 0.92;
    cv.smokeAcc += (2 + 36 * k) * dt;
    while (cv.smokeAcc >= 1) {
      cv.smokeAcc -= 1;
      const eb = cv.engineBay;
      const p = localToWorld(v, [eb[0] + rnd(-0.4, 0.4), eb[1], eb[2] + rnd(-0.3, 0.3)]);
      fx.smoke.emit(p[0], p[1], p[2], vel[0] * 0.25 + rnd(-0.3, 0.3), rnd(0.6, 1.4), vel[2] * 0.25 + rnd(-0.3, 0.3),
        rnd(2, 3.8), rnd(0.3, 0.5), rnd(1.6, 2.6) + 2 * k, 0.12 + 0.5 * k, mixC(SMOKE_LIGHT, SMOKE_DARK, Math.min(1, k * 1.3)), 0.8, 0.5);
    }
  } else cv.smokeAcc = 0;
  if (d > 0.95) {
    cv.flameAcc += (v.destroyed ? 70 : 40) * dt;
    while (cv.flameAcc >= 1) {
      cv.flameAcc -= 1;
      const p = localToWorld(v, [rnd(-0.45, 0.45), cv.engineBay[1] - 0.05, cv.engineBay[2] + rnd(-0.6, 0.3)]);
      fx.sparks.emit(p[0], p[1], p[2], vel[0] * 0.6 + rnd(-0.2, 0.2), rnd(0.8, 1.8), vel[2] * 0.6 + rnd(-0.2, 0.2),
        rnd(0.25, 0.55), rnd(0.3, 0.5), 0.05, 0.8, FLAME, 0.5, 2.5);
    }
  }
  if (v.misfire && !cv.lastMisfire) {
    for (const e of cv.exhausts) {
      const p = localToWorld(v, e), back = localDirToWorld(v, [0, 0, -1]);
      for (let i = 0; i < 3; i++) {
        fx.smoke.emit(p[0], p[1], p[2], vel[0] + back[0] * rnd(1, 3) + rnd(-0.3, 0.3), rnd(0.1, 0.5), vel[2] + back[2] * rnd(1, 3) + rnd(-0.3, 0.3),
          rnd(0.8, 1.4), 0.2, rnd(0.8, 1.3), 0.45, SMOKE_DARK, 2.5, 0.4);
      }
      fx.sparks.emit(p[0], p[1], p[2], vel[0] + back[0] * 2, 0, vel[2] + back[2] * 2, 0.08, 0.35, 0.15, 0.9, FLAME, 1, 0);
    }
  }
  cv.lastMisfire = v.misfire;
  if (v.boost > 0) {
    for (const e of cv.exhausts) {
      const p = localToWorld(v, e), back = localDirToWorld(v, [0, 0, -1]);
      for (let i = 0; i < 2; i++) {
        fx.sparks.emit(p[0], p[1], p[2], vel[0] + back[0] * rnd(6, 10), rnd(-0.2, 0.3), vel[2] + back[2] * rnd(6, 10),
          rnd(0.08, 0.16), rnd(0.25, 0.4), 0.05, 0.9, Math.random() < 0.5 ? NITRO : FLAME, 2, 0);
      }
    }
  }
}

function explosion(x, y, z) {
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2, s = rnd(3, 14);
    fx.sparks.emit(x, y + 0.4, z, Math.cos(a) * s, rnd(2, 10), Math.sin(a) * s, rnd(0.4, 1.1), rnd(0.08, 0.14), 0.02, 1, mixC(SPARK_A, SPARK_B, Math.random()), 0.8, -9.8);
  }
  for (let i = 0; i < 45; i++) {
    fx.sparks.emit(x + rnd(-1, 1), y + rnd(0, 1), z + rnd(-1, 1), rnd(-3, 3), rnd(1, 5), rnd(-3, 3), rnd(0.4, 0.9), rnd(1.2, 2.2), 0.3, 0.9, FLAME, 1.5, 1);
  }
  for (let i = 0; i < 40; i++) {
    fx.smoke.emit(x + rnd(-1.5, 1.5), y + rnd(0, 1.5), z + rnd(-1.5, 1.5), rnd(-2, 2), rnd(1, 4), rnd(-2, 2), rnd(3, 6), rnd(1, 2), rnd(5, 8), 0.6, SMOKE_DARK, 1, 0.6);
  }
}

// ---------------------------------------------------------------------------
// Ground zones (oil, glue, spikes), harpoon ropes
// ---------------------------------------------------------------------------
function blotchTexture(rgb, shine) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 60;
    const x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d, r = 30 + Math.random() * 55;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},0.95)`); gr.addColorStop(0.7, `rgba(${rgb},0.85)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  if (shine) {
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(255,255,255,${0.08 + Math.random() * 0.12})`;
      g.beginPath(); g.ellipse(70 + Math.random() * 116, 70 + Math.random() * 116, 4 + Math.random() * 14, 2 + Math.random() * 6, Math.random() * 3, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const oilTex = blotchTexture('8,8,10', true), glueTex = blotchTexture('196,214,58', true);
const zoneVisuals = new Map();
let world = null;

function makeZoneVisual(zn) {
  const gy = world.height(zn.x, zn.z) + 0.03;
  let obj;
  if (zn.type === 'spikes') {
    obj = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(zn.len * 2, 0.04, zn.wid * 2), new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.6, metalness: 0.4 }));
    obj.add(base);
    const coneGeo = new THREE.ConeGeometry(0.07, 0.22, 6), coneMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.25, metalness: 0.9 });
    for (let i = 0; i < 36; i++) {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(-zn.len + (i % 18 + 0.5) * (zn.len * 2 / 18), 0.12, i < 18 ? -zn.wid * 0.45 : zn.wid * 0.45);
      cone.castShadow = true;
      obj.add(cone);
    }
    obj.rotation.y = Math.atan2(zn.dx, zn.dz) - Math.PI / 2;
  } else {
    const mat = new THREE.MeshStandardMaterial({ map: zn.type === 'oil' ? oilTex : glueTex, transparent: true, depthWrite: false, roughness: zn.type === 'oil' ? 0.08 : 0.35, metalness: zn.type === 'oil' ? 0.2 : 0 });
    obj = new THREE.Mesh(new THREE.CircleGeometry(zn.r * 1.15, 40), mat);
    obj.rotation.x = -Math.PI / 2;
    obj.rotation.z = Math.random() * Math.PI * 2;
    obj.renderOrder = 1;
  }
  obj.position.set(zn.x, gy, zn.z);
  obj.receiveShadow = true;
  scene.add(obj);
  return obj;
}
function syncZones() {
  const live = new Set(game.zones);
  for (const [zn, obj] of zoneVisuals) {
    if (!live.has(zn)) { scene.remove(obj); zoneVisuals.delete(zn); continue; }
    const fade = clamp(zn.t / 1.2, 0, 1);
    obj.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = fade; } });
  }
  for (const zn of game.zones) if (!zoneVisuals.has(zn)) zoneVisuals.set(zn, makeZoneVisual(zn));
}

const ropeMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.5, metalness: 0.7 });
const ropes = [];
const UP = new THREE.Vector3(0, 1, 0);
function syncRopes() {
  while (ropes.length < game.harpoons.length) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 6), ropeMat);
    scene.add(m); ropes.push(m);
  }
  ropes.forEach((m, i) => {
    const hp = game.harpoons[i];
    m.visible = !!hp;
    if (!hp) return;
    const a = carVis.get(hp.hunter.id), b = carVis.get(hp.runner.id);
    if (!a || !b) { m.visible = false; return; }
    const pa = new THREE.Vector3(0, 0.1, 2.2).applyQuaternion(a.root.quaternion).add(a.root.position);
    const pb = new THREE.Vector3(0, 0.1, -2.1).applyQuaternion(b.root.quaternion).add(b.root.position);
    const dir = pb.clone().sub(pa), len = dir.length();
    m.position.copy(pa).addScaledVector(dir, 0.5);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(UP, dir.normalize());
  });
}

// ---------------------------------------------------------------------------
// Car visuals (one per player, plus decoys)
// ---------------------------------------------------------------------------
const carBytes = {};
let carsBuilding = null;
const carVis = new Map();      // player id -> visual
const decoyVis = new Map();    // decoy record -> visual
const carLoads = {};
// model bytes of a car (downloaded once, on first use)
function ensureCarBytes(carId, progressKey) {
  if (carBytes[carId]) return Promise.resolve(carBytes[carId]);
  if (!carLoads[carId]) {
    carLoads[carId] = loadGzParts(CAR_GEO[carId].asset, progressKey || 'car:' + carId).then((b) => { carBytes[carId] = b; return b; });
  }
  return carLoads[carId];
}


// cars of the same model share their textures (several runners in one model cost the video memory of one)
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'specularColorMap', 'transmissionMap'];
const texCache = new Map();
function shareTextures(carId, model) {
  let cache = texCache.get(carId);
  if (!cache) texCache.set(carId, cache = new Map());
  let n = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      n++;
      for (const k of TEX_SLOTS) {
        const t = mat[k];
        if (!t) continue;
        const key = n + '|' + k;
        const have = cache.get(key);
        if (!have) { cache.set(key, t); continue; }
        if (have !== t) {
          if (t.image && t.image !== have.image && typeof t.image.close === 'function') t.image.close();
          mat[k] = have;
        }
      }
    }
  });
}
function disposeModel(root) {
  root.traverse((o) => {
    try {
      if (o.userData && o.userData.proxy) return;   // shares its buffers with the real mesh
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material) for (const mt of Array.isArray(o.material) ? o.material : [o.material]) if (mt && mt.dispose) mt.dispose();
    } catch (e) { console.warn('dispose:', e); }
  });
}

// ---------------------------------------------------------------------------
// Shadow / mirror stand-ins. The cars are detailed (up to ~0.5 M triangles); the sun's shadow and the floor's
// mirror don't need all of that, so every big part gets a lighter copy (meshoptimizer, ~1/5 of the triangles) that
// is drawn only in those two passes. It shares the part's vertex buffers — dents show in its shadow too — and the
// full part is drawn only by the main camera. Built once per car model, a part at a time, in the background.
// ---------------------------------------------------------------------------
const proxyIndex = new Map();   // carId -> Promise<[Uint32Array|null per mesh, in traversal order]>
const yieldTick = () => new Promise((r) => setTimeout(r, 0));
function carMeshes(model) {
  const out = [];
  model.traverse((o) => { const u = o.userData || {}; if (o.isMesh && !u.proxy && !u.decal && !Array.isArray(o.material) && o.geometry && o.geometry.index) out.push(o); });
  return out;
}
async function buildProxyIndex(meshes) {
  await MeshoptSimplifier.ready;
  const res = [];
  for (const m of meshes) {
    const g = m.geometry, idx = g.index.array, tris = idx.length / 3;
    if (tris < 1000) { res.push(null); continue; }
    try {
      const pa = g.attributes.position;
      let P = pa.array;
      if (pa.isInterleavedBufferAttribute || !(P instanceof Float32Array) || P.length !== pa.count * 3) {
        P = new Float32Array(pa.count * 3);
        for (let i = 0; i < pa.count; i++) { P[i * 3] = pa.getX(i); P[i * 3 + 1] = pa.getY(i); P[i * 3 + 2] = pa.getZ(i); }
      }
      const remap = MeshoptSimplifier.generatePositionRemap(P, 3);   // weld the seams so they can collapse
      const welded = new Uint32Array(idx.length);
      for (let i = 0; i < idx.length; i++) welded[i] = remap[idx[i]];
      const target = Math.min(idx.length, Math.max(36, Math.floor(tris * 0.15) * 3));
      let [out] = MeshoptSimplifier.simplify(welded, P, 3, target, 0.02, ['Prune']);
      // tyre treads and other busy detail won't collapse: cluster them instead (fine for a shadow)
      if (out.length > idx.length * 0.3) {
        const [s2] = MeshoptSimplifier.simplifySloppy(welded, P, 3, null, target, 0.02);
        if (s2.length >= 3 && s2.length < out.length) out = s2;
      }
      res.push(out.length >= 3 && out.length < idx.length * 0.85 ? out : null);
    } catch (e) { res.push(null); }
    await yieldTick();
  }
  return res;
}
async function attachProxies(carId, model) {
  try {
    if (!MeshoptSimplifier.supported) return;
    const meshes = carMeshes(model);
    if (!proxyIndex.has(carId)) proxyIndex.set(carId, buildProxyIndex(meshes));
    const list = await proxyIndex.get(carId);
    if (list.length !== meshes.length || !model.parent) return;
    meshes.forEach((m, i) => {
      if (!list[i]) return;
      const g = new THREE.BufferGeometry();
      for (const k in m.geometry.attributes) g.setAttribute(k, m.geometry.attributes[k]);
      g.setIndex(new THREE.BufferAttribute(list[i], 1));
      g.boundingSphere = m.geometry.boundingSphere;
      const px = new THREE.Mesh(g, m.material);
      (px.userData || (px.userData = {})).proxy = true;
      px.layers.set(LAYER_PROXY);
      px.castShadow = true; px.receiveShadow = true;
      m.add(px);
      m.layers.set(LAYER_FULL);
      m.castShadow = false;
    });
  } catch (e) { console.warn('shadow proxies off:', e); }
}

async function buildCarVisual(carId, color) {
  const spec = specFor(carId), look = carLook(carId);
  const gltf = await parseGLB(await ensureCarBytes(carId), carId);
  const root = new THREE.Group();
  const model = gltf.scene;
  shareTextures(carId, model);
  bakeQuantized(model);
  model.position.set(-spec.com[0], -spec.com[1], -spec.com[2]);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  root.add(model);
  const wheelObjs = spec.wheels.map((w) => {
    const o = model.getObjectByName(w.node);
    if (!o) throw new Error('В модели машины нет объекта ' + w.node);
    o.rotation.order = 'YZX';
    return { o, rest: o.position.clone(), side: Math.sign(o.position.x) || 1 };
  });
  // a middle axle (6×6) turns with the rear wheels
  const extraWheels = ['Wheel_ML', 'Wheel_MR'].map((n) => model.getObjectByName(n)).filter(Boolean)
    .map((o) => { o.rotation.order = 'YZX'; return { o, rest: o.position.clone() }; });
  let damageVis = null;
  try { damageVis = new CarDamageVisuals(model, root, { paletteGlass: false }); } catch (e) { console.warn('damage visuals off:', e); }
  attachProxies(carId, model);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(look.blob[0], look.blob[1]), new THREE.MeshBasicMaterial({ map: blobTexture, transparent: true, depthWrite: false }));
  blob.rotation.order = 'YXZ';
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 1;
  scene.add(root, blob);
  const cv = { carId, root, model, wheelObjs, extraWheels, damageVis, blob, spec, size: look.size,
    dustAcc: [0, 0, 0, 0], smokeAcc: 0, flameAcc: 0, lastMisfire: false, label: null,
    engineBay: fromModelSpec(spec, look.engineBay), exhausts: look.exhausts.map((e) => fromModelSpec(spec, e)), screens: look.screens };
  try {
    if (CARS[carId].pushBar) buildPushBar(cv);
    if (CARS[carId].sideSpikes) buildSideSpikes(cv);
  } catch (e) { console.warn('equipment:', e); }
  return cv;
}

// ---------------------------------------------------------------------------
// Equipment: the Charger's push bar, the GT3 R's side spikes (built from tubes and cones, bent by the game state)
// ---------------------------------------------------------------------------
const steelMat = new THREE.MeshStandardMaterial({ color: 0x1c1e21, metalness: 0.85, roughness: 0.38 });
const chromeMat = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 0.95, roughness: 0.22 });
const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tq = new THREE.Quaternion(), _ty = new THREE.Vector3(0, 1, 0);
function tube(parent, a, b, r, mat = steelMat) {
  _ta.set(...a); _tb.set(...b);
  const len = _ta.distanceTo(_tb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.copy(_ta).add(_tb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_ty, _tb.sub(_ta).normalize());
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}
function buildPushBar(cv) {
  const sp = cv.spec, y = (h) => h - sp.com[1], W = sp.outline[1] * 0.74, zf = sp.bodyFront;
  // the pivot sits on the bar's face: it bends back about it
  const g = new THREE.Group();
  g.position.set(0, y(0.55), zf + 0.1);
  const P = (x, h, dz = 0) => [x, y(h) - y(0.55), dz];
  const r = 0.035;
  for (const s of [-1, 1]) {
    tube(g, P(s * 0.36, 0.22), P(s * 0.36, 0.96), r);              // posts
    tube(g, P(s * 0.36, 0.96), P(s * W, 0.62, -0.07), r);          // the hoop down to the lamps
    tube(g, P(s * W, 0.62, -0.07), P(s * W, 0.34, -0.07), r);
    tube(g, P(s * 0.36, 0.34), P(s * 0.36, 0.34, -0.22), r * 0.8);  // mounts back into the frame
    tube(g, P(s * 0.36, 0.8), P(s * 0.36, 0.8, -0.2), r * 0.8);
  }
  tube(g, P(-0.36, 0.96), P(0.36, 0.96), r);
  tube(g, P(-W, 0.4, -0.05), P(W, 0.4, -0.05), r);
  tube(g, P(-0.36, 0.68), P(0.36, 0.68), r * 0.85);
  for (const x of [-0.12, 0.12]) tube(g, P(x, 0.4), P(x, 0.96), r * 0.6);
  cv.root.add(g);
  cv.pushBar = { g, z0: g.position.z, tw: Math.random() < 0.5 ? -1 : 1, shown: 1 };
}
function buildSideSpikes(cv) {
  const sp = cv.spec, x1 = sp.outline[1], yS = 0.38 - sp.com[1];
  const zs = sp.wheels.map((w) => w.pos[2] - sp.com[2]), z0 = Math.min(...zs) + 0.45, z1 = Math.max(...zs) - 0.45;
  const cone = new THREE.ConeGeometry(0.04, 0.22, 10);
  cone.rotateZ(-Math.PI / 2); cone.translate(0.11, 0, 0);          // along +x, base at the rail
  const sides = [];
  for (const side of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(side * (x1 - 0.03), yS, 0);
    if (side < 0) g.rotation.y = Math.PI;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, z1 - z0 + 0.2), steelMat);
    rail.position.set(0.0, 0, side * (z0 + z1) / 2);
    rail.castShadow = true; g.add(rail);
    const spikes = new THREE.Group();
    spikes.position.x = 0.02;
    for (let k = 0; k < 7; k++) {
      const m = new THREE.Mesh(cone, chromeMat);
      m.position.z = side * (z0 + (z1 - z0) * k / 6);
      m.castShadow = true;
      spikes.add(m);
    }
    g.add(spikes);
    cv.root.add(g);
    sides.push({ side, spikes });
  }
  cv.sideSpikes = sides;
}
// bend the equipment to the car's state
function poseEquipment(cv, v) {
  const pb = cv.pushBar;
  if (pb) {
    const b = 1 - clamp(v.pushBar ?? 1, 0, 1);
    pb.g.position.z = pb.z0 - 0.14 * b;
    pb.g.scale.set(1 - 0.1 * b, 1 - 0.12 * b, 1 - 0.5 * b);
    pb.g.rotation.set(-0.3 * b, 0.1 * b * pb.tw, 0.07 * b * pb.tw);
  }
  if (cv.sideSpikes && game) {
    for (const s of cv.sideSpikes) {
      const sharp = game.spikeSharpness(v, s.side);
      s.spikes.scale.x = 0.3 + 0.7 * sharp;
      s.spikes.rotation.z = -0.5 * (1 - sharp);
    }
  }
}

// ---------------------------------------------------------------------------
// Wheels that come off: a copy flies away, bounces and rolls; the car's own wheel is hidden till the next round
// ---------------------------------------------------------------------------
const flyingWheels = [];
const _fw = new THREE.Vector3(), _fq = new THREE.Quaternion();
function throwWheel(cv, i, blast) {
  const wo = i < 4 ? cv.wheelObjs[i] : { o: cv.extraWheels[i - 4].o, side: Math.sign(cv.extraWheels[i - 4].o.position.x) || 1 };
  if (!wo || !wo.o.visible) return;
  wo.o.updateWorldMatrix(true, false);
  const obj = wo.o.clone(true);
  wo.o.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
  scene.add(obj);
  wo.o.visible = false;
  const v = cv.player && cv.player.vehicle, r = cv.spec.wheels[Math.min(i, 3)].radius;
  const out = _fw.set(wo.side, 0, 0).applyQuaternion(cv.root.quaternion);
  const kick = blast ? rnd(4, 9) : rnd(1.5, 4), up = blast ? rnd(4, 9) : rnd(1.5, 3.5);
  const vel = new THREE.Vector3(out.x * kick + (v ? v.vel[0] : 0) + rnd(-1, 1), up, out.z * kick + (v ? v.vel[2] : 0) + rnd(-1, 1));
  const w = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(blast ? 14 : 8);
  flyingWheels.push({ obj, vel, w, r, rest: false });
  while (flyingWheels.length > 40) scene.remove(flyingWheels.shift().obj);
  sfx.fx('wheel', [obj.position.x, obj.position.y, obj.position.z]);
}
function tickFlyingWheels(dt) {
  for (const f of flyingWheels) {
    if (f.rest) continue;
    const o = f.obj, v = f.vel;
    v.y -= 9.81 * dt;
    o.position.addScaledVector(v, dt);
    const ang = f.w.length() * dt;
    if (ang > 1e-5) { _fq.setFromAxisAngle(_fw.copy(f.w).normalize(), ang); o.quaternion.premultiply(_fq); }
    const floor = world.height(o.position.x, o.position.z) + f.r * 0.45;
    if (o.position.y < floor) {
      o.position.y = floor;
      if (v.y < 0) v.y = -v.y * 0.32;
      v.x *= 0.86; v.z *= 0.86; f.w.multiplyScalar(0.75);
      if (Math.hypot(v.x, v.y, v.z) < 0.4 && f.w.length() < 0.6) f.rest = true;
    }
    const rr = Math.hypot(o.position.x, o.position.z), lim = ARENA_R - 0.6;
    if (rr > lim) {
      const nx = o.position.x / rr, nz = o.position.z / rr, vn = v.x * nx + v.z * nz;
      o.position.x = nx * lim; o.position.z = nz * lim;
      if (vn > 0) { v.x -= 1.4 * vn * nx; v.z -= 1.4 * vn * nz; }
    }
  }
}
function restoreWheels() {
  for (const f of flyingWheels) scene.remove(f.obj);
  flyingWheels.length = 0;
  for (const cv of [...carVis.values(), ...decoyVis.values()]) {
    for (const w of cv.wheelObjs) w.o.visible = true;
    for (const e of cv.extraWheels || []) e.o.visible = true;
  }
}

function disposeVisual(cv) {
  scene.remove(cv.root); scene.remove(cv.blob);
  if (cv.label) cv.label.remove();
  disposeModel(cv.root); disposeModel(cv.blob);
}

function makeLabel(p) {
  const lab = document.createElement('div');
  lab.className = 'tag3d';
  lab.innerHTML = `<span style="color:${p.color}">${esc(p.name)}${p.role === 'hunter' ? ' · ловец' : ''}</span><small class="carname"></small>`;
  $('labels').appendChild(lab);
  return lab;
}
async function buildCars() {
  for (const cv of carVis.values()) disposeVisual(cv);
  carVis.clear();
  pendingVis.clear();
  for (const cv of decoyVis.values()) disposeVisual(cv);
  decoyVis.clear();
  await Promise.all(game.players.map(async (p) => {
    const cv = await buildCarVisual(p.car, p.color);
    cv.player = p;
    cv.label = makeLabel(p); cv.label.querySelector('.carname').textContent = CARS[p.car].name;
    carVis.set(p.id, cv);
  }));
}
// a player changed car (won one / picked another from the garage): build the new look, swap when ready
const pendingVis = new Map();
function refreshCar(p) {
  const want = p.car;
  if (pendingVis.get(p.id) === want) return;
  pendingVis.set(p.id, want);
  buildCarVisual(want, p.color).then((cv) => {
    if (pendingVis.get(p.id) !== want || p.car !== want) { disposeVisual(cv); return; }
    pendingVis.delete(p.id);
    const old = carVis.get(p.id);
    cv.player = p;
    if (old) { cv.label = old.label; old.label = null; disposeVisual(old); }
    else cv.label = makeLabel(p);
    cv.label.querySelector('.carname').textContent = CARS[p.car].name;
    carVis.set(p.id, cv);
  }).catch((e) => { console.error(e); if (window.showError) window.showError(e.stack || e.message || e); });
}
// download progress of the cars still on their way, 0..1
function carsLoadPct() {
  const ids = [...new Set(game.players.map((p) => p.car))].filter((id) => !carBytes[id]);
  if (!ids.length) return 1;
  return ids.reduce((a, id) => a + (progress['car:' + id] || 0), 0) / ids.length;
}
// every player's current car is on screen (the round can't start before that)
function carsReady() {
  return game.players.every((p) => { const cv = carVis.get(p.id); return cv && cv.carId === p.car; });
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _v3 = new THREE.Vector3();
function poseVisual(cv, v, alpha) {
  cv.root.position.set(
    v.prevPos[0] + (v.pos[0] - v.prevPos[0]) * alpha,
    v.prevPos[1] + (v.pos[1] - v.prevPos[1]) * alpha,
    v.prevPos[2] + (v.pos[2] - v.prevPos[2]) * alpha,
  );
  _qa.fromArray(v.prevQ); _qb.fromArray(v.q);
  cv.root.quaternion.slerpQuaternions(_qa, _qb, alpha);
  const staticLen = v.spec.suspension.staticLength;
  for (let i = 0; i < 4; i++) {
    const w = v.wheels[i], o = cv.wheelObjs[i];
    o.o.position.y = o.rest.y + (staticLen - w.length);
    o.o.rotation.y = w.steer;
    o.o.rotation.x = w.spin;
    o.o.rotation.z = o.side * 0.16 * clamp((v.damage.wheels[i] - 0.15) / 0.85, 0, 1);
  }
  for (const e of cv.extraWheels || []) {
    e.o.position.y = e.rest.y + (staticLen - v.wheels[2].length);
    e.o.rotation.x = v.wheels[2].spin;
  }
  const gh = world.height(cv.root.position.x, cv.root.position.z);
  const lift = cv.root.position.y - v.spec.com[1] - gh;
  const f = _v3.set(0, 0, 1).applyQuaternion(cv.root.quaternion);
  cv.blob.position.set(cv.root.position.x, gh + 0.03, cv.root.position.z);
  cv.blob.rotation.y = Math.atan2(f.x, f.z);
  cv.blob.material.opacity = clamp(1 - lift / 1.5, 0, 1);
}

// ---------------------------------------------------------------------------
// Camera target / spectating
// ---------------------------------------------------------------------------
function followed() {
  if (!game || !game.human) return null;
  const me = game.human;
  if (me.alive || game.state !== 'chase') { spectateIdx = -1; return me; }
  const alive = game.players.filter((p) => p.alive);
  if (!alive.length) return me;
  if (spectateIdx < 0) spectateIdx = Math.max(0, alive.indexOf(game.hunter));
  return alive[spectateIdx % alive.length];
}

// ---------------------------------------------------------------------------
// Menus and overlays
// ---------------------------------------------------------------------------
function showOverlay(id) {
  for (const el of document.querySelectorAll('.overlay')) el.classList.toggle('show', el.id === id);
}
const menuState = { mode: 'tag', bots: 2, chaseTime: 180, role: 'random', myMoney: 0, gfx: 'high', sound: 'loud' };
try { Object.assign(menuState, JSON.parse(localStorage.getItem('salki.settings') || '{}')); } catch (_) { /* ignore */ }
function initMenu() {
  const seg = (id, key, conv) => {
    const el = $(id);
    for (const b of el.querySelectorAll('button')) {
      b.classList.toggle('on', String(menuState[key]) === b.dataset.v);
      b.addEventListener('click', () => {
        menuState[key] = conv(b.dataset.v);
        for (const x of el.querySelectorAll('button')) x.classList.toggle('on', x === b);
      });
    }
  };
  seg('optMode', 'mode', String);
  const modeUi = () => {
    const br = menuState.mode === 'br';
    $('fieldRole').style.display = br ? 'none' : '';
    $('rulesTag').style.display = br ? 'none' : '';
    $('rulesBr').style.display = br ? '' : 'none';
  };
  for (const b of $('optMode').querySelectorAll('button')) b.addEventListener('click', modeUi);
  modeUi();
  seg('optBots', 'bots', Number);
  seg('optRole', 'role', String);
  seg('optMoney', 'myMoney', Number);
  seg('optGfx', 'gfx', String);
  seg('optSound', 'sound', String);
  sfx.setVolume(SOUND_VOL[menuState.sound] ?? 0.9);
  for (const b of $('optSound').querySelectorAll('button')) b.addEventListener('click', () => {
    sfx.setVolume(SOUND_VOL[menuState.sound] ?? 0.9);
    try { localStorage.setItem('salki.settings', JSON.stringify(menuState)); } catch (_) { /* ignore */ }
  });
  for (const b of $('optGfx').querySelectorAll('button')) b.addEventListener('click', () => {
    gfx.setQuality(menuState.gfx);
    try { localStorage.setItem('salki.settings', JSON.stringify(menuState)); } catch (_) { /* ignore */ }
  });
  for (const b of $('optMoney').querySelectorAll('button')) b.addEventListener('click', () => { if (net.on) net.send({ t: 'money', v: menuState.myMoney }); if (menuState.myMoney > 0) $('menuMoney').textContent = menuState.myMoney; else if (game && game.human) $('menuMoney').textContent = game.human.money; });
  const r = $('optChase');
  r.value = menuState.chaseTime;
  const upd = () => { menuState.chaseTime = Number(r.value); $('optChaseTxt').textContent = fmtTime(menuState.chaseTime); };
  r.addEventListener('input', upd); upd();
  $('startBtn').addEventListener('click', () => startMatch());
  try { $('netName').value = localStorage.getItem('salki.name') || ''; } catch (_) { /* ignore */ }
  $('netBtn').addEventListener('click', () => { if (net.ws) net.ws.close(); else netConnect(); });
  $('reNext').addEventListener('click', () => { if (net.on) showOverlay(null); else game.next(); });
  $('meAgain').addEventListener('click', () => startMatch());
  $('meMenu').addEventListener('click', () => openMenu());
}
function openMenu() {
  if (menuState.myMoney > 0) $('menuMoney').textContent = menuState.myMoney;
  else if (game && game.human) $('menuMoney').textContent = game.human.money;
  showOverlay('menu');
  game.state = 'menu';
  hideHud();
}
function hideHud() {
  $('topbar').style.display = 'none';
  $('playersPanel').style.display = 'none';
  $('abilities').innerHTML = '';
  $('status').innerHTML = '';
}

async function startMatch() {
  try { localStorage.setItem('salki.settings', JSON.stringify(menuState)); } catch (_) { /* ignore */ }
  if (net.on) {                                   // online: the server starts the match (or we join the one running)
    net.send({ t: 'start', mode: menuState.mode, chaseTime: menuState.chaseTime, money: menuState.myMoney });
    $('netStatus').textContent = 'Запускаем матч на сервере…';
    return;
  }
  showOverlay(null);
  for (const [zn, obj] of zoneVisuals) { scene.remove(obj); zoneVisuals.delete(zn); }
  game.newMatch({ mode: menuState.mode, bots: menuState.bots, chaseTime: menuState.chaseTime, role: menuState.role, myMoney: menuState.myMoney });
  $('status').innerHTML = 'Готовим машины…';
  carsBuilding = buildCars();
  await carsBuilding;
  carsBuilding = null;
  $('status').innerHTML = '';
  $('topbar').style.display = 'flex';
  $('playersPanel').style.display = 'flex';
  cam.head = game.human ? headingOf(game.human.vehicle) : 0;
  openUpgrader();
}
const headingOf = (v) => { const q = v.q; return Math.atan2(2 * (q[0] * q[2] + q[3] * q[1]), 1 - 2 * (q[0] * q[0] + q[1] * q[1])); };

// --- upgrader ---
const up = { sel: null, spinning: false, anim: null, lastRoll: null, lastChance: 0 };
function openUpgrader() {
  const me = game.human;
  up.sel = null; up.spinning = false; up.anim = null; up.lastRoll = null;
  $('upResult').textContent = ''; $('upResult').className = '';
  $('upFeed').innerHTML = '';
  $('upSub').innerHTML = game.br
    ? `Раунд ${game.round}/${RULES.rounds} · королевская битва — все машины · +${RULES.roundIncome} за раунд`
    : `Раунд ${game.round}/${RULES.rounds} · ты — <b class="${me.role === 'hunter' ? 'cHunter' : 'cRunner'}">${me.role === 'hunter' ? 'ловец' : 'убегающий'}</b> · +${RULES.roundIncome} за раунд`;
  $('readyBtn').disabled = false;
  $('readyBtn').textContent = 'Готов';
  renderModGrid();
  selectMod(null);
  showOverlay('upgrader');
}
// stat bars: 0..1 against the whole car list
const STAT_ROWS = [
  ['Скорость', (c) => (c.top - 150) / 160],
  ['Разгон', (c) => (c.accel - 0.45) / 0.7],
  ['Управление', (c) => (c.grip * 0.6 + c.steer * 0.4 - 0.8) / 0.35],
  ['Прочность', (c) => (1 / c.armor - 0.7) / 1.9],
  ['Масса', (c) => Math.log(c.mass / 650) / Math.log(7500 / 650)],
];
function statBars(c) {
  return '<div class="stats">' + STAT_ROWS.map(([n, f]) => `<span>${n}</span><div class="sb"><div style="width:${Math.round(clamp(f(c), 0.04, 1) * 100)}%"></div></div>`).join('') + '</div>';
}
function equipHtml(c) {
  let h = '';
  if (c.pushBar) h += '<div class="tal">⛨ Кенгурятник <small>удар передом: себе меньше, другому больше · мнётся о стены</small></div>';
  if (c.sideSpikes) h += '<div class="tal">⛨ Боковые шипы <small>лопают шины, которых касаются · тупятся, когда бок смят</small></div>';
  return h;
}
function talentHtml(c) {
  if (!c.talent) return '<div class="tal" style="color:var(--dim)">Без таланта</div>' + equipHtml(c);
  const t = TALENTS[c.talent];
  const n = t.passive ? 'пассивно' : `${t.charges} ${t.charges === 1 ? 'раз' : 'раза'} за раунд`;
  return `<div class="tal">★ ${esc(game.talentName(c.talent))} <small>${esc(game.talentDesc(c.talent))} · ${n}</small></div>` + equipHtml(c);
}
function renderModGrid() {
  const me = game.human;
  const grid = $('modGrid');
  grid.innerHTML = '';
  for (const id of game.available(me)) {
    const c = CARS[id], own = game.owns(me, id), driving = me.car === id;
    const b = document.createElement('button');
    b.className = 'mod' + (up.sel === id ? ' sel' : '') + (own ? ' owned' : '') + (driving ? ' driving' : '');
    const price = `<span>${own ? '' : game.priceOf(id)}</span>`;
    const st = driving ? '<div class="o">● Ты на ней</div>' : own ? '<div class="o">В гараже — кликни, чтобы пересесть</div>' : '';
    b.innerHTML = `<div class="t"><span>${esc(c.name)}</span>${price}</div>${talentHtml(c)}${statBars(c)}${st}`;
    b.addEventListener('click', () => {
      if (up.spinning) return;
      if (own) {
        if (driving) return;
        if (net.on && net.mid) { net.send({ t: 'sel', car: id }); selectMod(null); }   // the server switches the car, the next snapshot shows it
        else if (game.selectCar(me, id)) { renderModGrid(); selectMod(null); }
      }
      else selectMod(id);
    });
    grid.appendChild(b);
  }
}
function selectMod(id) {
  up.sel = id;
  const me = game.human;
  const ids = game.available(me);
  [...$('modGrid').children].forEach((el, i) => el.classList.toggle('sel', ids[i] === id));
  const bet = $('bet');
  if (!id) {
    $('wheelInfo').innerHTML = `Ты на <b>${esc(CARS[me.car].name)}</b><br><span style="color:var(--dim);font-size:12px">Выбери машину, чтобы сыграть на неё</span>`;
    bet.disabled = true; $('spinBtn').disabled = true;
    $('betVal').textContent = '0'; $('chanceVal').textContent = '0%';
    up.lastChance = 0;
    drawWheel(0, null);
    return;
  }
  const max = game.maxBet(me, id);
  bet.disabled = max < 1;
  bet.min = 1; bet.max = Math.max(1, max);
  bet.value = Math.max(1, max);
  $('wheelInfo').innerHTML = `<b>${esc(CARS[id].name)}</b> · цена ${game.priceOf(id)}`;
  updateBet();
}
function updateBet() {
  const me = game.human, id = up.sel;
  if (!id) return;
  const max = game.maxBet(me, id);
  const b = Math.min(Number($('bet').value), max);
  const ch = max < 1 ? 0 : game.chanceFor(id, b);
  $('betVal').textContent = max < 1 ? '0' : String(b);
  $('chanceVal').textContent = `${Math.round(ch * 100)}%`;
  $('spinBtn').disabled = up.spinning || max < 1 || game.state !== 'upgrade';
  up.lastChance = ch;
  if (!up.spinning) drawWheel(ch, null);
}
function drawWheel(chance, angle) {
  const c = $('wheel'), g = c.getContext('2d');
  if (!g) return;
  const W = c.width, cx = W / 2, cy = W / 2, R = W * 0.42;
  g.clearRect(0, 0, W, W);
  g.lineWidth = W * 0.09;
  g.beginPath(); g.strokeStyle = 'rgba(255,255,255,0.10)'; g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  if (chance > 0) {
    g.beginPath(); g.strokeStyle = '#34c759';
    g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + chance * Math.PI * 2); g.stroke();
  }
  g.fillStyle = '#fff'; g.font = `800 ${Math.round(W * 0.13)}px "Exo 2", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(`${Math.round(chance * 100)}%`, cx, cy);
  if (angle !== null) {
    const a = -Math.PI / 2 + angle;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    g.save(); g.translate(x, y); g.rotate(a + Math.PI / 2);
    g.beginPath(); g.moveTo(0, -W * 0.075); g.lineTo(W * 0.045, W * 0.055); g.lineTo(-W * 0.045, W * 0.055); g.closePath();
    g.fillStyle = '#ffd25a'; g.strokeStyle = '#111'; g.lineWidth = 3; g.fill(); g.stroke();
    g.restore();
  }
}
function doSpin() {
  const me = game.human, id = up.sel;
  if (!id || up.spinning) return;
  const bet = Math.min(Number($('bet').value), game.maxBet(me, id));
  if (net.on) {                                   // the server spins; the answer starts the wheel
    up.spinning = true; $('spinBtn').disabled = true;
    net.send({ t: 'spin', car: id, bet });
    return;
  }
  const res = game.spin(me, id, bet);
  startSpinAnim(res);
}
function startSpinAnim(res) {
  const me = game.human;
  if (!res) { up.spinning = false; $('spinBtn').disabled = false; return; }
  up.spinning = true;
  $('spinBtn').disabled = true;
  $('upResult').textContent = ''; $('upResult').className = '';
  up.anim = { t: 0, dur: 2.6, turns: 4, roll: res.roll, chance: res.chance, res };
  $('upMoney').textContent = me.money;
}
function tickUpgrader(dt) {
  const me = game.human;
  setText('upTimer', $('upTimer'), fmtTime(game.timer));
  setText('upMoney', $('upMoney'), String(me.money));
  if (up.anim) {
    const a = up.anim;
    a.t += dt;
    const k = Math.min(a.t / a.dur, 1), e = 1 - Math.pow(1 - k, 3);
    const total = (a.turns + a.roll) * Math.PI * 2;
    drawWheel(a.chance, e * total);
    const seg = Math.floor(e * total / 0.35);
    if (seg !== a.lastSeg) { a.lastSeg = seg; sfx.tick(); }
    if (k >= 1) {
      if (a.res.win) sfx.win(); else sfx.lose();
      up.anim = null; up.spinning = false;
      const r = a.res;
      $('upResult').textContent = r.win ? `Выиграл: ${r.car}!` : 'Не повезло';
      $('upResult').className = r.win ? 'win' : 'lose';
      renderModGrid();
      selectMod(r.win ? null : r.carId);
    }
  }
}

// --- round / match results ---
function showRoundEndBr() {
  const lr = game.lastRound, w = lr.winner === null ? null : game.players[lr.winner];
  $('reSub').textContent = `Раунд ${lr.round}/${RULES.rounds} · королевская битва`;
  $('reTitle').innerHTML = !w ? 'Никто не выжил' : w === game.human ? `<span style="color:${w.color}">Ты выиграл раунд!</span>` : `Раунд выиграл <span style="color:${w.color}">${esc(w.name)}</span>`;
  $('reReason').textContent = { lastStanding: 'Остался последним на ходу', time: 'Время вышло — больше всех разбил (или машина целее всех)', allDestroyed: 'Разбиты все' }[lr.reason] || '';
  let rows = '<tr><th>Игрок</th><th>Машина</th><th class="num">Раунд</th><th class="num">Разбил</th><th class="num">Выживание</th><th class="num">Победа</th><th class="num">Деньги</th></tr>';
  for (const p of game.players) {
    const e = p.roundEarn;
    rows += `<tr><td>${pName(p)}</td><td style="font-size:12px">${esc(CARS[p.car].name)}</td><td class="num">+${e.income}</td><td class="num">${e.kills ? '+' + e.kills : '—'}</td><td class="num">${e.survive ? '+' + e.survive : '—'}</td><td class="num">${e.win ? '+' + e.win : '—'}</td><td class="num cGold">${p.money}</td></tr>`;
  }
  $('reTable').innerHTML = rows;
  $('reScore').innerHTML = 'Победы: ' + game.brStandings().map((p) => `<span style="color:${p.color}">${esc(p.name)} ${p.wins}</span>`).join(' · ');
  $('reNext').textContent = game.round >= RULES.rounds ? 'Итоги матча' : 'Дальше';
  showOverlay('roundEnd');
}
function showRoundEnd() {
  if (game.br) return showRoundEndBr();
  const lr = game.lastRound;
  $('reSub').textContent = `Раунд ${lr.round}/${RULES.rounds}`;
  $('reTitle').innerHTML = lr.winner === 'hunter' ? '<span class="cHunter">Победил ловец</span>' : '<span class="cRunner">Победили убегающие</span>';
  $('reReason').textContent = { allDestroyed: 'Все убегающие разбиты', time: 'Время вышло — кто-то выжил', hunterDestroyed: 'Машина ловца разбита' }[lr.reason] || '';
  let rows = '<tr><th>Игрок</th><th>Машина</th><th class="num">Раунд</th><th class="num">Ловля</th><th class="num">Выживание</th><th class="num">Победа</th><th class="num">Деньги</th></tr>';
  for (const p of game.players) {
    const e = p.roundEarn;
    rows += `<tr><td>${pName(p)}${p.role === 'hunter' ? ' <small class="cHunter">ловец</small>' : ''}</td><td style="font-size:12px">${esc(CARS[p.car].name)}</td><td class="num">+${e.income}</td><td class="num">${e.kills ? '+' + e.kills : '—'}</td><td class="num">${e.survive ? '+' + e.survive : '—'}</td><td class="num">${e.win ? '+' + e.win : '—'}</td><td class="num cGold">${p.money}</td></tr>`;
  }
  $('reTable').innerHTML = rows;
  $('reScore').innerHTML = `Счёт: <span class="cHunter">ловец ${game.score.hunter}</span> : <span class="cRunner">${game.score.runners} убегающие</span>`;
  $('reNext').textContent = game.round >= RULES.rounds ? 'Итоги матча' : 'Дальше';
  showOverlay('roundEnd');
}
function showMatchEndBr() {
  const me = game.human, st = game.brStandings(), w = st[0];
  $('meTitle').innerHTML = w === me ? `<span style="color:${w.color}">Ты выиграл матч!</span>` : `Победил <span style="color:${w.color}">${esc(w.name)}</span>`;
  $('meScore').innerHTML = 'Победы в раундах: ' + st.map((p) => `<span style="color:${p.color}">${esc(p.name)} ${p.wins}</span>`).join(' · ');
  let rows = '<tr><th>Место</th><th>Игрок</th><th class="num">Побед</th><th>Гараж</th><th class="num">Деньги</th></tr>';
  st.forEach((p, i) => {
    const cars = p.garage.map((id) => (id === p.car ? `<b>${esc(CARS[id].name)}</b>` : esc(CARS[id].name))).join(', ');
    rows += `<tr><td>${i + 1}</td><td>${pName(p)}</td><td class="num">${p.wins}</td><td style="font-size:12px">${cars}</td><td class="num cGold">${p.money}</td></tr>`;
  });
  $('meTable').innerHTML = rows;
  showOverlay('matchEnd');
}
function showMatchEnd(winner) {
  if (game.br) return showMatchEndBr();
  const me = game.human;
  const myWin = (winner === 'hunter') === (me.role === 'hunter');
  $('meTitle').innerHTML = (winner === 'hunter' ? '<span class="cHunter">Победил ловец</span>' : '<span class="cRunner">Победили убегающие</span>') + (myWin ? ' — ты в команде победителей!' : '');
  $('meScore').innerHTML = `Раунды: <span class="cHunter">ловец ${game.score.hunter}</span> : <span class="cRunner">${game.score.runners} убегающие</span>`;
  let rows = '<tr><th>Игрок</th><th>Роль</th><th>Гараж</th><th class="num">Деньги</th></tr>';
  for (const p of game.players) {
    const cars = p.garage.map((id) => (id === p.car ? `<b>${esc(CARS[id].name)}</b>` : esc(CARS[id].name))).join(', ');
    rows += `<tr><td>${pName(p)}</td><td>${p.role === 'hunter' ? 'ловец' : 'убегает'}</td><td style="font-size:12px">${cars}</td><td class="num cGold">${p.money}</td></tr>`;
  }
  $('meTable').innerHTML = rows;
  showOverlay('matchEnd');
}

// --- in-game HUD ---
function updateGameHud() {
  const me = game.human;
  setText('round', $('roundTxt'), `Раунд ${game.round}/${RULES.rounds}`);
  if (game.br) {
    const alive = game.players.filter((p) => p.alive).length;
    setHTML('score', $('scoreBox'), `<span class="cRunner">Каждый сам за себя</span> · в живых <b>${alive}</b> · твоих побед <b>${me.wins}</b>`);
  } else setHTML('score', $('scoreBox'), `<span class="cHunter">Ловец <b>${game.score.hunter}</b></span> : <span class="cRunner"><b>${game.score.runners}</b> Убегающие</span>`);
  const tEl = $('timerTxt');
  const t = game.state === 'chase' ? game.timer : game.state === 'countdown' ? game.settings.chaseTime : 0;
  setText('timer', tEl, fmtTime(t));
  tEl.classList.toggle('low', game.state === 'chase' && game.timer < 15);

  // players list
  let html = '';
  for (const p of game.players) {
    const st = !p.alive && p.wreck ? `<div class="st">разбит: ${WRECK_WHY[p.wreck] || 'не может ехать'}</div>` : '';
    const role = game.br ? `побед: ${p.wins}` : p.role === 'hunter' ? 'ловец' : 'убегает';
    html += `<div class="prow${p.alive ? '' : ' dead'}"><div class="dot" style="background:${p.color}"></div><div class="nm">${esc(p.name)}<small>${role}</small></div><div class="money">${p.money}</div>${st}</div>`;
  }
  setHTML('players', $('playersPanel'), html);

  // abilities
  let ab = '';
  if (game.state === 'chase' || game.state === 'countdown') {
    const id = game.talentOf(me);
    if (id && TALENTS[id].passive) ab += `<div class="ab passive"><div class="n">${esc(game.talentName(id))}</div><div class="c">пассивно</div></div>`;
    else if (id) {
      const n = me.charges[id] || 0;
      ab += `<div class="ab${n ? '' : ' empty'}"><div class="n"><span class="k">1</span>${esc(game.talentName(id))}</div><div class="c">зарядов: ${n}</div></div>`;
    }
  }
  if (game.state === 'chase' || game.state === 'countdown') {
    if (CARS[me.car].pushBar) ab += `<div class="ab passive"><div class="n">Кенгурятник</div><div class="c">${Math.round((me.vehicle.pushBar ?? 1) * 100)}%</div></div>`;
    if (CARS[me.car].sideSpikes) ab += `<div class="ab passive"><div class="n">Боковые шипы</div><div class="c">Л ${Math.round(game.spikeSharpness(me.vehicle, 1) * 100)}% · П ${Math.round(game.spikeSharpness(me.vehicle, -1) * 100)}%</div></div>`;
  }
  setHTML('abilities', $('abilities'), ab);

  // centre status
  let st = '';
  if (game.state === 'countdown' && !carsReady()) st = `Загружаем машины… ${Math.round(carsLoadPct() * 100)}%\n<small>Раунд начнётся, когда у всех появятся машины</small>`;
  else if (game.state === 'countdown' && game.br) st = `Раунд ${game.round}\n<small>Каждый сам за себя: ты на ${esc(CARS[me.car].name)} — разбей всех и останься на ходу</small>`;
  else if (game.state === 'countdown') st = `Раунд ${game.round}\n<small>${me.role === 'hunter' ? `Ты ловец на ${esc(CARS[me.car].name)} — разбей всех убегающих` : `Ты убегаешь на ${esc(CARS[me.car].name)} — продержись до конца. Ловец на ${esc(CARS[game.hunter.car].name)}`}</small>`;
  else if (game.state === 'chase' && game.hunterHold > 0) st = me.role === 'hunter' ? `Жди… ${Math.ceil(game.hunterHold)}\n<small>Убегающие разъезжаются</small>` : `Разъезжайся! Ловец через ${Math.ceil(game.hunterHold)}`;
  else if (game.state === 'chase' && !me.alive) st = `Ты разбит — наблюдаешь\n<small>Tab — сменить камеру</small>`;
  setHTML('status', $('status'), st.replace(/\n/g, '<br>'));

}

const WHEEL_NAMES = ['переднее левое', 'переднее правое', 'заднее левое', 'заднее правое'];
const CORNER_NAMES = ['спереди слева', 'спереди справа', 'сзади слева', 'сзади справа'];
const WRECK_WHY = { driver: 'водитель погиб', engine: 'двигатель разбит', gearbox: 'коробка разбита', suspension: 'сломана подвеска', drive: 'не может ехать' };
const lastDamage = { engine: 0, gearbox: 0, driver: 0, wheels: [0, 0, 0, 0], susp: [0, 0, 0, 0], brakes: [0, 0, 0, 0] };
function resetDamageHud() { Object.assign(lastDamage, { engine: 0, gearbox: 0, driver: 0, wheels: [0, 0, 0, 0], susp: [0, 0, 0, 0], brakes: [0, 0, 0, 0] }); }
let dmgHudTimer = 0, dmgLayout = '';
function dmgColor(d) {
  if (d >= 0.999) return '#6e1414';                       // destroyed
  const h = 120 * Math.pow(1 - clamp(d, 0, 1), 1.3);
  return `hsl(${h.toFixed(0)}, 72%, ${d < 0.02 ? 45 : 50}%)`;
}
function crossed(prev, now, th) { return prev < th && now >= th; }
function updateDamageHud(v, dt) {
  dmgHudTimer -= dt;
  if (dmgHudTimer > 0) return;
  dmgHudTimer = 0.1;
  const D = v.damage, L = lastDamage;
  // engine / gearbox drawn where this car has them
  const layout = v.spec.layout || 'front';
  if (layout !== dmgLayout) {
    dmgLayout = layout;
    const ey = { front: 0, mid: 88, rear: 110 }[layout], gy = { front: 0, mid: 84, rear: 54 }[layout];
    $('dmgEngineG').setAttribute('transform', `translate(0 ${ey})`);
    $('dmgGearboxG').setAttribute('transform', `translate(0 ${gy})`);
  }
  let msg = null;
  const say = (m) => { if (!msg) msg = m; };
  if (crossed(L.driver, D.driver, 1)) say('Водитель погиб');
  else if (crossed(L.driver, D.driver, 0.4)) say('Водитель ранен — ещё удар в его дверь может стать последним');
  if (crossed(L.engine, D.engine, 1)) say('Двигатель разбит');
  else if (crossed(L.engine, D.engine, 0.6)) say('Двигатель сильно повреждён: мощности почти нет');
  else if (crossed(L.engine, D.engine, 0.25)) say('Двигатель повреждён: мощность упала');
  else if (crossed(L.engine, D.engine, 0.05)) say('Двигатель задет');
  if (crossed(L.gearbox, D.gearbox, 1)) say('Коробка разбита');
  else if (crossed(L.gearbox, D.gearbox, 0.5)) say('Коробка повреждена: пропали верхние передачи');
  else if (crossed(L.gearbox, D.gearbox, 0.1)) say('Коробка задета: передачи включаются медленнее');
  for (let i = 0; i < 4; i++) {
    if (crossed(L.susp[i], D.susp[i], 1)) say(`Подвеска ${CORNER_NAMES[i]} сломана — колесо подломилось`);
    else if (crossed(L.susp[i], D.susp[i], 0.3)) say(`Подвеска ${CORNER_NAMES[i]} погнута — машину тянет`);
    if (crossed(L.brakes[i], D.brakes[i], 0.5)) say(`Тормоз ${CORNER_NAMES[i]} повреждён — при торможении уводит`);
    if (crossed(L.wheels[i], D.wheels[i], 0.6)) say(`Колесо ${WHEEL_NAMES[i]} спускает`);
    else if (crossed(L.wheels[i], D.wheels[i], 0.15)) say(`Колесо ${WHEEL_NAMES[i]} погнуто — машину уводит`);
  }
  if (msg && game.state === 'chase' && game.human.alive) toast(msg, 3000);
  L.engine = D.engine; L.gearbox = D.gearbox; L.driver = D.driver;
  L.wheels = D.wheels.slice(); L.susp = D.susp.slice(); L.brakes = D.brakes.slice();
  const paint = (id, d, attr = 'fill') => {
    const el = $(id), c = dmgColor(d);
    if (el && el.dataset.c !== c) { el.dataset.c = c; el.setAttribute(attr, c); }
  };
  paint('dmgBody', D.body, 'stroke');
  paint('dmgEngine', D.engine); paint('dmgGearbox', D.gearbox); paint('dmgDriver', D.driver);
  $('dmgDriverX').style.display = D.driver >= 1 ? '' : 'none';
  for (let i = 0; i < 4; i++) {
    paint('dmgWheel' + i, D.wheels[i]); paint('dmgBrake' + i, D.brakes[i]); paint('dmgSusp' + i, D.susp[i], 'stroke');
  }
}

// floating name tags over the other cars
const _proj = new THREE.Vector3();
function updateLabels() {
  const me = followed();
  for (const cv of carVis.values()) {
    const p = cv.player, el = cv.label;
    if (!el) continue;
    const show = p !== me && game.state !== 'menu';
    if (!show) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
    _proj.copy(cv.root.position); _proj.y += cv.size.H + 0.15 - cv.spec.com[1];
    const dist = _proj.distanceTo(camera.position);
    _proj.project(camera);
    if (_proj.z > 1 || dist > 160) { el.style.display = 'none'; continue; }
    el.style.display = 'block';
    el.style.left = `${((_proj.x + 1) / 2 * window.innerWidth).toFixed(1)}px`;
    el.style.top = `${((1 - _proj.y) / 2 * window.innerHeight).toFixed(1)}px`;
    el.style.opacity = p.alive ? '1' : '0.5';
  }
}

// engines, tyres, wind: one voice per car on the track
const audioCars = [];
function audioCar(key, cv, v) {
  let slip = 0;
  for (const wh of v.wheels) if (wh.contact) slip = Math.max(slip, Math.hypot(wh.omega * wh.radius - wh.vLong, wh.vLat));
  return { key, carId: cv.carId, pos: [cv.root.position.x, cv.root.position.y, cv.root.position.z], rpm: v.rpm,
    throttle: v.ctl.throttle, speed: Math.hypot(v.vel[0], v.vel[1], v.vel[2]), slip, alive: !v.destroyed, boost: v.boost > 0 };
}
function updateAudio(dt) {
  audioCars.length = 0;
  const live = game && (game.state === 'chase' || game.state === 'countdown' || game.state === 'roundEnd') && !carsBuilding;
  if (live) {
    for (const cv of carVis.values()) if (cv.player && cv.player.vehicle) audioCars.push(audioCar(cv.player.id, cv, cv.player.vehicle));
    for (const [rec, cv] of decoyVis) audioCars.push(audioCar(cv, cv, rec.vehicle));
  }
  sfx.update(dt, camera, audioCars, live ? 1 : 0.5);
}

// ---------------------------------------------------------------------------
// Online: the match runs on the server (server.js); this browser keeps a copy of the game filled from its
// snapshots (20 a second), shows it the usual way and sends the keys. Works when the page comes from the server.
// ---------------------------------------------------------------------------
const net = { ws: null, on: false, pid: null, mid: 0, gap: 0.05, lastT: 0, sendT: 0, lastIn: '', zones: new Map(), decoys: new Map() };
net.send = (m) => { try { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(m)); } catch (_) { /* ignore */ } };
function netConnect() {
  if (net.ws) return;
  const name = ($('netName').value || '').trim() || 'Игрок';
  try { localStorage.setItem('salki.name', name); } catch (_) { /* ignore */ }
  if (!/^https?:$/.test(location.protocol) || /claude\.ai|claudeusercontent/.test(location.hostname)) {
    $('netStatus').textContent = 'Онлайн работает, только если открыть игру по адресу сервера.';
    return;
  }
  $('netStatus').textContent = 'Подключаемся… (если сервер спал, это до минуты)';
  let ws;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) {
    $('netStatus').textContent = 'Не удалось подключиться'; return;
  }
  net.ws = ws;
  ws.onopen = () => { net.on = true; net.send({ t: 'hello', name, money: menuState.myMoney }); $('netBtn').textContent = 'Отключиться'; };
  // a free server sleeps after 15 min without messages from players: keep it awake while we sit in the lobby
  const keepAwake = setInterval(() => { if (net.ws === ws) net.send({ t: 'ping' }); else clearInterval(keepAwake); }, 60000);
  ws.onclose = () => {
    const was = net.on;
    net.ws = null; net.on = false; net.pid = null; net.mid = 0;
    $('netBtn').textContent = 'Подключиться';
    $('netStatus').textContent = was ? 'Связь с сервером потеряна' : 'Сервер недоступен';
    if (was && game.state !== 'menu') { toast('Связь с сервером потеряна', 3000); openMenu(); }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'welcome') net.pid = m.pid;
    else if (m.t === 'full') $('netStatus').textContent = 'Все 4 места заняты';
    else if (m.t === 'lobby') netLobby(m);
    else if (m.t === 's') netSnapshot(m);
    else if (m.t === 'spinRes') startSpinAnim(m.res);
  };
}
function netLobby(m) {
  const names = m.names.map(esc).join(', ');
  const running = m.st !== 'menu';
  $('netStatus').innerHTML = `Онлайн · в комнате: <b>${names}</b><br>` +
    (running ? 'Идёт матч — ты в нём (или сядешь на место бота)' : 'Матча нет — нажми «Начать матч», начнётся у всех');
  if (!running && net.mid) {                      // the server went back to the lobby
    net.mid = 0; net.pid = null;
    if (game.state !== 'menu') openMenu();
  }
}
async function netStartMirror(s) {
  net.mid = s.id; net.zones.clear(); net.decoys.clear();
  for (const [zn, obj] of zoneVisuals) { scene.remove(obj); zoneVisuals.delete(zn); }
  for (const [, cv] of decoyVis) disposeVisual(cv);
  decoyVis.clear();
  game.newMatch({ mode: s.mode, bots: s.pl.length - 1, chaseTime: s.ct, role: 'random' });
  game.events.length = 0;
  netApplyPlayers(s, true);
  game.events.length = 0;
  showOverlay(null);
  $('status').innerHTML = 'Готовим машины…';
  carsBuilding = buildCars();
  await carsBuilding;
  carsBuilding = null;
  $('status').innerHTML = '';
  $('topbar').style.display = 'flex';
  $('playersPanel').style.display = 'flex';
  cam.head = game.human ? headingOf(game.human.vehicle) : 0;
  if (game.state === 'upgrade') openUpgrader();
}
function netApplyPlayers(s, first) {
  for (const o of s.pl) {
    const p = game.players[o.id];
    if (!p) continue;
    p.name = o.id === net.pid ? `${o.n} (ты)` : o.n;
    p.role = o.r; p.color = o.c; p.garage = o.g; p.money = o.m; p.alive = o.a; p.wreck = o.w; p.ready = o.rd;
    p.wins = o.wins; p.charges = o.ch; p.roundEarn = o.re; p.matchEarn = o.me; p.aliveTime = o.at; p.roundKills = o.k;
    p.isBot = o.id !== net.pid; p.remote = false;
    let fresh = first;
    if (p.car !== o.car || p.vehicle.spec.id !== o.car) { p.car = o.car; game._ensureVehicle(p); fresh = true; }
    unpackVehicle(p.vehicle, o.v, fresh);
  }
}
function netSnapshot(s) {
  if (net.pid == null) return;
  if (s.id !== net.mid) { netStartMirror(s); return; }
  const now = performance.now();
  if (net.lastT) net.gap += (clamp((now - net.lastT) / 1000, 0.02, 0.2) - net.gap) * 0.2;
  net.lastT = now;
  game.state = s.st; game.timer = s.tm; game.round = s.rd; game.score = s.sc; game.hunterHold = s.hh;
  game.lastRound = s.lr; game.time = s.time;
  netApplyPlayers(s, false);
  // oil, glue, spikes on the floor; harpoon ropes; decoys
  const zs = new Set();
  game.zones = s.z.map((o) => {
    zs.add(o.id);
    const z = net.zones.get(o.id);
    if (z) return Object.assign(z, o);
    const n = { ...o }; net.zones.set(o.id, n); return n;
  });
  for (const id of [...net.zones.keys()]) if (!zs.has(id)) net.zones.delete(id);
  game.harpoons = s.hp.map(([a, b]) => ({ hunter: game.players[a], runner: game.players[b] }));
  const ds = new Set();
  for (const o of s.dc) {
    ds.add(o.id);
    let rec = net.decoys.get(o.id), fresh = false;
    if (!rec) { rec = { owner: game.players[o.o], vehicle: new Vehicle(specFor(o.car), world), t: o.t }; net.decoys.set(o.id, rec); fresh = true; }
    rec.t = o.t;
    unpackVehicle(rec.vehicle, o.v, fresh);
  }
  for (const [id, rec] of net.decoys) if (!ds.has(id)) { rec.removed = true; rec.t = 0; net.decoys.delete(id); }
  // events and per-car effects, as if they happened here
  for (const e of s.ev) {
    if (e.zone && e.zone.$z) e.zone = net.zones.get(e.zone.$z) || null;
    if (e.decoy && e.decoy.$d) e.decoy = net.decoys.get(e.decoy.$d) || { removed: true, t: 0, vehicle: null };
    if (e.kind === 'decoy' && (!e.decoy || !e.decoy.vehicle)) continue;
    game.events.push(e);
  }
  for (const id in s.fx) { const p = game.players[id]; if (p && p.fx) p.fx.push(...s.fx[id]); }
}
// once a frame online: send the keys (when they change, at least 5 times a second) and blend between snapshots
function netFrame(now, input, actions) {
  const playing = game.state === 'chase' || game.state === 'countdown';
  const i = playing ? [input.throttle, input.brake, Math.round(input.steer * 100) / 100, input.handbrake ? 1 : 0] : [0, 0, 0, 0];
  const key = i.join(',');
  if (key !== net.lastIn || now - net.sendT > 200) { net.send({ t: 'in', i }); net.lastIn = key; net.sendT = now; }
  for (const a of actions) net.send({ t: 'act', a });
  return clamp((now - net.lastT) / 1000 / net.gap, 0, 1);
}

// ---------------------------------------------------------------------------
// Game events -> UI and effects
// ---------------------------------------------------------------------------
function handleGameEvents() {
  const me = game.human;
  for (const e of game.events) {
    switch (e.type) {
      case 'state':
        if (e.state === 'upgrade') {
          // new round: the cars are repaired — the dents and scratches go too, the wheels go back on
          dmgQueue.length = 0;
          restoreWheels();
          for (const cv of carVis.values()) if (cv.damageVis) cv.damageVis.repair();
          resetDamageHud();
          openUpgrader();
        }
        else if (e.state === 'countdown') { showOverlay(null); canvas.focus(); sfx.beep(660, 0.15); }
        else if (e.state === 'chase') sfx.beep(1320, 0.35, 0.3);
        break;
      case 'hunterGo': sfx.horn(); toast(me.role === 'hunter' ? 'Вперёд! Разбей их!' : 'Ловец выехал!', 1400); break;
      case 'spin': {
        if (e.player === me.id) break;
        const p = game.players[e.player];
        const line = document.createElement('div');
        line.innerHTML = `${pName(p)}: ${esc(e.car)} — ставка ${e.bet}, шанс ${Math.round(e.chance * 100)}% — ${e.win ? '<b style="color:#4cd964">выиграл</b>' : 'проиграл'}`;
        $('upFeed').prepend(line);
        break;
      }
      case 'kill': {
        const v = game.players[e.victimId];
        const why = WRECK_WHY[e.why] ? ` — ${WRECK_WHY[e.why]}` : '';
        if (e.br) feed(`${pName(v)} разбит${why}` + (e.by ? ` · ${pName(game.players[e.byId])} <b class="cGold">+${e.reward}</b>` : ' (сам)'));
        else if (e.hunter) feed(`${pName(v)} (ловец) разбит${why}!`);
        else feed(`${pName(v)} разбит${why}${e.reward ? ` · ловцу <b class="cGold">+${e.reward}</b>${e.full ? '' : ' (сам разбился)'}` : ''}`);
        if (e.victimId === me.id) toast(`Твоя машина разбита${why}`, 3000);
        break;
      }
      case 'roundEnd': {
        setTimeout(() => { if (game.state === 'roundEnd') showRoundEnd(); }, 1200);
        const won = e.br ? e.winner === me.id : (e.winner === 'hunter') === (me.role === 'hunter');
        sfx.cheer(1); setTimeout(() => (won ? sfx.win() : sfx.lose()), 900);
        break;
      }
      case 'matchEnd': showMatchEnd(e.winner); break;
      case 'toast': if (e.player === me.id) toast(e.text, 2000); break;
      case 'carHit': {
        const f = followed();
        if (f && (e.a === f.id || e.b === f.id)) cam.shake = Math.min(1, cam.shake + e.speed / 30);
        break;
      }
      case 'talent': {
        const p = game.players[e.player];
        if (p && p.vehicle) sfx.fx(e.id, [p.vehicle.pos[0], p.vehicle.pos[1], p.vehicle.pos[2]]);
        if (e.player !== me.id && TALENTS[e.id]) feed(`${pName(p)}: ${esc(game.talentName(e.id))}`);
        break;
      }
      case 'carChanged': {
        const p = game.players[e.player];
        if (p && !carsBuilding && carVis.has(p.id)) refreshCar(p);
        if (p && p === me && game.state === 'upgrade') renderModGrid();
        break;
      }
      case 'fx': fxEvent(e); break;
    }
  }
  game.events.length = 0;
}

function fxEvent(e) {
  switch (e.kind) {
    case 'wheelOff': {
      const cv = carVis.get(e.player);
      if (!cv) break;
      if (e.wheel >= 0) throwWheel(cv, e.wheel, false);
      else for (let i = 0; i < 4 + (cv.extraWheels ? cv.extraWheels.length : 0); i++) throwWheel(cv, i, true);
      if (e.wheel >= 0 && e.player === game.human.id) toast('Колесо оторвало!', 1600);
      break;
    }
    case 'explode': explosion(e.x, e.y, e.z); sfx.explode([e.x, e.y, e.z]); { const f = followed(); if (f && f.vehicle && Math.hypot(f.vehicle.pos[0] - e.x, f.vehicle.pos[2] - e.z) < 30) cam.shake = 1; } break;
    case 'smoke': smokeEmitters.push({ x: e.x, z: e.z, r: e.r, t: 1.6 }); break;
    case 'jump': {
      const v = game.players[e.player].vehicle;
      for (const wh of v.wheels) for (let i = 0; i < 10; i++) fx.dust.emit(wh.cp[0], wh.cp[1] + 0.05, wh.cp[2], rnd(-3, 3), rnd(0.2, 1.5), rnd(-3, 3), rnd(1, 2), 0.4, 2.2, 0.35, DUST, 2, 0.1);
      break;
    }
    case 'swap': {
      for (const [x, z] of [e.from, e.to]) {
        const y = world.height(x, z) + 0.8;
        for (let i = 0; i < 50; i++) { const a = Math.random() * Math.PI * 2, s = rnd(1, 5); fx.sparks.emit(x, y, z, Math.cos(a) * s, rnd(-1, 4), Math.sin(a) * s, rnd(0.4, 0.9), rnd(0.15, 0.3), 0.02, 1, SWAP, 1.5, 0); }
      }
      break;
    }
    case 'decoy': {
      const owner = game.players[e.owner];
      const rec = e.decoy;
      buildCarVisual(owner.car, owner.color).then((cv) => { cv.player = { vehicle: rec.vehicle, decoy: true }; if (rec.removed) disposeVisual(cv); else decoyVis.set(rec, cv); });
      break;
    }
    case 'decoyPop': case 'decoyGone': {
      for (let i = 0; i < 25; i++) fx.smoke.emit(e.x + rnd(-1.5, 1.5), e.y + rnd(0, 1), e.z + rnd(-1.5, 1.5), rnd(-1, 1), rnd(0.5, 2), rnd(-1, 1), rnd(1.5, 3), 1, 3.5, 0.5, SMOKE_SCREEN, 1, 0.3);
      for (const [rec, cv] of decoyVis) if (rec.removed || rec.t <= 0) { disposeVisual(cv); decoyVis.delete(rec); }
      break;
    }
    case 'puncture': {
      const v = game.players[e.player].vehicle, wh = v.wheels[e.wheel];
      sfx.fx('puncture', [wh.cp[0], wh.cp[1], wh.cp[2]]);
      sparkBurst([wh.cp[0], wh.cp[1] + 0.1, wh.cp[2]], [0, 1, 0], 14, v.vel);
      if (e.player === game.human.id) toast('Колесо пробито шипами!', 1800);
      break;
    }
    case 'harpoon': if (e.runner === game.human.id) toast('Тебя зацепили гарпуном!', 1600); break;
    default: break;
  }
}

function tickSmokeScreens(dt) {
  for (const s of smokeEmitters) {
    s.t -= dt;
    s.acc = (s.acc || 0) + 60 * dt;           // ~100 big puffs over 1.6 s
    while (s.acc >= 1) {
      s.acc -= 1;
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * s.r * 0.8;
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      fx.smoke.emit(x, world.height(x, z) + rnd(0.3, 1.8), z, rnd(-0.6, 0.6), rnd(0.1, 0.5), rnd(-0.6, 0.6), rnd(6, 8.5), rnd(2, 3), rnd(6, 9), 0.55, SMOKE_SCREEN, 0.6, 0.05);
    }
  }
  for (let i = smokeEmitters.length - 1; i >= 0; i--) if (smokeEmitters[i].t <= 0) smokeEmitters.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  // the cars download while the arena is being built (it is made in code: nothing to download)
  const carsP = Promise.all([ensureCarBytes('smallcar', 'car'), ensureCarBytes('police', 'car2')]);
  const arena = await buildArena(THREE, { progress: (v) => setProgress('arena', v) });
  scene.add(arena.group);
  flames = arena.flames;
  const skyTex = new THREE.CanvasTexture(arena.sky);
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.environment = pmrem.fromEquirectangular(skyTex).texture;
  // the floor mirrors the arena; then a light probe from the middle replaces the bare sky as the environment
  gfx.attachFloor(arena.group.getObjectByName('arena_floor'));
  {
    const probe = gfx.bakeProbe([0, 2.5, 0], [fx.fire.points || fx.fire.mesh].filter(Boolean));
    if (probe) { scene.environment = probe; scene.environmentIntensity = ARENA_LIGHT.probeIntensity; }
  }
  gfx.setQuality(menuState.gfx);
  world = new ArenaWorld(ARENA_R);
  await carsP;
  setProgress('car', 1); setProgress('car2', 1);

  game = new Game(world);
  initMenu();
  $('credits').innerHTML = 'Машины (модели со Sketchfab): ' +
    Object.values(CARS).map((c) => `${esc(c.name)} — ${esc(c.credit)}`).join('; ');
  camera.position.set(60, 25, 60);
  camera.lookAt(0, 0, 0);

  renderer.compile(scene, camera);
  $('loading').style.opacity = '0';
  setTimeout(() => $('loading').remove(), 600);
  started = true;
  openMenu();

  let last = performance.now(), fpsFrames = 0, fpsTime = 0;
  const baseFov = 62;
  const target = new THREE.Vector3(), fwd = new THREE.Vector3();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const me = game.human;

    // --- rules + physics ---
    const playing = game.state === 'chase' || game.state === 'countdown';
    const input = playing && !overlayOpen() ? readInput() : { throttle: 0, brake: 0, steer: 0, handbrake: false };
    const actions = pendingMods.splice(0);
    let alpha = 0;
    const waitCars = game.state === 'countdown' && !carsReady();
    if (net.on && net.mid) alpha = netFrame(now, input, actions);
    else if (game.state !== 'menu' && !carsBuilding && !waitCars) alpha = game.update(dt, input, actions);
    if (game.state === 'upgrade') tickUpgrader(dt);

    try {
      handleGameEvents();
      // --- cars ---
      for (const cv of carVis.values()) {
        const p = cv.player, v = p.vehicle;
        poseVisual(cv, v, alpha);
        poseEquipment(cv, v);
        for (const ev of p.fx || []) carHitFx(cv, ev);
        if (p.fx) p.fx.length = 0;
        emitWheelDust(cv, v, dt);
        emitCarSmoke(cv, v, dt);
      }
      for (const [rec, cv] of decoyVis) {
        if (rec.removed) { disposeVisual(cv); decoyVis.delete(rec); continue; }
        poseVisual(cv, rec.vehicle, alpha);
        emitWheelDust(cv, rec.vehicle, dt);
      }
      runDamageQueue();
      tickFlyingWheels(dt);
      if (game.sim) { syncZones(); syncRopes(); }
      tickSmokeScreens(dt);
    } catch (e) { if (!fxErrorShown) { fxErrorShown = true; console.warn('effects:', e); } }

    // --- camera ---
    if (mouseLocked() && !canLock()) document.exitPointerLock();   // menus and the garage need the mouse
    const fp = followed();
    const fcv = fp ? carVis.get(fp.id) : null;
    if (fcv) {
      const t = now / 1000;
      fwd.set(0, 0, 1).applyQuaternion(fcv.root.quaternion);
      const heading = Math.atan2(fwd.x, fwd.z);
      if (cam.followId !== fp.id) { cam.followId = fp.id; cam.head = heading; }
      cam.head += wrap(heading - cam.head) * (1 - Math.exp(-dt * 5));
      const idle = !cam.dragging && t - cam.lastMouse > 2.0;
      if (idle && Math.abs(fp.vehicle.speed) > 3) {
        cam.yaw = wrap(cam.yaw) * Math.exp(-dt * 2.2);   // back behind the car by the shortest way
        cam.pitch += (0.2 - cam.pitch) * (1 - Math.exp(-dt * 1.5));
      }
      const lookBack = keys.has('KeyC') ? Math.PI : 0;
      const H = cam.head + cam.yaw + lookBack;
      const cp = Math.cos(cam.pitch), spch = Math.sin(cam.pitch);
      const dx = -Math.sin(H) * cp, dy = spch, dz = -Math.cos(H) * cp;
      const csc = clamp(fcv.size.L / 4.6, 0.85, 1.75);
      target.copy(fcv.root.position); target.y += 0.75 * Math.max(1, fcv.size.H / 1.3);
      const camDist = cam.dist * csc;
      let dist = camDist;
      for (let s = 0.6; s <= camDist; s += 0.25) {
        const y = target.y + dy * s;
        if (y < 24 && world.sdf(target.x + dx * s, target.z + dz * s) < 0.6) { dist = Math.max(s - 0.6, 1.4); break; }
      }
      cam.smoothDist = dist < cam.smoothDist ? dist : cam.smoothDist + (dist - cam.smoothDist) * (1 - Math.exp(-dt * 3));
      const D = cam.smoothDist;
      let cx = target.x + dx * D, cy = target.y + dy * D, cz = target.z + dz * D;
      cy = Math.max(cy, world.height(cx, cz) + 0.35);
      cam.shake *= Math.exp(-dt * 6);
      const sh = cam.shake * 0.18;
      camera.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz + (Math.random() - 0.5) * sh);
      camera.lookAt(target.x, target.y + 0.15, target.z);
      const kmh = Math.abs(fp.vehicle.speed) * 3.6;
      const fov = baseFov + clamp(kmh / 260, 0, 1) * 14;
      if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }

      // speedo shows the car you're watching
      const v = fp.vehicle;
      setText('speed', hud.speed, String(Math.round(kmh)));
      setText('gear', hud.gear, v.gear === -1 ? 'R' : String(v.gear));
      hud.rpmFill.style.width = clamp(v.rpm / 9000 * 100, 0, 100).toFixed(1) + '%';
      setText('rpm', hud.rpm, `${Math.round(v.rpm / 50) * 50} об/мин`);
      if (me && fp === me) updateDamageHud(me.vehicle, dt);
    } else if (window.__salkiCam) {               // local tests: a fixed view
      const c = window.__salkiCam; camera.position.set(...c.eye); camera.lookAt(...c.at);
      if (c.fov && camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
    } else {
      // menu: slow orbit over the arena
      const a = now / 1000 * 0.05;
      camera.position.set(Math.sin(a) * 120, 45, Math.cos(a) * 120);
      camera.lookAt(0, 0, 0);
    }

    {
      const pixelScale = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
      const floorY = fcv ? world.height(fcv.root.position.x, fcv.root.position.z) + 0.02 : 0.02;
      tickFlames(dt);
      fx.dust.update(dt, pixelScale); fx.smoke.update(dt, pixelScale); fx.sparks.update(dt, pixelScale, floorY); fx.fire.update(dt, pixelScale);
    }

    if (me && game.state !== 'menu' && !carsBuilding) { updateGameHud(); updateLabels(); }
    try { updateAudio(dt); } catch (e) { /* sound is optional */ }
    fpsFrames++; fpsTime += dt;
    if (fpsTime >= 0.5) { setText('fps', hud.fps, `${Math.round(fpsFrames / fpsTime)} FPS`); fpsFrames = 0; fpsTime = 0; }

    gfx.render();
  }
  requestAnimationFrame(frame);
}

// upgrader controls
$('bet').addEventListener('input', updateBet);
for (const b of document.querySelectorAll('#betQuick button')) {
  b.addEventListener('click', () => {
    if (!up.sel || !game) return;
    const max = game.maxBet(game.human, up.sel);
    $('bet').value = Math.max(1, Math.floor(max * Number(b.dataset.f)));
    updateBet();
  });
}
$('spinBtn').addEventListener('click', doSpin);
$('readyBtn').addEventListener('click', () => { if (game && game.human) { if (net.on) net.send({ t: 'ready' }); else game.setReady(game.human); $('readyBtn').disabled = true; $('readyBtn').textContent = 'Ждём остальных…'; } });

if (/_(test|real)\.html$/.test(location.pathname)) window.__salki = { buildCarVisual, disposeVisual, scene, camera, THREE, gfx, renderer, get game() { return game; } };   // local tests only
start().catch((e) => {
  console.error(e);
  if (window.showError) window.showError(e && (e.stack || e.message) || e);
});
