/* Morph Studio — 3D avatar module.
   Shows either a realistic 3D model of the patient (a GLB produced by an image-to-3D
   service or a phone scan) or, as a fallback, a generic head textured with the patient's
   photos. The surgeon can rotate it freely and sculpt it. Exposes window.Avatar3D. */
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { mergeVertices } from './vendor/three/BufferGeometryUtils.js';

const SEG_U = 192, SEG_V = 128, COLS = SEG_U + 1, NV = COLS * (SEG_V + 1);
const TEX = 2048;
const R = { x: 0.72, y: 0.98, z: 0.82 };
const HEAD_V = 0.8;
const DISP_Q = 16000;
const HISTORY_LIMIT = 40;
const MODEL_HEIGHT = 2.3;           // loaded models are scaled to this height (head units)
const GUIDES = [['Brow', 0.24], ['Eyes', 0.09], ['Nose tip', -0.14], ['Mouth', -0.44], ['Chin', -0.86]];
const PRESETS = { front: 0, rightQ: -40, right: -90, leftQ: 40, left: 90 };
const DEFAULT_SKIN = [214, 172, 152];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ───────────── Generic head shape ───────────── */
function headPoint(u, v, out) {
  const theta = (u - 0.5) * Math.PI * 2;
  let x, y, z;
  if (v <= HEAD_V) {
    const phi = (v / HEAD_V) * Math.PI * 0.86, sp = Math.sin(phi);
    x = sp * Math.sin(theta) * R.x; y = Math.cos(phi) * R.y; z = sp * Math.cos(theta) * R.z;
  } else {
    const t = (v - HEAD_V) / (1 - HEAD_V), phi = Math.PI * 0.86, sp = Math.sin(phi);
    const flare = 1 + 0.5 * smooth(0.5, 1, t);
    x = Math.sin(theta) * sp * R.x * flare;
    z = Math.cos(theta) * sp * R.z * flare - 0.08 * t;
    y = Math.cos(phi) * R.y - t * 0.7;
  }
  const facing = Math.max(0, z / R.z);
  if (facing > 0 && v <= HEAD_V) {
    const ax = Math.abs(x);
    const bridge = 0.09 * gauss(x, 0.05) * smooth(-0.18, -0.02, y) * smooth(0.34, 0.14, y);
    const tip = 0.2 * gauss(x, 0.055) * gauss(y + 0.14, 0.07);
    const alae = 0.09 * gauss(ax - 0.085, 0.035) * gauss(y + 0.18, 0.035);
    let dz = Math.max(bridge, tip, alae);
    dz += 0.035 * gauss(y - 0.24, 0.05) * smooth(0.55, 0.15, ax);
    dz -= 0.045 * gauss(ax - 0.26, 0.09) * gauss(y - 0.09, 0.055);
    dz += 0.03 * gauss(ax - 0.42, 0.1) * gauss(y + 0.02, 0.09);
    dz += 0.03 * gauss(y + 0.44, 0.045) * smooth(0.28, 0.1, ax);
    dz += 0.07 * gauss(x, 0.14) * gauss(y + 0.82, 0.09);
    z += dz * facing;
  }
  out.set(x, y, z);
}
function buildGenericGeometry() {
  const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), p = new THREE.Vector3();
  for (let j = 0; j <= SEG_V; j++) for (let i = 0; i <= SEG_U; i++) {
    const k = j * COLS + i;
    headPoint(i / SEG_U, j / SEG_V, p);
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    uv[k * 2] = i / SEG_U; uv[k * 2 + 1] = 1 - j / SEG_V;
  }
  const idx = new Uint32Array(SEG_U * SEG_V * 6); let n = 0;
  for (let j = 0; j < SEG_V; j++) for (let i = 0; i < SEG_U; i++) {
    const a = j * COLS + i, b = a + 1, c = a + COLS, d = c + 1;
    idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/* ───────────── Module state ───────────── */
const A = {
  ready: false, available: false, error: '',
  tool: 'orbit', brush: 0.18, strength: 0.5, symmetry: true,
  compare: 'after', showBefore: false, morph: 1, autoRotate: false,
  photos: { front: null, right: null, left: null },
  align: { front: null, right: null, left: null },
  pins: [], selectedPin: -1,
  history: [], redo: [],
  model: null,                       // { kind, name, glb, parts, faces }
  hideModel: false,                  // true while the generic placeholder is not wanted on screen
  mmPerUnit: 117, scaleSource: 'assumed',   // real-world scale of the model
  measures: [], pendingPoint: null,          // distance measurements anchored to vertices
  landmarks: {}, landmarkStep: -1, showLandmarks: false,   // anatomical anchor points {name: {part, vi}}
  onDirty: () => {}, onHistory: () => {}, onPins: () => {}, onStatus: () => {}, onModel: () => {}, onMeasure: () => {}, onLandmarks: () => {},
  GUIDES, PRESETS,
};
let stage, renderer, scene, camera, controls, afterGroup, beforeGroup, ring, pinGroup, off, loopOn = false;
let genericMaterial, texture, texCanvas, genericGeo;
let stroke = null, hoverHit = null, measureGroup, ghostMaterial, landmarkGroup;
const raycaster = new THREE.Raycaster();
const pointerIds = new Set();
const pinSprites = [];
const parts = () => (A.model ? A.model.parts : []);
const isGeneric = () => !A.model || A.model.kind === 'generic';

/* ───────────── Init ───────────── */
A.init = function (stageEl) {
  stage = stageEl;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
  catch (e) { A.error = 'WebGL is not available in this browser.'; A.ready = true; return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x262b33, 1);
  renderer.domElement.id = 'gl';
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none';
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, -0.1, 4.8);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7480, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(0.9, 1.1, 2.2); camera.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35); rim.position.set(-2, 1, -2); scene.add(rim);

  afterGroup = new THREE.Group(); beforeGroup = new THREE.Group();
  scene.add(afterGroup, beforeGroup);

  texCanvas = document.createElement('canvas'); texCanvas.width = texCanvas.height = TEX;
  texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  genericMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.82, metalness: 0 });
  genericGeo = buildGenericGeometry();

  ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
  ring.renderOrder = 10; ring.visible = false; scene.add(ring);
  pinGroup = new THREE.Group(); scene.add(pinGroup);
  measureGroup = new THREE.Group(); scene.add(measureGroup);
  landmarkGroup = new THREE.Group(); scene.add(landmarkGroup);
  ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x1fb6c1, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.15, 0);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.minDistance = 1.2; controls.maxDistance = 14;
  controls.autoRotateSpeed = 1.6;
  controls.update();

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('pointerleave', () => { hoverHit = null; ring.visible = false; });

  useGenericModel();
  A.setTool('orbit');
  A.available = true; A.ready = true;
  return true;
};

A.show = function (on) {
  if (!renderer) return;
  renderer.domElement.style.display = on ? 'block' : 'none';
  if (on) { A.resize(); if (!loopOn) { loopOn = true; renderer.setAnimationLoop(frame); } }
  else if (loopOn) { loopOn = false; renderer.setAnimationLoop(null); }
};
A.resize = function () {
  if (!renderer) return;
  const r = stage.getBoundingClientRect();
  renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
  renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
};

