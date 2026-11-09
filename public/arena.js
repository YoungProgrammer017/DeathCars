// arena.js — "Колизей": the arena, built in code. A marble floor with gold inlays and a red runway, lightly
// dusted with sand (looks only — the cars drive on a flat floor), the podium wall with a carved frieze, two tiers
// of stone seats, a two-storey arcade, giant columns with red banners, a monumental gate, statues, braziers and
// flags, all under a golden-hour sky. Everything is generated at load time: no model to download.
import { Geo } from './arena_geo.js';
import * as TX from './arena_tex.js';

export const ARENA_R = 104;                 // the wall (physics: ArenaWorld(ARENA_R))
export const SUN_DIR = (() => { const v = [-0.42, 0.62, 0.66]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

// golden hour: a warm low sun, a soft fill from the sky
export const LIGHT = { sun: 0xffd2a0, sunIntensity: 3.6, hemiSky: 0xa9c2e6, hemiGround: 0x8a6e52, hemiIntensity: 0.45, envIntensity: 0.5, probeIntensity: 0.7, fog: 0xe8d2ae, exposure: 1.0 };
const GATE_TH = 0;                          // the gate faces the arena from +z
const GATE_HALF = 18.2 / ARENA_R;           // angle the gate takes out of the podium wall (each side)
const TAU = Math.PI * 2;
// let the page breathe between the heavy steps (a message, not a timer: timers are throttled in background tabs)
const yieldUI = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

function tex(THREE, canvas, { repeat = 1, srgb = true, flipY = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (t.repeat && t.repeat.set) t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = flipY;
  t.anisotropy = aniso;
  return t;
}

// the floor shader gets a fine detail texture tiled over the big painted one (close-up marble veins, sand grain)
function addDetail(mat, detail, repeat) {
  (mat.userData = mat.userData || {}).detail = { map: detail, repeat };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.uniforms.detailRepeat = { value: repeat };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform float detailRepeat;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= texture2D(detailMap, vMapUv * detailRepeat).rgb * 2.0;');
  };
}

export async function buildArena(THREE, { progress = () => {}, log = null } = {}) {
  const t0 = performance.now(), mark = (s) => log && log(s + ' ' + Math.round(performance.now() - t0) + ' ms');
  const group = new THREE.Group();
  group.name = 'arena';
  const S = TX.FLOOR_S;

  // ---------------------------------------------------------------- textures
  const T = {};
  T.floor = tex(THREE, TX.paintFloor(4096, 'color'), { flipY: false, aniso: 16 }); progress(0.25); await yieldUI();
  T.floorOrm = tex(THREE, TX.paintFloor(1024, 'orm'), { flipY: false, srgb: false }); await yieldUI();
  T.detail = tex(THREE, TX.paintFloorDetail(512), { srgb: false }); progress(0.35); await yieldUI();
  T.stone = tex(THREE, TX.paintStone(1024)); progress(0.5); await yieldUI();
  T.marble = tex(THREE, TX.paintMarble(512)); await yieldUI();
  const rel = TX.paintRelief(2048, 512);
  T.relief = tex(THREE, rel.color); T.reliefN = tex(THREE, rel.normal, { srgb: false }); progress(0.65); await yieldUI();
  T.flutes = tex(THREE, TX.paintFlutes(), { srgb: false });
  T.banner = tex(THREE, TX.paintBanner()); T.banner.wrapS = T.banner.wrapT = THREE.ClampToEdgeWrapping;
  T.flag = tex(THREE, TX.paintFlag()); T.flag.wrapS = T.flag.wrapT = THREE.ClampToEdgeWrapping;
  const skyCanvas = TX.paintSky(2048, 1024, SUN_DIR); progress(0.85); await yieldUI();

  mark('materials');
  // ---------------------------------------------------------------- materials
  const M = {
    floor: new THREE.MeshStandardMaterial({ map: T.floor, roughnessMap: T.floorOrm, metalnessMap: T.floorOrm, roughness: 1, metalness: 1 }),
    stone: new THREE.MeshStandardMaterial({ map: T.stone, roughness: 0.88, metalness: 0 }),
    seats: new THREE.MeshStandardMaterial({ map: T.stone, color: 0xe6d8c2, roughness: 0.9, metalness: 0 }),
    aisle: new THREE.MeshStandardMaterial({ map: T.stone, color: 0x9c8b74, roughness: 0.9, metalness: 0 }),
    marble: new THREE.MeshStandardMaterial({ map: T.marble, roughness: 0.32, metalness: 0 }),
    fluted: new THREE.MeshStandardMaterial({ map: T.marble, normalMap: T.flutes, roughness: 0.3, metalness: 0 }),
    darkMarble: new THREE.MeshStandardMaterial({ map: T.marble, color: 0x5d5752, roughness: 0.3, metalness: 0 }),
    relief: new THREE.MeshStandardMaterial({ map: T.relief, normalMap: T.reliefN, roughness: 0.8, metalness: 0 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe0ac4e, roughness: 0.36, metalness: 0.75 }),
    bronze: new THREE.MeshStandardMaterial({ color: 0x9a7448, roughness: 0.42, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 1, metalness: 0 }),
    banner: new THREE.MeshStandardMaterial({ map: T.banner, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 }),
    flag: new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 }),
  };
  addDetail(M.floor, T.detail, 2 * S / 2.2);


  const G = {};                       // material key -> Geo
  const geo = (k) => G[k] || (G[k] = new Geo());

  // ---------------------------------------------------------------- floor
  geo('floor').disc(0, ARENA_R + 0.6, 256, 26, 0, (x, z) => [(x + S) / (2 * S), (z + S) / (2 * S)]);

  // ---------------------------------------------------------------- podium wall (gap for the gate)
  const pa0 = GATE_TH + GATE_HALF, pa1 = GATE_TH + TAU - GATE_HALF, PSEG = 240;
  const R = ARENA_R, PH = 5.2;                                      // podium height
  geo('darkMarble').lathe([[R - 0.12, 0], [R - 0.12, 0.6], [R, 0.72]], PSEG, pa0, pa1, { uScale: 3, vScale: 3 });
  geo('relief').lathe([[R, 0.72], [R, 4.22]], PSEG, pa0, pa1, { uScale: 14, vScale: 3.5 });
  geo('gold').lathe([[R, 4.22], [R - 0.09, 4.3], [R - 0.09, 4.38], [R, 4.44]], PSEG, pa0, pa1);
  geo('marble').lathe([[R, 4.44], [R - 0.15, 4.58], [R - 0.15, 5.1], [R - 0.05, PH]], PSEG, pa0, pa1, { uScale: 3, vScale: 3 });
  geo('gold').lathe([[R - 0.05, PH], [R - 0.05, PH + 0.06], [R + 0.2, PH + 0.06]], PSEG, pa0, pa1);
  geo('stone').lathe([[R + 0.2, PH + 0.06], [R + 2.6, PH + 0.06]], PSEG, pa0, pa1, { uScale: 4, vScale: 4 });
  geo('marble').lathe([[R + 2.6, PH + 0.06], [R + 2.6, PH + 1.1], [R + 2.95, PH + 1.1], [R + 2.95, PH + 0.06]], PSEG, pa0, pa1, { uScale: 3, vScale: 3 });
  geo('gold').lathe([[R + 2.56, PH + 1.1], [R + 2.56, PH + 1.2], [R + 2.99, PH + 1.2], [R + 2.99, PH + 1.1]], PSEG, pa0, pa1);

  // ---------------------------------------------------------------- seating: two steep tiers of steps
  const prof = [];
  let r = R + 2.95, y = PH + 0.06;
  prof.push([r, y]);
  const steps = (n, rise, tread) => { for (let k = 0; k < n; k++) { y += rise; prof.push([r, y]); r += tread; prof.push([r, y]); } };
  steps(15, 0.55, 0.78);
  r += 1.2; prof.push([r, y]);                    // walkway
  y += 2.6; prof.push([r, y]);                    // balteus wall
  const balteusY = y, balteusR = r;
  r += 0.6; prof.push([r, y]);
  steps(15, 0.55, 0.78);
  r += 1.4; prof.push([r, y]);
  const topR = r, topY = y;
  const SSEG = 300;
  geo('seats').lathe(prof, SSEG, 0, TAU, { uScale: 4, vScale: 4 });
  for (let k = 0; k < 36; k++) {                  // darker stairways every 10°
    const a = (k + 0.5) / 36 * TAU;
    const lifted = prof.map(([pr, py]) => [pr, py + 0.02]);
    geo('aisle').lathe(lifted, 1, a - 0.6 / (R + 15), a + 0.6 / (R + 15), { uScale: 4, vScale: 4 });
  }
  geo('gold').lathe([[balteusR - 0.02, balteusY], [balteusR - 0.02, balteusY + 0.12], [balteusR + 0.3, balteusY + 0.12]], SSEG, 0, TAU);
  geo('marble').lathe([[balteusR - 0.6 - 0.02, balteusY - 2.6], [balteusR - 0.6 - 0.02, balteusY - 2.2]], SSEG, 0, TAU, { uScale: 3, vScale: 3 });

  // ---------------------------------------------------------------- the arcade: three storeys of arches
  const AR = topR + 0.1, BAYS = 120, dth = TAU / BAYS, w = 2 * AR * Math.sin(dth / 2) + 0.02;
  const LV = [{ h: 9.0, a: 2.3, ys: 4.9 }, { h: 8.4, a: 2.2, ys: 4.4 }, { h: 7.4, a: 2.0, ys: 3.7 }];
  const col = (h, r0) => {
    const g = new Geo();
    g.cylinder(0, 0, 0, r0 + 0.12, r0 + 0.12, 0.3, 14, true, 1);
    g.cylinder(0, 0.3, 0, r0, r0 - 0.06, h - 0.3, 14, false, 3, 6);
    return g;
  };
  const cap = (r0) => new Geo().cylinder(0, 0, 0, r0 - 0.08, r0 + 0.14, 0.45, 14, true, 1).box(0, 0.5, 0, 2 * r0 + 0.4, 0.12, 2 * r0 + 0.4);
  let ly = topY;
  for (const L of LV) {
    L.y = ly;
    const bay = new Geo().archBay(w, L.h, 1.6, L.a, L.ys, 12, 4);
    const cH = L.h - 1.05, c = col(cH, 0.42), cp = cap(0.42);
    for (let k = 0; k < BAYS; k++) {
      geo('stone').addPolar(bay, (k + 0.5) * dth, AR, L.y);
      geo('fluted').addPolar(c, k * dth, AR - 0.32, L.y);
      geo('gold').addPolar(cp, k * dth, AR - 0.32, L.y + cH);
    }
    // cornice between storeys, gold band
    geo('marble').lathe([[AR - 0.05, L.y + L.h], [AR - 0.5, L.y + L.h + 0.15], [AR - 0.5, L.y + L.h + 0.75], [AR - 0.1, L.y + L.h + 0.9]], 240, 0, TAU, { uScale: 3, vScale: 3 });
    geo('gold').lathe([[AR - 0.52, L.y + L.h + 0.36], [AR - 0.52, L.y + L.h + 0.5]], 240, 0, TAU);
    // dark gallery behind
    geo('dark').lathe([[AR + 1.6, L.y + 0.05], [AR + 4.5, L.y + 0.05]], 180, 0, TAU);
    ly = L.y + L.h + 0.9;
  }
  geo('dark').lathe([[AR + 4.5, topY], [AR + 4.5, ly]], 180, 0, TAU);
  const atY = ly;
  geo('marble').lathe([[AR - 0.1, atY], [AR - 0.2, atY], [AR - 0.2, atY + 3.4], [AR - 0.7, atY + 3.6], [AR - 0.7, atY + 4.0], [AR + 4.5, atY + 4.0]], 240, 0, TAU, { uScale: 3, vScale: 3 });
  geo('gold').lathe([[AR - 0.72, atY + 3.7], [AR - 0.72, atY + 3.84]], 240, 0, TAU);
  const win = new Geo().box(0, 0, 0, 1.2, 1.4, 0.05);
  for (let k = 0; k < BAYS; k++) geo('dark').addPolar(win, (k + 0.5) * dth, AR - 0.24, atY + 1.8);
  // flags on the top
  const pole = new Geo().cylinder(0, 0, 0, 0.07, 0.05, 5, 6, true);
  const flag = new Geo();
  {
    const n = 8, FL = 3.2, FH = 1.6;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = t * FL, z = Math.sin(t * Math.PI * 1.6) * 0.3 * t;
      flag.vert(x, 3.3, z, 0, 0, 1, t, 0); flag.vert(x, 3.3 + FH, z, 0, 0, 1, t, 1);
    }
    for (let i = 0; i < n; i++) { const q = i * 2; flag.quad(q, q + 2, q + 3, q + 1, 0, 0, 1); }
  }
  for (let k = 0; k < 60; k++) {
    const th = (k + 0.25) / 60 * TAU;
    geo('gold').addPolar(pole, th, AR + 0.6, atY + 4.0);
    geo('flag').addPolar(flag, th, AR + 0.6, atY + 4.0);
  }

  // ---------------------------------------------------------------- giant columns with banners between them
  const GC = 16, gcR = balteusR + 4.2, pedH = 4.0, shaftH = 31, gR = 1.55;
  const giantPed = new Geo().box(0, pedH / 2, 0, 4.6, pedH, 4.6, 3).box(0, pedH + 0.15, 0, 5.0, 0.3, 5.0, 3);
  const giantShaft = new Geo().cylinder(0, pedH + 1.1, 0, gR, gR * 0.88, shaftH, 28, false, 4, 24);
  const giantGold = new Geo();
  giantGold.lathe([[gR + 0.45, pedH + 0.3], [gR + 0.45, pedH + 0.65], [gR + 0.2, pedH + 0.9], [gR + 0.2, pedH + 1.1], [0, pedH + 1.1]], 28, 0, TAU, { smooth: true, flip: true });
  const ct = pedH + 1.1 + shaftH;
  giantGold.lathe([[gR * 0.88, ct], [gR * 1.05, ct + 0.8], [gR * 1.45, ct + 2.2], [gR * 1.65, ct + 2.8]], 28, 0, TAU, { smooth: true, flip: true });
  giantGold.box(0, ct + 3.1, 0, gR * 3.8, 0.6, gR * 3.8);
  const giantY = balteusY;
  const bannerG = new Geo();
  const BW = 5.8, BH = 21;
  {
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = (t - 0.5) * BW, z = Math.sin(t * Math.PI * 4) * 0.15;
      bannerG.vert(x, -BH, z, 0, 0, -1, 1 - t, 0); bannerG.vert(x, 0, z, 0, 0, -1, 1 - t, 1);   // seen from the arena
    }
    for (let i = 0; i < n; i++) { const q = i * 2; bannerG.quad(q, q + 2, q + 3, q + 1, 0, 0, -1); }
  }
  const rod = new Geo().box(0, 0.12, 0, BW + 0.8, 0.22, 0.22).cylinder(-(BW + 0.8) / 2, 0.0, 0, 0.18, 0.18, 0.24, 8, true).cylinder((BW + 0.8) / 2, 0.0, 0, 0.18, 0.18, 0.24, 8, true);
  for (let k = 0; k < GC; k++) {
    const th = (k + 0.5) / GC * TAU;
    if (Math.abs(Math.atan2(Math.sin(th - GATE_TH), Math.cos(th - GATE_TH))) < 0.25) continue;
    geo('marble').addPolar(giantPed, th, gcR, giantY);
    geo('fluted').addPolar(giantShaft, th, gcR, giantY);
    geo('gold').addPolar(giantGold, th, gcR, giantY);
  }
  for (let k = 0; k < GC; k++) {
    const mid = Math.round((k + 1) / GC * BAYS);      // banners between the columns, each over an arch
    for (const off of [-3, 2]) {
      const t2 = (mid + off + 0.5) * dth;
      if (Math.abs(Math.atan2(Math.sin(t2 - GATE_TH), Math.cos(t2 - GATE_TH))) < 0.12) continue;
      geo('banner').addPolar(bannerG, t2, AR - 0.6, atY - 0.4);
      geo('gold').addPolar(rod, t2, AR - 0.6, atY - 0.35);
    }
  }

  // ---------------------------------------------------------------- statues and braziers on the podium
  const statue = makeStatue();
  const plinth = new Geo().box(0, 0.65, 0, 1.9, 1.3, 1.9, 2).box(0, 1.35, 0, 2.15, 0.12, 2.15, 2).box(0, 0.06, 0, 2.15, 0.12, 2.15, 2);
  const flames = [];
  const brazier = makeBrazier();
  for (let k = 0; k < 24; k++) {
    const th = k / 24 * TAU;
    const off = Math.abs(Math.atan2(Math.sin(th - GATE_TH), Math.cos(th - GATE_TH)));
    if (off < GATE_HALF + 0.05) continue;
    if (k % 2 === 0) {
      geo('marble').addPolar(plinth, th, R + 1.4, PH + 0.06);
      geo('bronze').addPolar(statue, th, R + 1.4, PH + 1.47, 1.75);
    } else {
      geo('bronze').addPolar(brazier, th, R + 1.3, PH + 0.06, 1.5);
      flames.push([Math.sin(th) * (R + 1.3), PH + 0.06 + 1.85 * 1.5, Math.cos(th) * (R + 1.3)]);
    }
  }

  mark('the gate');
  // ---------------------------------------------------------------- the gate
  buildGate(geo, statue, plinth, brazier, flames);

  mark('meshes');
  // ---------------------------------------------------------------- meshes
  const order = ['floor', 'relief', 'darkMarble', 'stone', 'seats', 'aisle', 'marble', 'fluted', 'gold', 'bronze', 'dark', 'banner', 'flag'];
  for (const k of order) {
    if (!G[k]) continue;
    const mesh = new THREE.Mesh(G[k].build(THREE), M[k]);
    mesh.name = 'arena_' + k;
    mesh.receiveShadow = true;
    mesh.castShadow = k !== 'floor';
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  mark('done');
  progress(1);
  return { group, flames, sky: skyCanvas, sunDir: SUN_DIR, light: LIGHT };
}

