/* Morph Studio — 3D avatar module.
   A parametric head mesh textured with the patient's front / profile photos, which the
   surgeon can rotate freely and sculpt. Exposes window.Avatar3D for app.js. */
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const SEG_U = 192, SEG_V = 128, COLS = SEG_U + 1, NV = COLS * (SEG_V + 1);
const TEX = 2048;
const R = { x: 0.72, y: 0.98, z: 0.82 };
const HEAD_V = 0.8;
const DISP_Q = 16000;
const HISTORY_LIMIT = 40;
const GUIDES = [['Brow', 0.24], ['Eyes', 0.09], ['Nose tip', -0.14], ['Mouth', -0.44], ['Chin', -0.86]];
const PRESETS = { front: 0, rightQ: -40, right: -90, leftQ: 40, left: 90 };
const DEFAULT_SKIN = [214, 172, 152];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ───────────── Head shape ───────────── */
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
    dz += 0.035 * gauss(y - 0.24, 0.05) * smooth(0.55, 0.15, ax);          // brow ridge
    dz -= 0.045 * gauss(ax - 0.26, 0.09) * gauss(y - 0.09, 0.055);         // eye sockets
    dz += 0.03 * gauss(ax - 0.42, 0.1) * gauss(y + 0.02, 0.09);            // cheekbones
    dz += 0.03 * gauss(y + 0.44, 0.045) * smooth(0.28, 0.1, ax);           // lips
    dz += 0.07 * gauss(x, 0.14) * gauss(y + 0.82, 0.09);                   // chin
    z += dz * facing;
  }
  out.set(x, y, z);
}
function buildBase() {
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
  return { pos, uv, idx };
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
  onDirty: () => {}, onHistory: () => {}, onPins: () => {}, onStatus: () => {},
  GUIDES, PRESETS,
};
let stage, renderer, scene, camera, controls, afterMesh, beforeMesh, geo, beforeGeo, material, texture, texCanvas;
let base, cur, disp, ring, pinGroup, off, loopOn = false;
let stroke = null, hoverHit = null;
const raycaster = new THREE.Raycaster();
const pointerIds = new Set();
const pinSprites = [];

/* ───────────── Init ───────────── */
A.init = function (stageEl) {
  stage = stageEl;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) { A.error = 'WebGL is not available in this browser.'; A.ready = true; return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0xd9dee5, 1);
  renderer.domElement.id = 'gl';
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none';
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, -0.1, 4.8);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8e98a3, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(0.9, 1.1, 2.2); camera.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35); rim.position.set(-2, 1, -2); scene.add(rim);

  const b = buildBase();
  base = b.pos; cur = base.slice(); disp = base.slice();
  geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(b.idx, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(disp, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  geo.computeVertexNormals();
  beforeGeo = new THREE.BufferGeometry();
  beforeGeo.setIndex(new THREE.BufferAttribute(b.idx, 1));
  beforeGeo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  beforeGeo.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  beforeGeo.computeVertexNormals();

  texCanvas = document.createElement('canvas'); texCanvas.width = texCanvas.height = TEX;
  texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.82, metalness: 0 });
  afterMesh = new THREE.Mesh(geo, material); scene.add(afterMesh);
  beforeMesh = new THREE.Mesh(beforeGeo, material); scene.add(beforeMesh);

  ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
  ring.renderOrder = 10; ring.visible = false; scene.add(ring);
  pinGroup = new THREE.Group(); scene.add(pinGroup);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.15, 0);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.minDistance = 1.6; controls.maxDistance = 14;
  controls.autoRotateSpeed = 1.6;
  controls.update();

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('pointerleave', () => { hoverHit = null; ring.visible = false; });

  A.setTool('orbit');
  bake();
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