/* ───────────── Models (generic head or loaded GLB) ───────────── */
function buildAdjacency(geo) {
  const idx = geo.index.array, n = geo.attributes.position.count, deg = new Uint32Array(n);
  for (let i = 0; i < idx.length; i += 3) { deg[idx[i]] += 2; deg[idx[i + 1]] += 2; deg[idx[i + 2]] += 2; }
  const start = new Uint32Array(n + 1); for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = new Uint32Array(n), list = new Uint32Array(start[n]);
  const add = (a, b) => { list[start[a] + fill[a]++] = b; };
  for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b = idx[i + 1], c = idx[i + 2]; add(a, b); add(a, c); add(b, a); add(b, c); add(c, a); add(c, b); }
  return { start, list };
}
function makePart(geo, material) {
  const base = geo.attributes.position.array.slice();
  const mesh = new THREE.Mesh(geo, material);
  const beforeGeo = new THREE.BufferGeometry();
  beforeGeo.setIndex(geo.index);
  beforeGeo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  for (const name of ['uv', 'color', 'uv1']) if (geo.attributes[name]) beforeGeo.setAttribute(name, geo.attributes[name]);
  beforeGeo.computeVertexNormals();
  const beforeMesh = new THREE.Mesh(beforeGeo, material);
  return { geo, mesh, beforeMesh, base, cur: base.slice(), adj: buildAdjacency(geo), n: geo.attributes.position.count };
}
function clearModel() {
  for (const p of parts()) { afterGroup.remove(p.mesh); beforeGroup.remove(p.beforeMesh); p.beforeMesh.geometry.dispose(); if (A.model.kind !== 'generic') { p.geo.dispose(); disposeMaterial(p.mesh.material); } }
  A.model = null; A.reference = null; A.history = []; A.redo = []; A.pins = []; A.selectedPin = -1; rebuildPinSprites();
}
function disposeMaterial(m) {
  for (const mat of Array.isArray(m) ? m : [m]) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (mat[k]) mat[k].dispose(); mat.dispose(); }
}
function useGenericModel() {
  clearModel();
  const geo = genericGeo.clone();
  geo.setAttribute('position', new THREE.BufferAttribute(genericGeo.attributes.position.array.slice(), 3));
  geo.computeVertexNormals();
  const part = makePart(geo, genericMaterial);
  A.model = { kind: 'generic', name: 'Generic head', glb: null, parts: [part], faces: geo.index.count / 3 };
  A.mmPerUnit = 117; A.scaleSource = 'assumed'; clearMeasures();
  autoLandmarksGeneric();
  afterGroup.add(part.mesh); beforeGroup.add(part.beforeMesh);
  bake();
  A.onModel(); A.onHistory(); A.onPins(false);
}
/* Load a GLB/GLTF (ArrayBuffer). The model is centred, scaled to head units and made sculptable. */
A.loadGLB = function (buffer, name = 'model.glb') {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', gltf => {
      try {
        const root = gltf.scene; root.updateMatrixWorld(true);
        const meshes = []; root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
        if (!meshes.length) throw new Error('The file contains no mesh.');
        const geos = meshes.map(m => {
          let g = m.geometry.clone();
          for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
          g.morphAttributes = {};
          g.applyMatrix4(m.matrixWorld);
          if (!g.index) g = mergeVertices(g, 1e-6);
          return g;
        });
        const box = new THREE.Box3(); geos.forEach(g => { g.computeBoundingBox(); box.union(g.boundingBox); });
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        const s = MODEL_HEIGHT / Math.max(size.y, 1e-6);
        // Guess the real-world scale from the file's units (metres or millimetres); the surgeon can calibrate.
        let mmPerUnit = 280 / MODEL_HEIGHT, scaleSource = 'assumed';
        if (size.y > 0.12 && size.y < 0.7) { mmPerUnit = size.y * 1000 / MODEL_HEIGHT; scaleSource = 'file'; }
        else if (size.y > 120 && size.y < 700) { mmPerUnit = size.y / MODEL_HEIGHT; scaleSource = 'file'; }
        const m4 = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
        geos.forEach(g => { g.applyMatrix4(m4); g.computeVertexNormals(); });
        clearModel();
        const newParts = geos.map((g, i) => {
          const src = meshes[i].material, mat = (Array.isArray(src) ? src[0] : src).clone();
          mat.side = THREE.FrontSide;
          if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
          return makePart(g, mat);
        });
        let faces = 0; newParts.forEach(p => { faces += p.geo.index.count / 3; afterGroup.add(p.mesh); beforeGroup.add(p.beforeMesh); });
        A.model = { kind: 'glb', name, glb: buffer, parts: newParts, faces, turns: [] };
        A.mmPerUnit = mmPerUnit; A.scaleSource = scaleSource; clearMeasures();
        guessLandmarksGLB();
        A.resetView();
        A.onModel(); A.onHistory(); A.onPins(false); A.onDirty();
        resolve(A.model);
      } catch (e) { reject(e); }
    }, err => reject(err instanceof Error ? err : new Error('Could not read this 3D file.')));
  });
};
A.removeModel = function () { useGenericModel(); A.onDirty(); };
/* Rotate a loaded model in 90° steps around an axis (bakes into the base shape, clears edits). */
function applyTurn(axis, quarterTurns) {
  const m4 = new THREE.Matrix4();
  if (axis === 'y') m4.makeRotationY(quarterTurns * Math.PI / 2); else if (axis === 'x') m4.makeRotationX(quarterTurns * Math.PI / 2); else m4.makeRotationZ(quarterTurns * Math.PI / 2);
  for (const p of parts()) {
    const v = new THREE.Vector3();
    for (let i = 0; i < p.base.length; i += 3) { v.set(p.base[i], p.base[i + 1], p.base[i + 2]).applyMatrix4(m4); p.base[i] = v.x; p.base[i + 1] = v.y; p.base[i + 2] = v.z; }
    p.cur.set(p.base); p.geo.attributes.position.array.set(p.base);
    p.geo.attributes.position.needsUpdate = true; p.geo.computeVertexNormals();
    p.beforeMesh.geometry.attributes.position.needsUpdate = true; p.beforeMesh.geometry.computeVertexNormals();
  }
}
A.turnModel = function (axis, quarterTurns) {
  if (isGeneric()) return;
  applyTurn(axis, quarterTurns);
  A.model.turns.push({ axis, q: quarterTurns });
  A.history = []; A.redo = []; A.morph = 1;
  A.onHistory(); A.onDirty();
};
A.modelInfo = () => (A.model ? { kind: A.model.kind, name: A.model.name, faces: Math.round(A.model.faces), bytes: A.model.glb ? A.model.glb.byteLength : 0, mmPerUnit: A.mmPerUnit, scaleSource: A.scaleSource } : null);