// a Roman soldier with spear and round shield, ~3 m tall, facing −z (local), feet at y = 0
function makeStatue() {
  const g = new Geo();
  const out = { smooth: true, flip: true };
  // legs
  g.cylinder(-0.13, 0, 0, 0.1, 0.13, 0.95, 10, true);
  g.cylinder(0.13, 0, 0.05, 0.1, 0.13, 0.95, 10, true);
  // tunic skirt + torso + shoulders (one lathe), its bottom
  g.lathe([[0.36, 0.85], [0.3, 1.2], [0.24, 1.35], [0.3, 1.65], [0.34, 1.85], [0.2, 1.98], [0.0, 2.0]], 14, 0, Math.PI * 2, out);
  g.lathe([[0.0, 0.84], [0.36, 0.85]], 14, 0, Math.PI * 2, { flip: true });
  // neck, head with a crested helmet
  g.cylinder(0, 1.95, 0, 0.08, 0.08, 0.15, 8, false);
  g.lathe([[0.0, 2.08], [0.12, 2.1], [0.15, 2.22], [0.14, 2.34], [0.08, 2.42], [0.0, 2.44]], 12, 0, Math.PI * 2, out);
  g.box(0, 2.5, 0.02, 0.05, 0.16, 0.42);
  // arms, spear in the right hand, round shield on the left
  const arm = new Geo().cylinder(0, 0, 0, 0.06, 0.075, 0.72, 8, true);
  g.add(arm, 0.36, 1.25, -0.05);
  g.add(arm, -0.36, 1.25, -0.15);
  g.add(new Geo().cylinder(0, 0, 0, 0.03, 0.03, 3.2, 6, true), 0.42, 0.3, -0.12);
  g.add(new Geo().cylinder(0, 0, 0, 0.07, 0.0, 0.3, 6, true), 0.42, 3.5, -0.12);
  const sh = new Geo().lathe([[0, 0.05], [0.42, 0.0], [0.5, -0.02], [0.5, -0.06], [0.0, -0.04]], 18, 0, Math.PI * 2, { smooth: true });
  for (let i = 0; i < sh.p.length; i += 3) { const yy = sh.p[i + 1], zz = sh.p[i + 2]; sh.p[i + 1] = zz; sh.p[i + 2] = -yy; const ny = sh.n[i + 1], nz = sh.n[i + 2]; sh.n[i + 1] = nz; sh.n[i + 2] = -ny; }
  g.add(sh, -0.38, 1.3, -0.38);
  g.box(0, 1.35, 0.3, 0.62, 1.1, 0.06);            // cape
  return g;
}