/* ───────────── Rendering ───────────── */
function updatePins() {
  const n = geo.attributes.normal.array;
  A.pins.forEach((p, i) => {
    const s = pinSprites[i]; if (!s) return;
    const k = p.vi * 3;
    s.position.set(disp[k] + n[k] * 0.05, disp[k + 1] + n[k + 1] * 0.05, disp[k + 2] + n[k + 2] * 0.05);
  });
}
function frame() {
  controls.autoRotate = A.autoRotate;
  controls.update();
  updatePins();
  const w = renderer.domElement.width / renderer.getPixelRatio(), h = renderer.domElement.height / renderer.getPixelRatio();
  const showAfter = !A.showBefore;
  if (A.compare === 'side' && !A.showBefore) {
    renderer.setScissorTest(true);
    camera.aspect = (w / 2) / h; camera.updateProjectionMatrix();
    beforeMesh.visible = true; afterMesh.visible = false; pinGroup.visible = false; ring.visible = false;
    renderer.setViewport(0, 0, w / 2, h); renderer.setScissor(0, 0, w / 2, h); renderer.render(scene, camera);
    beforeMesh.visible = false; afterMesh.visible = true; pinGroup.visible = true; ring.visible = !!hoverHit && isSculpt();
    renderer.setViewport(w / 2, 0, w / 2, h); renderer.setScissor(w / 2, 0, w / 2, h); renderer.render(scene, camera);
    renderer.setScissorTest(false);
  } else {
    camera.aspect = w / h; camera.updateProjectionMatrix();
    beforeMesh.visible = !showAfter; afterMesh.visible = showAfter; pinGroup.visible = showAfter;
    ring.visible = showAfter && !!hoverHit && isSculpt() && !stroke;
    renderer.setViewport(0, 0, w, h); renderer.render(scene, camera);
  }
  afterMesh.visible = true; beforeMesh.visible = true;
}
const isSculpt = () => ['grab', 'add', 'sub', 'smooth', 'restore'].includes(A.tool);

/* ───────────── Camera / view ───────────── */
A.setView = function (preset) {
  const az = (PRESETS[preset] ?? 0) * Math.PI / 180, d = camera.position.distanceTo(controls.target) || 4.8;
  camera.position.set(controls.target.x + d * Math.sin(az), controls.target.y + d * 0.06, controls.target.z + d * Math.cos(az));
  controls.update();
};
A.resetView = function () { controls.target.set(0, -0.15, 0); camera.position.set(0, -0.1, 4.8); controls.update(); };
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
  if (renderer) renderer.domElement.style.cursor = orbit ? 'grab' : t === 'note' ? 'crosshair' : 'none';
  if (!isSculpt()) ring.visible = false;
};

/* ───────────── Morph amount ───────────── */
A.setMorph = function (t) {
  A.morph = t;
  if (t >= 1) disp.set(cur);
  else for (let i = 0; i < disp.length; i++) disp[i] = base[i] + (cur[i] - base[i]) * t;
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
};
function commit() { A.morph = 1; disp.set(cur); geo.attributes.position.needsUpdate = true; geo.computeVertexNormals(); }
A.hasEdits = function () { for (let i = 0; i < cur.length; i++) if (cur[i] !== base[i]) return true; return false; };

/* ───────────── Picking ───────────── */
function ndcFromEvent(e) {
  const r = renderer.domElement.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (A.compare === 'side' && !A.showBefore) { if (x < 0.5) return null; x = (x - 0.5) * 2; }
  return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
}
function raycastNdc(ndc) {
  if (!ndc) return null;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(afterMesh, false);
  return hits.length ? hits[0] : null;
}
function closestVertex(hit) {
  const f = hit.face, p = hit.point; let best = f.a, bd = Infinity;
  for (const vi of [f.a, f.b, f.c]) {
    const d = (disp[vi * 3] - p.x) ** 2 + (disp[vi * 3 + 1] - p.y) ** 2 + (disp[vi * 3 + 2] - p.z) ** 2;
    if (d < bd) { bd = d; best = vi; }
  }
  return best;
}
function placeRing(hit) {
  ring.position.copy(hit.point);
  const n = hit.face.normal.clone();
  ring.lookAt(hit.point.clone().add(n));
  ring.scale.setScalar(A.brush);
}