/* ───────────── Real-world scale & measurements ───────────── */
const mm = units => units * A.mmPerUnit;
A.mmToUnits = v => v / A.mmPerUnit;
A.pxPerMm = function () {
  const h = renderer.domElement.height / renderer.getPixelRatio(), d = camera.position.distanceTo(controls.target);
  return (h / 2) / (d * Math.tan(camera.fov * Math.PI / 360)) / A.mmPerUnit;
};
function vertexPos(ref, which) {
  const p = parts()[ref.part]; if (!p) return null;
  const arr = which === 'before' ? (A.reference ? A.reference[ref.part] : p.base) : p.geo.attributes.position.array, k = ref.vi * 3;
  return new THREE.Vector3(arr[k], arr[k + 1], arr[k + 2]);
}
A.measureValues = function (i) {
  const m = A.measures[i]; if (!m) return null;
  const a0 = vertexPos(m.a, 'before'), b0 = vertexPos(m.b, 'before'), a1 = vertexPos(m.a, 'after'), b1 = vertexPos(m.b, 'after');
  if (!a0 || !b0) return null;
  return { before: mm(a0.distanceTo(b0)), after: mm(a1.distanceTo(b1)), units: a0.distanceTo(b0) };
};
function clearMeasures() { A.measures = []; A.pendingPoint = null; rebuildMeasureObjects(); }
A.deleteMeasure = i => { A.measures.splice(i, 1); rebuildMeasureObjects(); A.onMeasure(); A.onDirty(); };
A.clearMeasures = () => { clearMeasures(); A.onMeasure(); A.onDirty(); };
/* Calibrate the scale: measurement i spans `realMm` millimetres on the original model. */
A.calibrate = function (i, realMm) {
  const v = A.measureValues(i); if (!v || !(realMm > 0) || v.units <= 0) return false;
  A.mmPerUnit = realMm / v.units; A.scaleSource = 'calibrated';
  A.onModel(); A.onMeasure(); A.onDirty(); return true;
};
A.setMmPerUnit = function (value, source = 'calibrated') { if (value > 0) { A.mmPerUnit = value; A.scaleSource = source; A.onModel(); A.onMeasure(); A.onDirty(); } };
function labelTexture(text) {
  const c = document.createElement('canvas'), g = c.getContext('2d'), font = '600 26px system-ui, sans-serif';
  g.font = font; const w = Math.ceil(g.measureText(text).width) + 28; c.width = w; c.height = 44;
  g.font = font; g.fillStyle = 'rgba(22,33,46,.85)'; g.beginPath(); g.roundRect(0, 0, w, 44, 10); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, 14, 23);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return { t, w };
}
function rebuildMeasureObjects() {
  while (measureGroup.children.length) { const o = measureGroup.children.pop(); if (o.material) { if (o.material.map && o.material.map.dispose) o.material.map.dispose(); o.material.dispose(); } if (o.geometry) o.geometry.dispose(); }
  A.measures.forEach(() => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffb300, depthTest: false }));
    line.renderOrder = 15; measureGroup.add(line);
    const ends = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.PointsMaterial({ color: 0xffb300, size: 0.05, depthTest: false }));
    ends.renderOrder = 15; measureGroup.add(ends);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(' ').t, depthTest: false, transparent: true }));
    label.renderOrder = 21; label.userData.text = ''; measureGroup.add(label);
  });
  if (A.pendingPoint) {
    const pt = new THREE.Points(new THREE.BufferGeometry().setFromPoints([vertexPos(A.pendingPoint, 'after')]), new THREE.PointsMaterial({ color: 0xffb300, size: 0.06, depthTest: false }));
    pt.renderOrder = 15; measureGroup.add(pt);
  }
}
function updateMeasures() {
  A.measures.forEach((m, i) => {
    const line = measureGroup.children[i * 3], ends = measureGroup.children[i * 3 + 1], label = measureGroup.children[i * 3 + 2];
    const a = vertexPos(m.a, 'after'), b = vertexPos(m.b, 'after'); if (!a || !b || !line) return;
    line.geometry.setFromPoints([a, b]); ends.geometry.setFromPoints([a, b]);
    const v = A.measureValues(i), text = Math.abs(v.after - v.before) < 0.05 ? `${v.after.toFixed(1)} mm` : `${v.after.toFixed(1)} mm (was ${v.before.toFixed(1)})`;
    if (label.userData.text !== text) {
      label.material.map.dispose(); const { t, w } = labelTexture(text); label.material.map = t; label.material.needsUpdate = true;
      label.scale.set(0.0032 * w, 0.0032 * 44, 1); label.userData.text = text;
    }
    label.position.copy(a).lerp(b, 0.5).add(new THREE.Vector3(0, 0.09, 0));
  });
}
function addMeasurePoint(part, vi) {
  if (!A.pendingPoint) { A.pendingPoint = { part, vi }; rebuildMeasureObjects(); A.onMeasure(); return; }
  if (A.pendingPoint.part === part && A.pendingPoint.vi === vi) return;
  A.measures.push({ a: A.pendingPoint, b: { part, vi }, label: '' });
  A.pendingPoint = null; rebuildMeasureObjects(); A.onMeasure(true); A.onDirty();
}

/* ───────────── Rendering ───────────── */
function updatePins() {
  A.pins.forEach((pin, i) => {
    const s = pinSprites[i], p = parts()[pin.part]; if (!s || !p) return;
    const pos = p.geo.attributes.position.array, n = p.geo.attributes.normal.array, k = pin.vi * 3;
    s.position.set(pos[k] + n[k] * 0.05, pos[k + 1] + n[k + 1] * 0.05, pos[k + 2] + n[k + 2] * 0.05);
  });
}
function frame() {
  controls.autoRotate = A.autoRotate;
  controls.update();
  updatePins(); updateMeasures(); updateLandmarkSprites(); stepAnimation();
  measureGroup.visible = !A.showBefore;
  landmarkGroup.visible = !A.showBefore && (A.showLandmarks || A.tool === 'landmark');
  const w = renderer.domElement.width / renderer.getPixelRatio(), h = renderer.domElement.height / renderer.getPixelRatio();
  const showAfter = !A.showBefore;
  if (A.hideModel) { afterGroup.visible = beforeGroup.visible = pinGroup.visible = measureGroup.visible = landmarkGroup.visible = ring.visible = false; renderer.setScissorTest(false); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setViewport(0, 0, w, h); renderer.render(scene, camera); afterGroup.visible = beforeGroup.visible = true; return; }
  if (A.compare === 'side' && !A.showBefore) {
    renderer.setScissorTest(true);
    camera.aspect = (w / 2) / h; camera.updateProjectionMatrix();
    beforeGroup.visible = true; afterGroup.visible = false; pinGroup.visible = false; measureGroup.visible = false; landmarkGroup.visible = false; ring.visible = false;
    renderer.setViewport(0, 0, w / 2, h); renderer.setScissor(0, 0, w / 2, h); renderer.render(scene, camera);
    beforeGroup.visible = false; afterGroup.visible = true; pinGroup.visible = true; measureGroup.visible = !A.showBefore; landmarkGroup.visible = A.showLandmarks || A.tool === 'landmark'; ring.visible = !!hoverHit && isSculpt();
    renderer.setViewport(w / 2, 0, w / 2, h); renderer.setScissor(w / 2, 0, w / 2, h); renderer.render(scene, camera);
    renderer.setScissorTest(false);
  } else {
    camera.aspect = w / h; camera.updateProjectionMatrix();
    beforeGroup.visible = !showAfter; afterGroup.visible = showAfter; pinGroup.visible = showAfter;
    ring.visible = showAfter && !!hoverHit && isSculpt() && !stroke;
    renderer.setViewport(0, 0, w, h); renderer.render(scene, camera);
    if (A.compare === 'ghost' && showAfter) {
      // Translucent overlay of the original shape over the simulated result.
      const savedOverride = scene.overrideMaterial, savedClear = renderer.autoClear;
      afterGroup.visible = false; beforeGroup.visible = true; pinGroup.visible = false; measureGroup.visible = false; ring.visible = false;
      scene.overrideMaterial = ghostMaterial; renderer.autoClear = false;
      renderer.render(scene, camera);
      scene.overrideMaterial = savedOverride; renderer.autoClear = savedClear;
    }
  }
  afterGroup.visible = true; beforeGroup.visible = true;
}
const isSculpt = () => ['grab', 'add', 'sub', 'smooth', 'restore'].includes(A.tool);
const isPointTool = () => A.tool === 'note' || A.tool === 'measure' || A.tool === 'landmark';