function makeBrazier() {
  const g = new Geo();
  g.cylinder(0, 0, 0, 0.42, 0.42, 0.18, 12, true);
  g.cylinder(0, 0.18, 0, 0.16, 0.12, 1.2, 12, false);
  g.lathe([[0.12, 1.36], [0.3, 1.45], [0.62, 1.78], [0.7, 1.86], [0.66, 1.9]], 16, 0, Math.PI * 2, { smooth: true, flip: true });
  g.lathe([[0.0, 1.6], [0.6, 1.82]], 16, 0, Math.PI * 2);
  return g;
}

function buildGate(geo, statue, plinth, brazier, flames) {
  const R = ARENA_R, F = R + 1.25;             // facade plane; its half-columns come forward to the wall line
  const W = 36, H = 30, D = 9, a = 6, ys = 11;
  geo('marble').addPolar(new Geo().archBay(W, H, D, a, ys, 20, 5), GATE_TH, F);
  // gold archivolt round the opening
  geo('gold').addPolar(rotZPieces(a + 0.35, ys, 24), GATE_TH, F);
  for (const s of [-1, 1]) geo('gold').addPolar(new Geo().box(0, ys / 2, -0.12, 0.7, ys, 0.3), GATE_TH, F, 0, 1, [s * (a + 0.35), 0]);
  // the dark passage behind and the golden portcullis
  // (shallow: deeper in, the lower stands run through the passage and showed — and flickered — inside it)
  const PD = 1.15;
  const pass = new Geo().box(0, 9, PD + 0.5, 2 * a + 0.6, 18, 1, 1, ['nz']).box(-a - 0.25, 9, PD / 2, 0.2, 18, PD, 1, ['px']).box(a + 0.25, 9, PD / 2, 0.2, 18, PD, 1, ['nx']);
  geo('dark').addPolar(pass, GATE_TH, F);
  const bars = new Geo();
  for (let x = -a + 0.4; x < a - 0.3; x += 0.75) {
    const top = ys + Math.sqrt(Math.max(a * a - x * x, 0)) - 0.15;
    bars.box(x, top / 2, 0.6, 0.16, top, 0.16);
  }
  for (let yy = 1.2; yy < ys + a - 0.8; yy += 1.4) {
    const half = yy <= ys ? a - 0.05 : Math.sqrt(Math.max(a * a - (yy - ys) ** 2, 0)) - 0.05;
    if (half > 0.3) bars.box(0, yy, 0.66, 2 * half, 0.14, 0.12);
  }
  geo('gold').addPolar(bars, GATE_TH, F);
  // close off the ends of the podium wall either side
  const capB = new Geo().box(0, 2.6, 1.3, 0.6, 5.2, 3.0, 3);
  for (const s of [-1, 1]) geo('marble').addPolar(capB, GATE_TH + s * GATE_HALF, R);
  // four big half-columns
  const cR = 1.0, cH = 21;
  const gcol = new Geo().cylinder(0, 0.9, 0, cR, cR * 0.9, cH - 2.6, 24, false, 4, 20);
  const gbase = new Geo().box(0, 0.35, 0, 2.8, 0.7, 2.8).lathe([[cR + 0.35, 0.7], [cR + 0.35, 0.82], [cR + 0.1, 0.9], [0, 0.9]], 24, 0, TAU, { smooth: true, flip: true });
  const gcap = new Geo().lathe([[cR * 0.9, cH - 1.7], [cR * 1.1, cH - 1.1], [cR * 1.5, cH - 0.3], [cR * 1.6, cH]], 24, 0, TAU, { smooth: true, flip: true }).box(0, cH + 0.25, 0, 3.6, 0.5, 3.6);
  for (const x of [-14.6, -8.4, 8.4, 14.6]) {
    geo('fluted').addPolar(gcol, GATE_TH, F - 0.3, 0, 1, [x, 0]);
    geo('gold').addPolar(gbase, GATE_TH, F - 0.3, 0, 1, [x, 0]);
    geo('gold').addPolar(gcap, GATE_TH, F - 0.3, 0, 1, [x, 0]);
  }
  // entablature with a gold frieze, attic, pediment with a golden laurel disc
  const ent = new Geo().box(0, cH + 1.4, -1.0, W + 1.6, 2.2, 2.4, 3).box(0, cH + 2.9, -1.2, W + 2.4, 0.8, 2.8, 3);
  geo('marble').addPolar(ent, GATE_TH, F);
  geo('gold').addPolar(new Geo().box(0, cH + 1.3, -2.22, W + 1.4, 0.6, 0.06), GATE_TH, F);
  const PW = 26, PB = H, PHh = 7.5;
  const ped = new Geo();
  {
    const half = PW / 2, z0 = -0.6, z1 = 3.0;
    for (const [z, nz] of [[z0, -1], [z1, 1]]) {
      const a1 = ped.vert(-half, PB, z, 0, 0, nz, 0, 0), a2 = ped.vert(half, PB, z, 0, 0, nz, 2, 0), a3 = ped.vert(0, PB + PHh, z, 0, 0, nz, 1, 1);
      ped.tri(a1, a2, a3, 0, 0, nz);
    }
    const sl = Math.hypot(half, PHh), nx = PHh / sl, ny = half / sl;
    ped.face([[-half, PB, z0], [0, PB + PHh, z0], [0, PB + PHh, z1], [-half, PB, z1]], [-nx, ny, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    ped.face([[half, PB, z1], [0, PB + PHh, z1], [0, PB + PHh, z0], [half, PB, z0]], [nx, ny, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    ped.box(0, PB - 0.3, 1.2, PW + 1.2, 0.6, 4.2, 3);
  }
  geo('marble').addPolar(ped, GATE_TH, F);
  const disc = new Geo().lathe([[0, 0.15], [2.1, 0.08], [2.25, 0], [0, 0]], 28, 0, TAU, { smooth: true });
  for (let i = 0; i < disc.p.length; i += 3) { const yy = disc.p[i + 1], zz = disc.p[i + 2]; disc.p[i + 1] = zz; disc.p[i + 2] = -yy; const ny = disc.n[i + 1], nz = disc.n[i + 2]; disc.n[i + 1] = nz; disc.n[i + 2] = -ny; }
  geo('gold').addPolar(disc, GATE_TH, F - 0.65, PB + 2.9);
  // statues on the attic corners and on tall pedestals either side, big braziers by the gate
  for (const s of [-1, 1]) {
    geo('bronze').addPolar(statue, GATE_TH, F - 0.3, H, 2.3, [s * 15.8, 0]);
    const ped2 = new Geo().box(0, 3.5, 0, 3.0, 7, 3.0, 3).box(0, 7.15, 0, 3.4, 0.3, 3.4, 3);
    geo('marble').addPolar(ped2, GATE_TH, R + 1.8, 0, 1, [s * 22.5, 0]);
    geo('bronze').addPolar(statue, GATE_TH, R + 1.8, 7.3, 2.2, [s * 22.5, 0]);
    const bx = s * 19.6, br = R + 1.3;
    geo('bronze').addPolar(brazier, GATE_TH, br, 5.26, 2.0, [bx, 0]);
    flames.push([Math.sin(GATE_TH) * br + Math.cos(GATE_TH) * bx, 5.26 + 1.85 * 2.0, Math.cos(GATE_TH) * br - Math.sin(GATE_TH) * bx]);
  }
}

// gold voussoirs following an arch of radius rr springing at ys (local, facing −z)
function rotZPieces(rr, ys, n) {
  const g = new Geo();
  for (let k = 0; k < n; k++) {
    const f0 = Math.PI * k / n, f1 = Math.PI * (k + 1) / n, fm = (f0 + f1) / 2;
    const len = (f1 - f0) * rr + 0.04, c = Math.cos(fm), s = Math.sin(fm);
    // a small box whose long side is tangent to the arch: build its corners directly
    const t = [-s, c], nrm = [c, s], hw = 0.35, hl = len / 2, d0 = -0.27, d1 = 0.03;
    const cx = c * rr, cy = ys + s * rr;
    const P = (u, v, z) => [cx + t[0] * u + nrm[0] * v, cy + t[1] * u + nrm[1] * v, z];
    const corners = (z) => [P(-hl, -hw, z), P(hl, -hw, z), P(hl, hw, z), P(-hl, hw, z)];
    const f = corners(d0), b = corners(d1);
    g.face(f, [0, 0, -1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    g.face([b[3], b[2], f[2], f[3]], [nrm[0], nrm[1], 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    g.face([f[1], f[0], b[0], b[1]], [-nrm[0], -nrm[1], 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  return g;
}