/* ───────────── Sculpting ───────────── */
function affected(center, sign) {
  const idx = [], f = [], r = A.brush, r2 = r * r, cx = center.x * sign, cy = center.y, cz = center.z;
  for (let i = 0; i < NV; i++) {
    const dx = cur[i * 3] - cx, dy = cur[i * 3 + 1] - cy, dz = cur[i * 3 + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const q = 1 - d2 / r2; idx.push(i); f.push(q * q);
  }
  return { idx, f, sign };
}
function groupsFor(point) {
  const g = [affected(point, 1)];
  if (A.symmetry && Math.abs(point.x) > 0.012) g.push(affected(point, -1));
  return g;
}
function applyContinuous(point) {
  const k = A.strength, n = geo.attributes.normal.array, tool = A.tool;
  for (const g of groupsFor(point)) {
    for (let m = 0; m < g.idx.length; m++) {
      const i = g.idx[m], f = g.f[m], o = i * 3;
      if (tool === 'add' || tool === 'sub') {
        const s = (tool === 'add' ? 1 : -1) * f * k * 0.004;
        cur[o] += n[o] * s; cur[o + 1] += n[o + 1] * s; cur[o + 2] += n[o + 2] * s;
      } else if (tool === 'smooth') {
        const col = i % COLS, row = (i - col) / COLS;
        const l = col > 0 ? i - 1 : i, r = col < SEG_U ? i + 1 : i, u = row > 0 ? i - COLS : i, d = row < SEG_V ? i + COLS : i;
        const a = f * k * 0.25;
        for (let c = 0; c < 3; c++) {
          const avg = (cur[l * 3 + c] + cur[r * 3 + c] + cur[u * 3 + c] + cur[d * 3 + c]) / 4;
          cur[o + c] += (avg - cur[o + c]) * a;
        }
      } else if (tool === 'restore') {
        const a = f * k * 0.12;
        for (let c = 0; c < 3; c++) cur[o + c] += (base[o + c] - cur[o + c]) * a;
      }
    }
  }
  commit();
}
function applyGrab(delta) {
  const k = A.strength, s = stroke.before;
  for (const g of stroke.groups) {
    for (let m = 0; m < g.idx.length; m++) {
      const i = g.idx[m], f = g.f[m] * k, o = i * 3;
      cur[o] = s[o] + delta.x * g.sign * f; cur[o + 1] = s[o + 1] + delta.y * f; cur[o + 2] = s[o + 2] + delta.z * f;
    }
  }
  commit();
}
function onDown(e) {
  pointerIds.add(e.pointerId);
  if (pointerIds.size > 1) { endStroke(); return; }
  if (e.button !== 0) return;
  const ndc = ndcFromEvent(e); if (!ndc) return;
  // Pins can be selected with any tool.
  raycaster.setFromCamera(ndc, camera);
  const ph = raycaster.intersectObjects(pinSprites, false);
  if (ph.length) { A.selectPin(pinSprites.indexOf(ph[0].object)); return; }
  if (A.tool === 'orbit' || A.showBefore) return;
  const hit = raycastNdc(ndc); if (!hit) return;
  if (A.tool === 'note') { e.preventDefault(); addPin(closestVertex(hit)); return; }
  renderer.domElement.setPointerCapture(e.pointerId);
  if (A.morph < 1) A.setMorph(1);
  stroke = { ndc, before: cur.slice(), raf: 0 };
  if (A.tool === 'grab') {
    stroke.groups = groupsFor(hit.point);
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
    if (stroke.groups && ndc) {
      raycaster.setFromCamera(ndc, camera);
      const p = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(stroke.plane, p)) applyGrab(p.sub(stroke.origin));
    }
    return;
  }
  if (isSculpt() || A.tool === 'note') {
    const hit = raycastNdc(ndc);
    hoverHit = hit;
    if (hit) placeRing(hit);
  }
}
function onUp(e) { pointerIds.delete(e.pointerId); if (stroke) endStroke(); }
function endStroke() {
  if (!stroke) return;
  cancelAnimationFrame(stroke.raf);
  let changed = false;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== stroke.before[i]) { changed = true; break; }
  if (changed) {
    A.history.push(stroke.before); if (A.history.length > HISTORY_LIMIT) A.history.shift();
    A.redo = []; A.onHistory(); A.onDirty();
  }
  stroke = null;
}
A.undo = function () { if (!A.history.length) return; A.redo.push(cur.slice()); cur.set(A.history.pop()); commit(); A.onHistory(); A.onDirty(); };
A.redoStep = function () { if (!A.redo.length) return; A.history.push(cur.slice()); cur.set(A.redo.pop()); commit(); A.onHistory(); A.onDirty(); };
A.reset = function () { A.history.push(cur.slice()); cur.set(base); A.redo = []; commit(); A.onHistory(); A.onDirty(); };
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
function addPin(vi) { A.pins.push({ vi, text: '' }); A.selectedPin = A.pins.length - 1; rebuildPinSprites(); A.onPins(true); A.onDirty(); }
A.selectPin = i => { A.selectedPin = i; rebuildPinSprites(); A.onPins(false); };
A.deletePin = i => { A.pins.splice(i, 1); A.selectedPin = -1; rebuildPinSprites(); A.onPins(false); A.onDirty(); };