/* ───────────── Camera / view ───────────── */
A.setView = function (preset) {
  const az = (PRESETS[preset] ?? 0) * Math.PI / 180, d = camera.position.distanceTo(controls.target) || 4.8;
  camera.position.set(controls.target.x + d * Math.sin(az), controls.target.y + d * 0.06, controls.target.z + d * Math.cos(az));
  controls.update();
};
A.resetView = function () { controls.target.set(0, isGeneric() ? -0.15 : 0, 0); camera.position.set(0, controls.target.y + 0.05, 4.8); controls.update(); };
A.zoomBy = function (f) {
  const dir = camera.position.clone().sub(controls.target);
  const d = clamp(dir.length() / f, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(dir.setLength(d)); controls.update();
};
A.setAutoRotate = on => { A.autoRotate = !!on; };
A.setCompare = m => { A.compare = m; };
A.setShowBefore = on => { A.showBefore = !!on; };
A.setTool = function (t) {
  A.tool = t;
  const orbit = t === 'orbit';
  controls.mouseButtons = { LEFT: orbit ? THREE.MOUSE.ROTATE : null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: orbit ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE };
  controls.touches = { ONE: orbit ? THREE.TOUCH.ROTATE : null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  if (renderer) renderer.domElement.style.cursor = orbit ? 'grab' : isPointTool() ? 'crosshair' : 'none';
  if (t !== 'measure' && A.pendingPoint) { A.pendingPoint = null; rebuildMeasureObjects(); A.onMeasure(); }
  if (!isSculpt()) ring.visible = false;
};

/* ───────────── Morph amount ───────────── */
function commitPart(p) { p.geo.attributes.position.needsUpdate = true; p.geo.computeVertexNormals(); }
A.setMorph = function (t) {
  A.morph = t;
  for (const p of parts()) {
    const disp = p.geo.attributes.position.array;
    if (t >= 1) disp.set(p.cur); else for (let i = 0; i < disp.length; i++) disp[i] = p.base[i] + (p.cur[i] - p.base[i]) * t;
    commitPart(p);
  }
};
function commit() { A.morph = 1; for (const p of parts()) { p.geo.attributes.position.array.set(p.cur); commitPart(p); } }
A.hasEdits = function () { for (const p of parts()) for (let i = 0; i < p.cur.length; i++) if (p.cur[i] !== p.base[i]) return true; return false; };

/* ───────────── Picking ───────────── */
function ndcFromEvent(e) {
  const r = renderer.domElement.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (A.compare === 'side' && !A.showBefore) { if (x < 0.5) return null; x = (x - 0.5) * 2; }
  return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
}
function raycastNdc(ndc) {
  if (!ndc || A.hideModel) return null;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(parts().map(p => p.mesh), false);
  if (!hits.length) return null;
  const hit = hits[0]; hit.partIndex = parts().findIndex(p => p.mesh === hit.object);
  return hit;
}
function closestVertex(hit) {
  const p = parts()[hit.partIndex], pos = p.geo.attributes.position.array, f = hit.face, q = hit.point; let best = f.a, bd = Infinity;
  for (const vi of [f.a, f.b, f.c]) {
    const d = (pos[vi * 3] - q.x) ** 2 + (pos[vi * 3 + 1] - q.y) ** 2 + (pos[vi * 3 + 2] - q.z) ** 2;
    if (d < bd) { bd = d; best = vi; }
  }
  return best;
}
function placeRing(hit) {
  ring.position.copy(hit.point);
  ring.lookAt(hit.point.clone().add(hit.face.normal));
  ring.scale.setScalar(A.brush);
}

/* ───────────── Sculpting ───────────── */
function affected(p, center, sign) {
  const idx = [], f = [], r = A.brush, r2 = r * r, cx = center.x * sign, cy = center.y, cz = center.z, cur = p.cur;
  for (let i = 0; i < p.n; i++) {
    const dx = cur[i * 3] - cx, dy = cur[i * 3 + 1] - cy, dz = cur[i * 3 + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const q = 1 - d2 / r2; idx.push(i); f.push(q * q);
  }
  return { idx, f, sign };
}
function groupsFor(p, point) {
  const g = [affected(p, point, 1)];
  if (A.symmetry && Math.abs(point.x) > 0.012) g.push(affected(p, point, -1));
  return g;
}
/* Remember a vertex's pre-stroke position the first time a stroke touches it (for undo). */
function touch(p, i) {
  const t = stroke.touched[p.id] || (stroke.touched[p.id] = { part: p.id, seen: new Uint8Array(p.n), idx: [], old: [] });
  if (t.seen[i]) return;
  t.seen[i] = 1; t.idx.push(i); t.old.push(p.cur[i * 3], p.cur[i * 3 + 1], p.cur[i * 3 + 2]);
}
function applyContinuous(point) {
  const k = A.strength, tool = A.tool;
  parts().forEach((p, pi) => {
    p.id = pi;
    const cur = p.cur, n = p.geo.attributes.normal.array, adj = p.adj;
    for (const g of groupsFor(p, point)) {
      for (let m = 0; m < g.idx.length; m++) {
        const i = g.idx[m], f = g.f[m], o = i * 3;
        touch(p, i);
        if (tool === 'add' || tool === 'sub') {
          const s = (tool === 'add' ? 1 : -1) * f * k * 0.004;
          cur[o] += n[o] * s; cur[o + 1] += n[o + 1] * s; cur[o + 2] += n[o + 2] * s;
        } else if (tool === 'smooth') {
          const a0 = adj.start[i], a1 = adj.start[i + 1]; if (a1 === a0) continue;
          let ax = 0, ay = 0, az = 0;
          for (let a = a0; a < a1; a++) { const j = adj.list[a] * 3; ax += cur[j]; ay += cur[j + 1]; az += cur[j + 2]; }
          const inv = 1 / (a1 - a0), w = f * k * 0.25;
          cur[o] += (ax * inv - cur[o]) * w; cur[o + 1] += (ay * inv - cur[o + 1]) * w; cur[o + 2] += (az * inv - cur[o + 2]) * w;
        } else if (tool === 'restore') {
          const w = f * k * 0.12;
          for (let c = 0; c < 3; c++) cur[o + c] += (p.base[o + c] - cur[o + c]) * w;
        }
      }
    }
  });
  commit();
}
function applyGrab(delta) {
  const k = A.strength;
  for (const g of stroke.grab) {
    const p = parts()[g.part], cur = p.cur, s = g.start;
    for (let m = 0; m < g.idx.length; m++) {
      const i = g.idx[m], f = g.f[m] * k, o = i * 3, so = m * 3;
      cur[o] = s[so] + delta.x * g.sign * f; cur[o + 1] = s[so + 1] + delta.y * f; cur[o + 2] = s[so + 2] + delta.z * f;
    }
  }
  commit();
}
function onDown(e) {
  pointerIds.add(e.pointerId);
  if (pointerIds.size > 1) { endStroke(); return; }
  if (e.button !== 0) return;
  const ndc = ndcFromEvent(e); if (!ndc) return;
  raycaster.setFromCamera(ndc, camera);
  const ph = raycaster.intersectObjects(pinSprites, false);
  if (ph.length) { A.selectPin(pinSprites.indexOf(ph[0].object)); return; }
  if (A.tool === 'orbit' || A.showBefore) return;
  const hit = raycastNdc(ndc); if (!hit) return;
  if (A.tool === 'note') { e.preventDefault(); addPin(hit.partIndex, closestVertex(hit)); return; }
  if (A.tool === 'measure') { e.preventDefault(); addMeasurePoint(hit.partIndex, closestVertex(hit)); return; }
  if (A.tool === 'landmark') { e.preventDefault(); placeLandmark(hit.partIndex, closestVertex(hit)); return; }
  renderer.domElement.setPointerCapture(e.pointerId);
  if (A.morph < 1) A.setMorph(1);
  stroke = { ndc, touched: {}, raf: 0 };
  if (A.tool === 'grab') {
    stroke.grab = [];
    parts().forEach((p, pi) => {
      p.id = pi;
      for (const g of groupsFor(p, hit.point)) {
        const start = new Float32Array(g.idx.length * 3);
        g.idx.forEach((i, m) => { touch(p, i); start[m * 3] = p.cur[i * 3]; start[m * 3 + 1] = p.cur[i * 3 + 1]; start[m * 3 + 2] = p.cur[i * 3 + 2]; });
        stroke.grab.push({ part: pi, idx: g.idx, f: g.f, sign: g.sign, start });
      }
    });
    stroke.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
    stroke.origin = hit.point.clone();
  } else {
    stroke.raf = requestAnimationFrame(tick);
  }
}
function tick() {
  if (!stroke) return;
  const hit = raycastNdc(stroke.ndc);
  if (hit) { applyContinuous(hit.point); placeRing(hit); hoverHit = hit; }
  stroke.raf = requestAnimationFrame(tick);
}
function onMove(e) {
  if (pointerIds.size > 1) return;
  const ndc = ndcFromEvent(e);
  if (stroke) {
    stroke.ndc = ndc;
    if (stroke.grab && ndc) {
      raycaster.setFromCamera(ndc, camera);
      const p = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(stroke.plane, p)) applyGrab(p.sub(stroke.origin));
    }
    return;
  }
  if (isSculpt() || isPointTool()) { const hit = raycastNdc(ndc); hoverHit = hit; if (hit) placeRing(hit); }
}
function onUp(e) { pointerIds.delete(e.pointerId); if (stroke) endStroke(); }
function endStroke() {
  if (!stroke) return;
  cancelAnimationFrame(stroke.raf);
  const entries = Object.values(stroke.touched).map(t => ({ part: t.part, idx: Uint32Array.from(t.idx), old: Float32Array.from(t.old) })).filter(t => t.idx.length);
  stroke = null;
  if (!entries.length) return;
  let changed = false;
  for (const t of entries) { const cur = parts()[t.part].cur; for (let m = 0; m < t.idx.length && !changed; m++) { const o = t.idx[m] * 3; if (cur[o] !== t.old[m * 3] || cur[o + 1] !== t.old[m * 3 + 1] || cur[o + 2] !== t.old[m * 3 + 2]) changed = true; } }
  if (!changed) return;
  A.history.push(entries); if (A.history.length > HISTORY_LIMIT) A.history.shift();
  A.redo = []; A.onHistory(); A.onDirty();
}
function swapEntries(entries) {
  // Apply the stored positions and return the inverse entry set.
  return entries.map(t => {
    const p = parts()[t.part], cur = p.cur, now = new Float32Array(t.old.length);
    for (let m = 0; m < t.idx.length; m++) { const o = t.idx[m] * 3, so = m * 3; now[so] = cur[o]; now[so + 1] = cur[o + 1]; now[so + 2] = cur[o + 2]; cur[o] = t.old[so]; cur[o + 1] = t.old[so + 1]; cur[o + 2] = t.old[so + 2]; }
    return { part: t.part, idx: t.idx, old: now };
  });
}
A.undo = function () { if (!A.history.length) return; A.redo.push(swapEntries(A.history.pop())); commit(); A.onHistory(); A.onDirty(); };
A.redoStep = function () { if (!A.redo.length) return; A.history.push(swapEntries(A.redo.pop())); commit(); A.onHistory(); A.onDirty(); };
A.reset = function () {
  const entries = parts().map((p, pi) => { const idx = new Uint32Array(p.n); for (let i = 0; i < p.n; i++) idx[i] = i; return { part: pi, idx, old: p.cur.slice() }; });
  A.history.push(entries); if (A.history.length > HISTORY_LIMIT) A.history.shift();
  for (const p of parts()) p.cur.set(p.base);
  A.redo = []; commit(); A.onHistory(); A.onDirty();
};
A.canUndo = () => A.history.length > 0;
A.canRedo = () => A.redo.length > 0;

/* ───────────── Pins ───────────── */
function pinTexture(n, selected) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fillStyle = selected ? '#e08a00' : '#0f7f86'; g.fill();
  g.lineWidth = 4; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#fff'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 32, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function rebuildPinSprites() {
  pinSprites.forEach(s => { pinGroup.remove(s); s.material.map.dispose(); s.material.dispose(); });
  pinSprites.length = 0;
  A.pins.forEach((p, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(i + 1, i === A.selectedPin), depthTest: false, transparent: true }));
    s.scale.setScalar(0.14); s.renderOrder = 20; pinGroup.add(s); pinSprites.push(s);
  });
  updatePins();
}
function addPin(part, vi) { A.pins.push({ part, vi, text: '' }); A.selectedPin = A.pins.length - 1; rebuildPinSprites(); A.onPins(true); A.onDirty(); }
A.selectPin = i => { A.selectedPin = i; rebuildPinSprites(); A.onPins(false); };
A.deletePin = i => { A.pins.splice(i, 1); A.selectedPin = -1; rebuildPinSprites(); A.onPins(false); A.onDirty(); };

