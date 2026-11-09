// gfx.js — the lighting that stands in for ray tracing.
//  * a light probe baked once from the middle of the arena: car paint and chrome reflect the stands and the gold,
//    and the sunlit walls bounce warm light onto everything (one bounce of global illumination, for free)
//  * true mirror reflections in the polished floor: the scene is drawn a second time from under the floor and the
//    floor shader uses it in place of the sky reflection, blurred by the floor's roughness (marble sharp, sand soft)
//  * MSAA, a soft bloom on the brightest highlights and the flames, and ambient occlusion (GTAO) on Ultra
// Anything that fails (old GPU, no float targets, a CDN hiccup) falls back to the plain renderer.

// layers: 0 everything, 1 the cars' full detail (main camera only), 2 their light stand-ins (sun shadow + floor mirror)
export const LAYER_FULL = 1, LAYER_PROXY = 2;

export const QUALITY = {
  ultra: { name: 'Ультра', pr: 2, refl: 0.6, msaa: 4, bloom: true, ao: true },
  high: { name: 'Высокая', pr: 1.5, refl: 0.45, msaa: 4, bloom: true, ao: false },
  normal: { name: 'Обычная', pr: 1, refl: 0, msaa: 0, bloom: false, ao: false },
};

export function createGfx(THREE, renderer, scene, camera, pmrem, { log = () => {} } = {}) {
  const st = { q: 'high', floor: null, composer: null, addons: null, loading: null, failed: false, rt: null, w: 1, h: 1 };
  // The sun's shadow is drawn once a frame from the layers of the stand-ins (not the full-detail cars): a render
  // into a 1×1 target through a camera that sees nothing (everything is culled) — only its shadow pass does work.
  let shadowView = null, shadowRT = null;
  try {
    shadowView = new THREE.PerspectiveCamera(1, 1, 1, 1.001);
    shadowView.position.set(0, -10000, 0); shadowView.lookAt(0, -20000, 0); shadowView.updateMatrixWorld();
    shadowView.layers.set(0); shadowView.layers.enable(LAYER_PROXY);
    shadowRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  } catch (_) { shadowView = null; }
  function shadowPass() {
    const sm = renderer.shadowMap;
    if (!shadowView || st.noShadowPass) { sm.autoUpdate = true; return; }
    const prev = renderer.getRenderTarget(), bg = scene.background;
    try {
      sm.autoUpdate = false; sm.needsUpdate = true;
      scene.background = null;
      renderer.setRenderTarget(shadowRT);
      renderer.render(scene, shadowView);
    } catch (e) { st.noShadowPass = true; sm.autoUpdate = true; log('shadow pass: ' + (e && e.message)); }
    scene.background = bg;
    renderer.setRenderTarget(prev);
    sm.needsUpdate = false;
  }
  const U = {
    tReflect: { value: null }, reflectMatrix: { value: null }, reflectOn: { value: 0 },
    reflectLod: { value: 4 }, reflectStrength: { value: 1 },
  };
  let canFloat = false, maxSamples = 0;
  try {
    const ext = renderer.extensions;
    canFloat = !!(ext && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')));
    maxSamples = (renderer.capabilities && renderer.capabilities.maxSamples) || 0;
    U.reflectMatrix.value = new THREE.Matrix4();
  } catch (_) { canFloat = false; }

  // ------------------------------------------------------------------ floor reflections
  const R = canFloat ? {
    vcam: new THREE.PerspectiveCamera(), normal: new THREE.Vector3(0, 1, 0), plane: new THREE.Plane(),
    planePos: new THREE.Vector3(), camPos: new THREE.Vector3(), rot: new THREE.Matrix4(), look: new THREE.Vector3(),
    view: new THREE.Vector3(), target: new THREE.Vector3(), clip: new THREE.Vector4(), q: new THREE.Vector4(),
  } : null;

  function attachFloor(mesh) {
    if (!mesh || !R) return;
    st.floor = mesh;
    const mat = mesh.material, prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 reflectMatrix;\nvarying vec4 vReflUv;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n  vReflUv = reflectMatrix * (modelMatrix * vec4(transformed, 1.0));');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nuniform float reflectOn, reflectLod, reflectStrength;\nvarying vec4 vReflUv;')
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  if (reflectOn > 0.5) {
    // what the floor mirrors, in place of the sky probe; the BRDF below still applies Fresnel and roughness
    vec2 ruv = vReflUv.xy / vReflUv.w;
    vec3 refl = textureLod(tReflect, ruv, clamp(material.roughness * reflectLod, 0.0, 7.0)).rgb;
    radiance = mix(radiance, refl, reflectStrength);
  }`);
    };
    mat.customProgramCacheKey = () => 'salki-floor-reflect';
    mat.needsUpdate = true;
  }

  function sizeReflection() {
    const q = QUALITY[st.q];
    if (!R || !st.floor || !q.refl) {
      // reflections off: the floor shader still has the sampler — give it a blank texel, not a freed target
      U.reflectOn.value = 0;
      if (!st.blank) { st.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); st.blank.needsUpdate = true; }
      U.tReflect.value = st.blank;
      if (st.rt) { st.rt.dispose(); st.rt = null; }
      return;
    }
    const pr = renderer.getPixelRatio(), w = Math.max(64, Math.round(st.w * pr * q.refl)), h = Math.max(64, Math.round(st.h * pr * q.refl));
    if (!st.rt) {
      st.rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      st.rt.texture.name = 'floorReflection';
    } else st.rt.setSize(w, h);
    U.tReflect.value = st.rt.texture;
    U.reflectOn.value = 1;
  }

  // the mirror camera (after three.js' Reflector: reflected eye, target and up, then an oblique near plane on the floor)
  function renderReflection() {
    const fl = st.floor, v = R.vcam;
    R.planePos.set(0, fl.position.y, 0);
    R.camPos.setFromMatrixPosition(camera.matrixWorld);
    R.view.subVectors(R.planePos, R.camPos);
    if (R.view.dot(R.normal) > 0) return false;           // under the floor: nothing to mirror
    R.view.set(R.camPos.x, 2 * R.planePos.y - R.camPos.y, R.camPos.z);
    R.rot.extractRotation(camera.matrixWorld);
    R.look.set(0, 0, -1).applyMatrix4(R.rot).add(R.camPos);
    R.target.set(R.look.x, 2 * R.planePos.y - R.look.y, R.look.z);
    v.position.copy(R.view);
    v.up.set(0, 1, 0).applyMatrix4(R.rot).reflect(R.normal);
    v.lookAt(R.target);
    v.far = camera.far; v.near = camera.near;
    v.layers.mask = (camera.layers.mask & ~(1 << LAYER_FULL)) | (1 << LAYER_PROXY);   // the stand-ins in the mirror
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);
    const tm = U.reflectMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);
    // oblique clipping: nothing under the floor gets into the mirror
    R.plane.setFromNormalAndCoplanarPoint(R.normal, R.planePos).applyMatrix4(v.matrixWorldInverse);
    R.clip.set(R.plane.normal.x, R.plane.normal.y, R.plane.normal.z, R.plane.constant);
    const P = v.projectionMatrix.elements;
    R.q.set((Math.sign(R.clip.x) + P[8]) / P[0], (Math.sign(R.clip.y) + P[9]) / P[5], -1, (1 + P[10]) / P[14]);
    R.clip.multiplyScalar(2 / R.clip.dot(R.q));
    P[2] = R.clip.x; P[6] = R.clip.y; P[10] = R.clip.z + 1 - 0.003; P[14] = R.clip.w;
    v.projectionMatrixInverse.copy(v.projectionMatrix).invert();
    fl.visible = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(st.rt);
    renderer.clear();
    renderer.render(scene, v);
    renderer.setRenderTarget(prev);
    fl.visible = true;
    return true;
  }

  // ------------------------------------------------------------------ post-processing
  async function loadAddons() {
    if (st.addons) return st.addons;
    if (!st.loading) {
      st.loading = Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/postprocessing/GTAOPass.js'),
      ]).then(([a, b, c, d, e]) => (st.addons = { ...a, ...b, ...c, ...d, ...e }));
    }
    return st.loading;
  }

  function disposeComposer() {
    const c = st.composer;
    st.composer = null;
    if (!c) return;
    try { for (const p of c.passes) if (p.dispose) p.dispose(); c.dispose && c.dispose(); } catch (_) { /* ignore */ }
  }

  function buildComposer() {
    disposeComposer();
    const q = QUALITY[st.q], A = st.addons;
    if (!A || !canFloat || (!q.msaa && !q.bloom && !q.ao)) return;
    const pr = renderer.getPixelRatio(), W = Math.round(st.w * pr), H = Math.round(st.h * pr);
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: Math.min(q.msaa, maxSamples) });
    const c = new A.EffectComposer(renderer, rt);
    c.setPixelRatio(pr);
    c.setSize(st.w, st.h);
    c.addPass(new A.RenderPass(scene, camera));
    if (q.ao) {
      const ao = new A.GTAOPass(scene, camera, W, H);
      ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.6, thickness: 1.2, scale: 1, samples: 12 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      ao.blendIntensity = 0.7;
      c.addPass(ao);
    }
    if (q.bloom) c.addPass(new A.UnrealBloomPass(new THREE.Vector2(st.w, st.h), 0.16, 0.35, 1.05));
    c.addPass(new A.OutputPass());
    st.composer = c;
  }

  // ------------------------------------------------------------------ public
  function setQuality(name) {
    if (!QUALITY[name]) name = 'high';
    st.q = name;
    const q = QUALITY[name];
    try {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr));
      renderer.setSize(st.w, st.h);
      sizeReflection();
      disposeComposer();
      if (canFloat && (q.msaa || q.bloom || q.ao)) {
        loadAddons().then(() => { if (st.q === name && !st.failed) buildComposer(); })
          .catch((e) => log('postprocessing unavailable: ' + (e && e.message)));
      }
    } catch (e) { fail(e); }
  }

  function setSize(w, h) {
    st.w = w; st.h = h;
    try {
      renderer.setSize(w, h);
      sizeReflection();
      if (st.composer) st.composer.setSize(w, h);
    } catch (e) { fail(e); }
  }

  function fail(e) {
    if (st.failed) return;
    st.failed = true;
    log('graphics fell back to plain rendering: ' + (e && e.message));
    try { disposeComposer(); } catch (_) { /* ignore */ }
    U.reflectOn.value = 0;
    if (st.floor) st.floor.visible = true;
    try { renderer.setRenderTarget(null); } catch (_) { /* ignore */ }
  }

  function render() {
    shadowPass();
    if (st.failed) { renderer.render(scene, camera); return; }
    try {
      if (st.rt && U.reflectOn.value && st.floor) renderReflection();
      if (st.composer) st.composer.render();
      else renderer.render(scene, camera);
    } catch (e) { fail(e); renderer.render(scene, camera); }
  }

  // the light probe: six views from the middle of the arena, prefiltered for every roughness
  function bakeProbe(at = [0, 2.5, 0], hide = []) {
    try {
      const rt = new THREE.WebGLCubeRenderTarget(256, { type: canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType });
      const cc = new THREE.CubeCamera(0.3, 2000, rt);
      cc.position.set(at[0], at[1], at[2]);
      cc.updateMatrixWorld(true);
      const was = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const on = U.reflectOn.value;
      U.reflectOn.value = 0;
      renderer.shadowMap.autoUpdate = true;
      cc.update(renderer, scene);
      U.reflectOn.value = on;
      hide.forEach((o, i) => (o.visible = was[i]));
      const env = pmrem.fromCubemap(rt.texture).texture;
      rt.dispose();
      return env;
    } catch (e) { log('probe failed: ' + (e && e.message)); return null; }
  }

  return { setQuality, setSize, render, attachFloor, bakeProbe, get quality() { return st.q; }, get failed() { return st.failed; }, uniforms: U, state: st };
}