/* ───────────── Photos & texture bake ───────────── */
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
  const bp = beforeGeo.attributes.position.array, bn = beforeGeo.attributes.normal.array;
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

/* Outline of the head for the alignment overlay, in head units ([X, Y] pairs). */
A.silhouette = function (role) {
  const pts = [];
  if (role === 'front') {
    // Every mesh row has a constant height, so the outline is the widest point of each row.
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
  const savedPos = camera.position.clone(), savedQuat = camera.quaternion.clone(), savedAspect = camera.aspect;
  const savedMorph = A.morph;
  if (preset && preset !== 'current') {
    const az = (PRESETS[preset] ?? 0) * Math.PI / 180, d = 4.8;
    camera.position.set(controls.target.x + d * Math.sin(az), controls.target.y + d * 0.06, controls.target.z + d * Math.cos(az));
    camera.lookAt(controls.target);
  }
  camera.aspect = 1; camera.updateProjectionMatrix();
  if (savedMorph < 1) A.setMorph(1);
  beforeMesh.visible = kind === 'before'; afterMesh.visible = kind !== 'before'; pinGroup.visible = kind !== 'before'; ring.visible = false;
  off.render(scene, camera);
  const c = document.createElement('canvas'); c.width = c.height = size; c.getContext('2d').drawImage(off.domElement, 0, 0);
  beforeMesh.visible = afterMesh.visible = true;
  camera.position.copy(savedPos); camera.quaternion.copy(savedQuat); camera.aspect = savedAspect; camera.updateProjectionMatrix();
  if (savedMorph < 1) A.setMorph(savedMorph);
  return c;
};

/* ───────────── Save / restore ───────────── */
function b64FromBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b64) { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
A.serialize = function (viewIndex) {
  let disp = null;
  if (A.hasEdits()) {
    const q = new Int16Array(cur.length);
    for (let i = 0; i < cur.length; i++) q[i] = clamp(Math.round((cur[i] - base[i]) * DISP_Q), -32768, 32767);
    disp = { segU: SEG_U, segV: SEG_V, q: DISP_Q, data: b64FromBytes(new Uint8Array(q.buffer)) };
  }
  const roles = {};
  for (const r of ['front', 'right', 'left']) roles[r] = A.photos[r] ? { view: viewIndex(A.photos[r]), align: A.align[r] } : null;
  return { roles, disp, pins: A.pins.map(p => ({ ...p })) };
};
A.restore = function (data, viewAt) {
  A.history = []; A.redo = []; cur.set(base);
  A.pins = []; A.selectedPin = -1;
  for (const r of ['front', 'right', 'left']) { A.photos[r] = null; A.align[r] = null; }
  if (data) {
    for (const r of ['front', 'right', 'left']) {
      const d = data.roles && data.roles[r], v = d ? viewAt(d.view) : null;
      if (v) { A.photos[r] = v; A.align[r] = d.align && typeof d.align.s === 'number' ? { ...d.align } : A.defaultAlign(v); }
    }
    if (data.disp && data.disp.segU === SEG_U && data.disp.segV === SEG_V) {
      const q = new Int16Array(bytesFromB64(data.disp.data).buffer);
      for (let i = 0; i < cur.length && i < q.length; i++) cur[i] = base[i] + q[i] / data.disp.q;
    }
    A.pins = (data.pins || []).filter(p => Number.isInteger(p.vi) && p.vi >= 0 && p.vi < NV).map(p => ({ vi: p.vi, text: String(p.text || '') }));
  }
  commit(); rebuildPinSprites(); bake(); A.onHistory(); A.onPins(false);
};
A.dropView = function (view) {
  let changed = false;
  for (const r of ['front', 'right', 'left']) if (A.photos[r] === view) { A.photos[r] = null; A.align[r] = null; changed = true; }
  if (changed) bake();
};

window.Avatar3D = A;
window.dispatchEvent(new Event('avatar-ready'));