/* ───────────── Photos & texture bake (generic head only) ───────────── */
A.defaultAlign = function (view) { return { cx: view.W / 2, cy: view.H * 0.47, s: view.H * 0.26, flip: false }; };
A.setPhoto = function (role, view, align) {
  A.photos[role] = view || null;
  A.align[role] = view ? (align || A.align[role] || A.defaultAlign(view)) : null;
};
A.setAlign = function (role, align) { A.align[role] = { ...align }; };
A.getAlign = role => A.align[role];
A.rebake = function () { bake(); };
function prepPhoto(role) {
  const v = A.photos[role], a = A.align[role];
  if (!v || !a) return null;
  return { src: v.src, W: v.W, H: v.H, cx: a.cx, cy: a.cy, s: a.s, sign: a.flip ? -1 : 1, axis: role === 'front' ? 'x' : role === 'right' ? 'z' : '-z' };
}
function estimateSkin(P) {
  if (!P) return DEFAULT_SKIN;
  const acc = [0, 0, 0]; let n = 0;
  for (const X of [-0.3, 0.3]) {
    const ix = Math.round(P.cx + X * P.sign * P.s), iy = Math.round(P.cy + 0.05 * P.s);
    for (let y = iy - 6; y <= iy + 6; y++) for (let x = ix - 6; x <= ix + 6; x++) {
      if (x < 0 || y < 0 || x >= P.W || y >= P.H) continue;
      const o = (y * P.W + x) * 4; acc[0] += P.src[o]; acc[1] += P.src[o + 1]; acc[2] += P.src[o + 2]; n++;
    }
  }
  return n ? acc.map(c => c / n) : DEFAULT_SKIN;
}
function bake() {
  const t0 = performance.now();
  const img = texCanvas.getContext('2d').createImageData(TEX, TEX), d = img.data;
  const bp = genericGeo.attributes.position.array, bn = genericGeo.attributes.normal.array;
  const photos = [prepPhoto('front'), prepPhoto('right'), prepPhoto('left')].filter(Boolean);
  const skin = estimateSkin(prepPhoto('front') || prepPhoto('right') || prepPhoto('left'));
  const col = [0, 0, 0];
  const sample = (P, X, Y) => {
    const ix = P.cx + X * P.sign * P.s, iy = P.cy - Y * P.s;
    if (ix < 0 || iy < 0 || ix > P.W - 1 || iy > P.H - 1) return 0;
    const edge = Math.min(1, Math.min(ix, P.W - 1 - ix) / (P.W * 0.04), Math.min(iy, P.H - 1 - iy) / (P.H * 0.04));
    const fx = ix | 0, fy = iy | 0, cx = Math.min(fx + 1, P.W - 1), cy = Math.min(fy + 1, P.H - 1), ax = ix - fx, ay = iy - fy;
    const i00 = (fy * P.W + fx) * 4, i10 = (fy * P.W + cx) * 4, i01 = (cy * P.W + fx) * 4, i11 = (cy * P.W + cx) * 4;
    const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay, s = P.src;
    col[0] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
    col[1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
    col[2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
    return edge;
  };
  for (let ty = 0; ty < TEX; ty++) {
    const gj = ((ty + 0.5) / TEX) * SEG_V, j0 = Math.min(SEG_V - 1, gj | 0), fy = gj - j0;
    for (let tx = 0; tx < TEX; tx++) {
      const gi = ((tx + 0.5) / TEX) * SEG_U, i0 = Math.min(SEG_U - 1, gi | 0), fx = gi - i0;
      const k00 = (j0 * COLS + i0) * 3, k10 = k00 + 3, k01 = k00 + COLS * 3, k11 = k01 + 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const px = bp[k00] * w00 + bp[k10] * w10 + bp[k01] * w01 + bp[k11] * w11;
      const py = bp[k00 + 1] * w00 + bp[k10 + 1] * w10 + bp[k01 + 1] * w01 + bp[k11 + 1] * w11;
      const pz = bp[k00 + 2] * w00 + bp[k10 + 2] * w10 + bp[k01 + 2] * w01 + bp[k11 + 2] * w11;
      let nx = bn[k00] * w00 + bn[k10] * w10 + bn[k01] * w01 + bn[k11] * w11;
      let nz = bn[k00 + 2] * w00 + bn[k10 + 2] * w10 + bn[k01 + 2] * w01 + bn[k11 + 2] * w11;
      const ny = bn[k00 + 1] * w00 + bn[k10 + 1] * w10 + bn[k01 + 1] * w01 + bn[k11 + 1] * w11;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; nz /= nl;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (const P of photos) {
        let w, X;
        if (P.axis === 'x') { w = nz; X = px; } else if (P.axis === 'z') { w = -nx; X = pz; } else { w = nx; X = -pz; }
        if (w <= 0) continue;
        w = Math.pow(w, 1.6) * smooth(-1.12, -0.92, py);
        if (w <= 0) continue;
        const e = sample(P, X, py); if (e <= 0) continue;
        w *= e; r += col[0] * w; g += col[1] * w; b += col[2] * w; wsum += w;
      }
      const wf = Math.max(0, 0.22 - wsum) + 0.004;
      r += skin[0] * wf; g += skin[1] * wf; b += skin[2] * wf; wsum += wf;
      const o = (ty * TEX + tx) * 4;
      d[o] = r / wsum; d[o + 1] = g / wsum; d[o + 2] = b / wsum; d[o + 3] = 255;
    }
  }
  texCanvas.getContext('2d').putImageData(img, 0, 0);
  texture.needsUpdate = true;
  A.onStatus(`Avatar texture built in ${Math.round(performance.now() - t0)} ms`);
}
A.silhouette = function (role) {
  const base = genericGeo.attributes.position.array, pts = [];
  if (role === 'front') {
    const rows = [];
    for (let j = 0; j <= SEG_V; j++) {
      let mx = 0;
      for (let i = 0; i <= SEG_U; i++) mx = Math.max(mx, Math.abs(base[(j * COLS + i) * 3]));
      rows.push([mx, base[j * COLS * 3 + 1]]);
    }
    for (const [x, y] of rows) pts.push([x, y]);
    for (let j = rows.length - 1; j >= 0; j--) pts.push([-rows[j][0], rows[j][1]]);
  } else {
    const sign = role === 'right' ? 1 : -1, iF = SEG_U / 2;
    for (let j = 0; j <= SEG_V; j++) { const k = (j * COLS + iF) * 3; pts.push([sign * base[k + 2], base[k + 1]]); }
    for (let j = SEG_V; j >= 0; j--) { const k = (j * COLS) * 3; pts.push([sign * base[k + 2], base[k + 1]]); }
  }
  return pts;
};

/* ───────────── Snapshots (export / print) ───────────── */
A.snapshot = function (kind, preset, size = 1000) {
  if (!off) { off = new THREE.WebGLRenderer({ antialias: true, alpha: false }); off.setPixelRatio(1); off.setClearColor(0xffffff, 1); }
  off.setSize(size, size, false);
  const savedPos = camera.position.clone(), savedQuat = camera.quaternion.clone(), savedAspect = camera.aspect, savedMorph = A.morph;
  if (preset && preset !== 'current') {
    const az = (PRESETS[preset] ?? 0) * Math.PI / 180, d = 4.8;
    camera.position.set(controls.target.x + d * Math.sin(az), controls.target.y + d * 0.06, controls.target.z + d * Math.cos(az));
    camera.lookAt(controls.target);
  }
  camera.aspect = 1; camera.updateProjectionMatrix();
  if (savedMorph < 1) A.setMorph(1);
  beforeGroup.visible = kind === 'before'; afterGroup.visible = kind !== 'before'; pinGroup.visible = kind !== 'before'; measureGroup.visible = kind !== 'before'; landmarkGroup.visible = false; ring.visible = false;
  updateMeasures();
  off.render(scene, camera);
  const c = document.createElement('canvas'); c.width = c.height = size; c.getContext('2d').drawImage(off.domElement, 0, 0);
  beforeGroup.visible = afterGroup.visible = measureGroup.visible = true; landmarkGroup.visible = A.showLandmarks;
  camera.position.copy(savedPos); camera.quaternion.copy(savedQuat); camera.aspect = savedAspect; camera.updateProjectionMatrix();
  if (savedMorph < 1) A.setMorph(savedMorph);
  return c;
};

/* ───────────── Save / restore ───────────── */
function b64FromBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b64) { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
function encodeParts() {
  const out = [];
  parts().forEach((p, pi) => {
    let any = false; for (let i = 0; i < p.cur.length; i++) if (p.cur[i] !== p.base[i]) { any = true; break; }
    if (!any) return;
    const q = new Int16Array(p.cur.length);
    for (let i = 0; i < p.cur.length; i++) q[i] = clamp(Math.round((p.cur[i] - p.base[i]) * DISP_Q), -32768, 32767);
    out.push({ part: pi, n: p.n, q: DISP_Q, data: b64FromBytes(new Uint8Array(q.buffer)) });
  });
  return out;
}
function decodeParts(list) {
  for (const d of list || []) {
    const p = parts()[d.part]; if (!p || d.n !== p.n) continue;
    const q = new Int16Array(bytesFromB64(d.data).buffer);
    for (let i = 0; i < p.cur.length && i < q.length; i++) p.cur[i] = p.base[i] + q[i] / d.q;
  }
}
A.serialize = function (viewIndex) {
  const roles = {};
  for (const r of ['front', 'right', 'left']) roles[r] = A.photos[r] ? { view: viewIndex(A.photos[r]), align: A.align[r] } : null;
  const model = isGeneric() ? null : { name: A.model.name, glb: b64FromBytes(new Uint8Array(A.model.glb)), turns: A.model.turns.slice() };
  return { version: 2, roles, model, parts: encodeParts(), pins: A.pins.map(p => ({ ...p })), mmPerUnit: A.mmPerUnit, scaleSource: A.scaleSource, measures: A.measures.map(m => ({ a: { ...m.a }, b: { ...m.b }, label: m.label || '' })), landmarks: JSON.parse(JSON.stringify(A.landmarks)) };
};
A.restore = async function (data, viewAt) {
  for (const r of ['front', 'right', 'left']) { A.photos[r] = null; A.align[r] = null; }
  if (data && data.roles) for (const r of ['front', 'right', 'left']) {
    const d = data.roles[r], v = d ? viewAt(d.view) : null;
    if (v) { A.photos[r] = v; A.align[r] = d.align && typeof d.align.s === 'number' ? { ...d.align } : A.defaultAlign(v); }
  }
  let loaded = false;
  if (data && data.model && data.model.glb) {
    try {
      await A.loadGLB(bytesFromB64(data.model.glb).buffer, data.model.name || 'model.glb'); loaded = true;
      for (const t of data.model.turns || []) { applyTurn(t.axis, t.q); A.model.turns.push({ axis: t.axis, q: t.q }); }
    }
    catch (e) { A.onStatus('The saved 3D model could not be loaded: ' + e.message); }
  }
  if (!loaded) useGenericModel();
  A.history = []; A.redo = [];
  if (data) {
    if (data.version === 2) decodeParts(data.parts);
    else if (data.disp && isGeneric() && data.disp.segU === SEG_U && data.disp.segV === SEG_V) decodeParts([{ part: 0, n: NV, q: data.disp.q, data: data.disp.data }]);
    const np = parts();
    A.pins = (data.pins || []).map(p => ({ part: Number.isInteger(p.part) ? p.part : 0, vi: p.vi, text: String(p.text || '') }))
      .filter(p => np[p.part] && Number.isInteger(p.vi) && p.vi >= 0 && p.vi < np[p.part].n);
    const okRef = r => r && np[r.part] && Number.isInteger(r.vi) && r.vi >= 0 && r.vi < np[r.part].n;
    A.measures = (data.measures || []).filter(m => okRef(m.a) && okRef(m.b)).map(m => ({ a: { ...m.a }, b: { ...m.b }, label: String(m.label || '') }));
    if (data.mmPerUnit > 0) { A.mmPerUnit = data.mmPerUnit; A.scaleSource = data.scaleSource || 'calibrated'; }
    if (data.landmarks && typeof data.landmarks === 'object') { const lm = {}; for (const [k, r] of Object.entries(data.landmarks)) if (LANDMARK_NAMES.includes(k) && okRef(r)) lm[k] = { part: r.part, vi: r.vi }; if (Object.keys(lm).length) A.landmarks = lm; }
  }
  A.selectedPin = -1; A.pendingPoint = null;
  commit(); rebuildPinSprites(); rebuildMeasureObjects(); rebuildLandmarkSprites();
  A.onModel(); A.onHistory(); A.onPins(false); A.onMeasure(); A.onLandmarks();
};
A.dropView = function (view) {
  let changed = false;
  for (const r of ['front', 'right', 'left']) if (A.photos[r] === view) { A.photos[r] = null; A.align[r] = null; changed = true; }
  if (changed && isGeneric()) bake();
};

/* ───────────── Anatomical landmarks ─────────────
   Seven points the surgeon confirms; everything else (alar bases, lips, cheeks, jaw, brows…)
   is derived from them in millimetres, so the AI autopilot knows where each structure is. */
const LANDMARK_NAMES = ['pupil_r', 'pupil_l', 'nasion', 'rhinion', 'pronasale', 'subnasale', 'pogonion'];
const LANDMARK_LABELS = {
  pupil_r: "Right pupil (patient's right — on your left)", pupil_l: "Left pupil (patient's left)",
  nasion: 'Nasion — deepest point of the nose bridge, between the eyes', rhinion: 'Rhinion — middle of the nasal dorsum (where a hump sits)',
  pronasale: 'Nose tip (most projecting point)', subnasale: 'Subnasale — where the columella meets the upper lip', pogonion: 'Chin — most forward point',
};
A.LANDMARK_NAMES = LANDMARK_NAMES; A.LANDMARK_LABELS = LANDMARK_LABELS;
A.landmarksReady = () => LANDMARK_NAMES.every(n => A.landmarks[n]);
function nearestVertex(target, filter) {
  let best = null, bd = Infinity;
  parts().forEach((p, pi) => {
    const a = p.cur;
    for (let i = 0; i < p.n; i++) {
      const dx = a[i * 3] - target.x, dy = a[i * 3 + 1] - target.y, dz = a[i * 3 + 2] - target.z;
      if (filter && !filter(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])) continue;
      const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = { part: pi, vi: i }; }
    }
  });
  return best;
}
function autoLandmarksGeneric() {
  const F = 2; // any point well in front; nearestVertex with a front-facing filter snaps it to the surface
  const guess = { pupil_r: [-0.26, 0.09, F], pupil_l: [0.26, 0.09, F], nasion: [0, 0.2, F], rhinion: [0, 0.03, F], pronasale: [0, -0.14, F], subnasale: [0, -0.24, F], pogonion: [0, -0.85, F] };
  A.landmarks = {};
  for (const [k, g] of Object.entries(guess)) {
    const t = new THREE.Vector3(g[0], g[1], g[2]), best = nearestVertex(t, (x, y, z) => z > 0.2 && Math.abs(x - g[0]) < 0.04 && Math.abs(y - g[1]) < 0.04);
    if (best) A.landmarks[k] = best;
  }
  A.landmarkStep = -1; rebuildLandmarkSprites(); A.onLandmarks();
}
/* Rough guesses for a loaded model (front = +z after orientation); the surgeon confirms with the Landmarks tool. */
function guessLandmarksGLB() {
  A.landmarks = {}; A.landmarkStep = -1;
  let tip = null, tz = -Infinity;
  parts().forEach((p, pi) => { const a = p.cur; for (let i = 0; i < p.n; i++) { const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2]; if (Math.abs(x) < 0.12 && y > -0.6 && y < 0.6 && z > tz) { tz = z; tip = { part: pi, vi: i, x, y, z }; } } });
  if (!tip) { rebuildLandmarkSprites(); A.onLandmarks(); return; }
  const u = A.mmToUnits(1); // units per mm
  const midline = (dyMm, prefer) => {
    const y0 = tip.y + dyMm * u; let best = null, bz = prefer === 'min' ? Infinity : -Infinity;
    parts().forEach((p, pi) => { const a = p.cur; for (let i = 0; i < p.n; i++) { const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2]; if (Math.abs(x) > 4 * u || Math.abs(y - y0) > 4 * u || z < tip.z - 60 * u) continue; if (prefer === 'min' ? z < bz : z > bz) { bz = z; best = { part: pi, vi: i }; } } });
    return best;
  };
  A.landmarks.pronasale = { part: tip.part, vi: tip.vi };
  A.landmarks.subnasale = midline(-14, 'min') || A.landmarks.pronasale;
  A.landmarks.rhinion = midline(18, 'max') || A.landmarks.pronasale;
  A.landmarks.nasion = midline(34, 'min') || A.landmarks.rhinion;
  A.landmarks.pogonion = midline(-62, 'max') || A.landmarks.subnasale;
  const ny = tip.y + 36 * u;
  for (const [k, sx] of [['pupil_r', -1], ['pupil_l', 1]]) {
    const b = nearestVertex(new THREE.Vector3(sx * 31 * u, ny, tip.z), (x, y, z) => Math.sign(x) === sx && Math.abs(Math.abs(x) - 31 * u) < 8 * u && Math.abs(y - ny) < 8 * u && z > tip.z - 40 * u);
    if (b) A.landmarks[k] = b;
  }
  rebuildLandmarkSprites(); A.onLandmarks();
}
A.startLandmarks = function () { A.landmarkStep = 0; A.setTool('landmark'); A.onLandmarks(); };
A.skipLandmark = function () { if (A.landmarkStep >= 0) { A.landmarkStep++; if (A.landmarkStep >= LANDMARK_NAMES.length) A.landmarkStep = -1; A.onLandmarks(); } };
A.finishLandmarks = function () { A.landmarkStep = -1; A.onLandmarks(); };
A.currentLandmarkName = () => (A.landmarkStep >= 0 ? LANDMARK_NAMES[A.landmarkStep] : null);
function placeLandmark(part, vi) {
  const name = A.currentLandmarkName() || A.pickNearestLandmarkName(part, vi);
  if (!name) return;
  A.landmarks[name] = { part, vi };
  if (A.landmarkStep >= 0) { A.landmarkStep++; if (A.landmarkStep >= LANDMARK_NAMES.length) A.landmarkStep = -1; }
  rebuildLandmarkSprites(); A.onLandmarks(); A.onDirty();
}
A.pickNearestLandmarkName = function (part, vi) {
  const p = parts()[part], a = p.cur, x = a[vi * 3], y = a[vi * 3 + 1], z = a[vi * 3 + 2];
  let best = null, bd = Infinity;
  for (const n of LANDMARK_NAMES) { const r = A.landmarks[n]; if (!r) return n; const q = parts()[r.part].cur, d = (q[r.vi * 3] - x) ** 2 + (q[r.vi * 3 + 1] - y) ** 2 + (q[r.vi * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
};
A.landmarkPoint = function (name) { const r = A.landmarks[name]; return r ? vertexPos(r, 'after') : null; };
A.landmarkNormal = function (name) { const r = A.landmarks[name]; if (!r) return null; const n = parts()[r.part].geo.attributes.normal.array, k = r.vi * 3; return new THREE.Vector3(n[k], n[k + 1], n[k + 2]).normalize(); };
const landmarkSprites = [];
function rebuildLandmarkSprites() {
  landmarkSprites.forEach(s => { landmarkGroup.remove(s); s.material.map.dispose(); s.material.dispose(); });
  landmarkSprites.length = 0;
  for (const name of LANDMARK_NAMES) {
    if (!A.landmarks[name]) continue;
    const short = { pupil_r: 'R pupil', pupil_l: 'L pupil', nasion: 'Nasion', rhinion: 'Rhinion', pronasale: 'Tip', subnasale: 'Subnasale', pogonion: 'Chin' }[name];
    const { t, w } = labelTexture(name.endsWith('_r') ? short + ' ●' : '● ' + short);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
    s.scale.set(0.0017 * w, 0.0017 * 44, 1); s.renderOrder = 22; s.userData.name = name; s.center.set(0.05, name.endsWith('_r') ? 0.5 : name === 'pronasale' || name === 'nasion' ? 0.5 : 0.5);
    if (name.endsWith('_r')) s.center.set(0.95, 0.5); // right-side labels hang to the left of the point
    landmarkGroup.add(s); landmarkSprites.push(s);
  }
}
function updateLandmarkSprites() { for (const s of landmarkSprites) { const p = A.landmarkPoint(s.userData.name); if (p) s.position.copy(p); } }
A.setShowLandmarks = on => { A.showLandmarks = !!on; };

/* ───────────── Autopilot: apply anatomical pushes ─────────────
   A push moves the surface around a point: { point: Vector3, dir: Vector3 (unit), mm, radiusMm, sign }.
   Direction 'normal' uses the local surface normal. All pushes of one plan form a single undo step. */
let anim = null;
function stepAnimation() {
  if (!anim) return;
  const t = Math.min(1, (performance.now() - anim.t0) / anim.dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  parts().forEach((p, pi) => { const from = anim.from[pi], disp = p.geo.attributes.position.array; for (let i = 0; i < disp.length; i++) disp[i] = from[i] + (p.cur[i] - from[i]) * e; commitPart(p); });
  if (t >= 1) anim = null;
}
A.applyPushes = function (pushes, opts = {}) {
  if (!pushes.length) return { applied: 0 };
  const from = parts().map(p => p.geo.attributes.position.array.slice());
  const touched = {}; let applied = 0;
  const touchLocal = (p, pi, i) => { const t = touched[pi] || (touched[pi] = { part: pi, seen: new Uint8Array(p.n), idx: [], old: [] }); if (t.seen[i]) return; t.seen[i] = 1; t.idx.push(i); t.old.push(p.cur[i * 3], p.cur[i * 3 + 1], p.cur[i * 3 + 2]); };
  for (const push of pushes) {
    const r = A.mmToUnits(push.radiusMm), r2 = r * r, amount = A.mmToUnits(push.mm), c = push.point;
    const dir = push.dir.clone().normalize();
    parts().forEach((p, pi) => {
      const cur = p.cur, n = p.geo.attributes.normal.array;
      for (let i = 0; i < p.n; i++) {
        const o = i * 3, dx = cur[o] - c.x, dy = cur[o + 1] - c.y, dz = cur[o + 2] - c.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const q = 1 - d2 / r2, f = q * q * amount;
        touchLocal(p, pi, i);
        if (push.mode === 'smooth') {
          const a0 = p.adj.start[i], a1 = p.adj.start[i + 1]; if (a1 === a0) continue;
          let ax = 0, ay = 0, az = 0; for (let a = a0; a < a1; a++) { const j = p.adj.list[a] * 3; ax += cur[j]; ay += cur[j + 1]; az += cur[j + 2]; }
          const inv = 1 / (a1 - a0), w = q * q * Math.min(1, push.mm);
          cur[o] += (ax * inv - cur[o]) * w; cur[o + 1] += (ay * inv - cur[o + 1]) * w; cur[o + 2] += (az * inv - cur[o + 2]) * w;
        } else if (push.mode === 'restore') {
          const w = q * q * Math.min(1, push.mm);
          for (let k = 0; k < 3; k++) cur[o + k] += (p.base[o + k] - cur[o + k]) * w;
        } else if (push.useNormal) {
          cur[o] += n[o] * f; cur[o + 1] += n[o + 1] * f; cur[o + 2] += n[o + 2] * f;
        } else {
          cur[o] += dir.x * f; cur[o + 1] += dir.y * f; cur[o + 2] += dir.z * f;
        }
      }
    });
    applied++;
  }
  for (const p of parts()) p.geo.computeVertexNormals();
  const entries = Object.values(touched).map(t => ({ part: t.part, idx: Uint32Array.from(t.idx), old: Float32Array.from(t.old) })).filter(t => t.idx.length);
  if (entries.length) { A.history.push(entries); if (A.history.length > HISTORY_LIMIT) A.history.shift(); A.redo = []; }
  A.morph = 1;
  if (opts.animate !== false) anim = { from, t0: performance.now(), dur: 700 }; else commit();
  A.onHistory(); A.onDirty();
  return { applied };
};

/* ───────────── Versions ("Morph 1", "Morph 2"…) ─────────────
   A version snapshot is the sculpted position array of every part; the reference
   (what "before" shows) can be the original model or any saved version. */
A.captureState = function () { return parts().map(p => p.cur.slice()); };
A.applyState = function (arrays, opts = {}) {
  if (!arrays || arrays.length !== parts().length) return false;
  const entries = parts().map((p, pi) => { const idx = new Uint32Array(p.n); for (let i = 0; i < p.n; i++) idx[i] = i; return { part: pi, idx, old: p.cur.slice() }; });
  parts().forEach((p, pi) => { if (arrays[pi].length === p.cur.length) p.cur.set(arrays[pi]); });
  if (opts.record !== false) { A.history.push(entries); if (A.history.length > HISTORY_LIMIT) A.history.shift(); A.redo = []; }
  A.morph = 1;
  if (opts.animate) anim = { from: parts().map(p => p.geo.attributes.position.array.slice()), t0: performance.now(), dur: 700 }; else commit();
  A.onHistory(); if (opts.record !== false) A.onDirty();
  return true;
};
/* Encode / decode a state as quantised deltas from the base shape (for saving in the case). */
A.encodeState = function (arrays) {
  return arrays.map((arr, pi) => { const p = parts()[pi]; const q = new Int16Array(arr.length); for (let i = 0; i < arr.length; i++) q[i] = clamp(Math.round((arr[i] - p.base[i]) * DISP_Q), -32768, 32767); return { n: p.n, q: DISP_Q, data: b64FromBytes(new Uint8Array(q.buffer)) }; });
};
A.decodeState = function (list) {
  if (!Array.isArray(list) || list.length !== parts().length) return null;
  return list.map((d, pi) => { const p = parts()[pi]; if (!d || d.n !== p.n) return null; const q = new Int16Array(bytesFromB64(d.data).buffer), out = p.base.slice(); for (let i = 0; i < out.length && i < q.length; i++) out[i] = p.base[i] + q[i] / d.q; return out; }).every(Boolean) ? list.map((d, pi) => { const p = parts()[pi]; const q = new Int16Array(bytesFromB64(d.data).buffer), out = p.base.slice(); for (let i = 0; i < out.length && i < q.length; i++) out[i] = p.base[i] + q[i] / d.q; return out; }) : null;
};
/* Reference shape shown as "before": null = original model, else a captured state. */
A.reference = null;
A.setReference = function (arrays) {
  A.reference = arrays && arrays.length === parts().length ? arrays : null;
  parts().forEach((p, pi) => { const arr = p.beforeMesh.geometry.attributes.position.array; arr.set(A.reference ? A.reference[pi] : p.base); p.beforeMesh.geometry.attributes.position.needsUpdate = true; p.beforeMesh.geometry.computeVertexNormals(); });
};
/* Render a snapshot of an arbitrary state without disturbing the current one. */
A.snapshotState = function (arrays, preset, size = 600) {
  const saved = A.captureState(), savedMorph = A.morph;
  parts().forEach((p, pi) => { p.cur.set(arrays[pi]); }); commit();
  const c = A.snapshot('after', preset, size);
  parts().forEach((p, pi) => { p.cur.set(saved[pi]); }); commit(); A.morph = savedMorph;
  return c;
};
A.Vec3 = THREE.Vector3;
window.Avatar3D = A;
window.dispatchEvent(new Event('avatar-ready'));
