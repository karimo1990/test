/* Morph Studio — before / after photo simulation for facial surgery consultations.
   Everything runs in the browser. Photos never leave the device. No dependencies. */
(() => {
'use strict';

/* ───────────────────────── Constants ───────────────────────── */
const MAX_SIDE = 1100;          // working resolution (long side, px)
const DISP_SCALE = 2;           // displacement field is saved at 1/2 resolution
const DISP_Q = 16;              // …quantised to 1/16 px
const HISTORY_LIMIT = 40;
const SIDE_GAP = 0.03;          // gap between images in side-by-side mode (fraction of width)
const DEFAULT_VIEW_NAMES = ['Front', 'Right profile', 'Left profile', 'Oblique'];
const PROCEDURES = [
  'Rhinoplasty', 'Septorhinoplasty', 'Revision rhinoplasty', 'Chin augmentation (genioplasty)',
  'Facelift', 'Neck lift', 'Blepharoplasty (eyelids)', 'Brow lift', 'Otoplasty (ears)',
  'Lip augmentation', 'Cheek augmentation', 'Buccal fat removal', 'Jawline contouring', 'Other',
];
const DEFAULT_DISCLAIMER =
  'This image is a computer-assisted illustration produced during consultation to help discuss goals. ' +
  'It is not a guarantee, promise or prediction of the result of surgery. Actual outcomes depend on ' +
  'individual anatomy, healing and other factors and may differ from this simulation.';

/* ───────────────────────── Helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ───────────────────────── State ───────────────────────── */
const state = {
  patient: { name: '', ref: '', date: today(), procedure: 'Rhinoplasty', other: '' },
  notes: { plan: '', consultation: '', disclaimer: DEFAULT_DISCLAIMER },
  docs: [],
  views: [],
  current: -1,
  tool: 'push',
  brush: 60,
  strength: 50,
  morph: 1,
  compare: 'slider',
  divider: 0.5,
  fade: 1,
  zoom: 1, panX: 0, panY: 0,
  showBefore: false,
  selectedPin: -1,
  mode: '2d',
};

const el = {
  stage: $('#stage'), canvas: $('#canvas'), empty: $('#empty'), divider: $('#divider'),
  viewTabs: $('#viewTabs'), filePhotos: $('#filePhotos'), fileCase: $('#fileCase'),
  brush: $('#brush'), brushVal: $('#brushVal'), strength: $('#strength'), strengthVal: $('#strengthVal'),
  morph: $('#morph'), morphVal: $('#morphVal'), fade: $('#fade'), fadeWrap: $('#fadeWrap'),
  zoomVal: $('#zoomVal'), pinList: $('#pinList'), pinCount: $('#pinCount'), pinHint: $('#pinHint'), status: $('#status'),
  pName: $('#pName'), pRef: $('#pRef'), pDate: $('#pDate'), pProc: $('#pProc'), pOther: $('#pOther'), pOtherWrap: $('#pOtherWrap'),
  nConsult: $('#nConsult'), nPlan: $('#nPlan'), nDisclaimer: $('#nDisclaimer'),
  btnUndo: $('#btnUndo'), btnRedo: $('#btnRedo'), printArea: $('#printArea'),
  brush3d: $('#brush3d'), brush3dVal: $('#brush3dVal'), symmetry: $('#symmetry'), autoRotate: $('#autoRotate'), hint3d: $('#hint3d'),
  alignModal: $('#alignModal'), alignCanvas: $('#alignCanvas'), alignTitle: $('#alignTitle'), alignSize: $('#alignSize'), alignFlip: $('#alignFlip'),
  docs: $('#docs'), docList: $('#docList'), docCount: $('#docCount'), fileDocs: $('#fileDocs'),
  fileModel: $('#fileModel'), modelStatus: $('#modelStatus'), btnRemoveModel: $('#btnRemoveModel'), turnRow: $('#turnRow'), photoRoles: $('#photoRoles'),
  scaleStatus: $('#scaleStatus'), measureList: $('#measureList'), btnClearMeasures: $('#btnClearMeasures'), scalebar: $('#scalebar'),
  docModal: $('#docModal'), docTitle: $('#docTitle'), docBody: $('#docBody'), docDownload: $('#docDownload'),
};
const is3d = () => state.mode === '3d';
const AV = () => window.Avatar3D;
const avatarReady = new Promise(res => { if (window.Avatar3D) res(); else window.addEventListener('avatar-ready', res, { once: true }); });
let avatarInited = false;
async function ensureAvatar() {
  await avatarReady;
  if (!avatarInited) {
    avatarInited = true;
    const A = AV();
    A.onDirty = markDirty; A.onHistory = updateHistoryButtons; A.onStatus = setStatus;
    A.onPins = focus => { if (is3d()) { renderPinList(); if (focus) focusPin(A.selectedPin); } };
    A.onModel = () => { renderModelPanel(); renderRoleSelects(); updateBrushLabel(); };
    A.onMeasure = () => renderMeasures();
    A.onLandmarks = () => { renderApLandmarks(); renderLmPrompt(); };
    A.init(el.stage);
    A.brush = +el.brush3d.value / 100; A.strength = state.strength / 100; A.symmetry = el.symmetry.checked;
    renderModelPanel(); renderMeasures(); updateBrushLabel();
  }
  return AV();
}
const ctx = el.canvas.getContext('2d');

const currentView = () => state.views[state.current] || null;

/* ───────────────────────── Views (one per photo) ───────────────────────── */
function createView(name, image) {
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * scale)), H = Math.max(1, Math.round(ih * scale));

  const before = document.createElement('canvas');
  before.width = W; before.height = H;
  const bctx = before.getContext('2d');
  bctx.drawImage(image, 0, 0, W, H);

  const after = document.createElement('canvas');
  after.width = W; after.height = H;
  const actx = after.getContext('2d');
  actx.drawImage(before, 0, 0);

  return {
    name, W, H, before, after, actx,
    src: bctx.getImageData(0, 0, W, H).data,
    out: actx.getImageData(0, 0, W, H),
    dx: new Float32Array(W * H), dy: new Float32Array(W * H),
    pins: [], history: [], redo: [], preStroke: null, strokeBox: null,
    landmarks: null, kind: '', mm: 0,
  };
}

/* Render out(x,y) = src(x + dx*t, y + dy*t) for a rectangle, with bilinear sampling. */
function renderRegion(v, x0, y0, x1, y1, t = 1) {
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  x1 = Math.min(v.W, Math.ceil(x1)); y1 = Math.min(v.H, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const { W, H, src, dx, dy } = v, out = v.out.data, maxX = W - 1, maxY = H - 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      let sx = x + dx[i] * t, sy = y + dy[i] * t;
      if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
      const fx = sx | 0, fy = sy | 0;
      const cx = fx < maxX ? fx + 1 : fx, cy = fy < maxY ? fy + 1 : fy;
      const ax = sx - fx, ay = sy - fy;
      const i00 = (fy * W + fx) * 4, i10 = (fy * W + cx) * 4, i01 = (cy * W + fx) * 4, i11 = (cy * W + cx) * 4;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      const o = i * 4;
      out[o]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  v.actx.putImageData(v.out, 0, 0, x0, y0, x1 - x0, y1 - y0);
}
const renderAll = (v, t = 1) => renderRegion(v, 0, 0, v.W, v.H, t);

/* One brush application. (mx,my) is the pointer movement for the push tool.
   Content moved by v means new D(p) = D_old(p - v) - v, so strokes compose correctly. */
function dab(v, cx, cy, mx, my, opts) {
  const { W, H, dx, dy } = v;
  const r = opts && opts.r ? opts.r : state.brush, r2 = r * r, k = opts && opts.k != null ? opts.k : state.strength / 100, tool = opts && opts.tool ? opts.tool : state.tool;
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, maxX = W - 1, maxY = H - 1;
  const tdx = new Float32Array(bw * bh), tdy = new Float32Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    const py = y - cy;
    for (let x = x0; x <= x1; x++) {
      const px = x - cx, d2 = px * px + py * py;
      const i = y * W + x, ti = (y - y0) * bw + (x - x0);
      if (d2 >= r2) { tdx[ti] = dx[i]; tdy[ti] = dy[i]; continue; }
      const q = 1 - d2 / r2, f = q * q;
      let vx, vy;
      if (tool === 'push') { vx = mx * f * k; vy = my * f * k; }
      else if (tool === 'shrink') { vx = -px * f * k * 0.03; vy = -py * f * k * 0.03; }
      else if (tool === 'expand') { vx = px * f * k * 0.03; vy = py * f * k * 0.03; }
      else { const a = 1 - f * k * 0.12; tdx[ti] = dx[i] * a; tdy[ti] = dy[i] * a; continue; }
      const sx = clamp(x - vx, 0, maxX), sy = clamp(y - vy, 0, maxY);
      const fx = sx | 0, fy = sy | 0, cx1 = fx < maxX ? fx + 1 : fx, cy1 = fy < maxY ? fy + 1 : fy;
      const ax = sx - fx, ay = sy - fy;
      const i00 = fy * W + fx, i10 = fy * W + cx1, i01 = cy1 * W + fx, i11 = cy1 * W + cx1;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      tdx[ti] = dx[i00] * w00 + dx[i10] * w10 + dx[i01] * w01 + dx[i11] * w11 - vx;
      tdy[ti] = dy[i00] * w00 + dy[i10] * w10 + dy[i01] * w01 + dy[i11] * w11 - vy;
    }
  }
  for (let y = 0; y < bh; y++) {
    dx.set(tdx.subarray(y * bw, (y + 1) * bw), (y + y0) * W + x0);
    dy.set(tdy.subarray(y * bw, (y + 1) * bw), (y + y0) * W + x0);
  }
  const b = v.strokeBox;
  if (!b) v.strokeBox = { x0, y0, x1, y1 };
  else { b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1); }
  renderRegion(v, x0, y0, x1 + 1, y1 + 1, 1);
}

function pushMove(v, a, b) {
  const ddx = b.x - a.x, ddy = b.y - a.y, dist = Math.hypot(ddx, ddy);
  if (dist === 0) return;
  const steps = Math.max(1, Math.ceil(dist / Math.max(2, state.brush * 0.2)));
  for (let i = 1; i <= steps; i++) {
    dab(v, a.x + ddx * i / steps, a.y + ddy * i / steps, ddx / steps, ddy / steps);
  }
}

/* ───────────────────────── Undo / redo ───────────────────────── */
function copyRegion(src, W, b) {
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(src.subarray((b.y0 + y) * W + b.x0, (b.y0 + y) * W + b.x0 + w), y * w);
  return out;
}
function pasteRegion(dst, W, b, data) {
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
  for (let y = 0; y < h; y++) dst.set(data.subarray(y * w, (y + 1) * w), (b.y0 + y) * W + b.x0);
}
function snapshot(v, b) { return { b: { ...b }, dx: copyRegion(v.dx, v.W, b), dy: copyRegion(v.dy, v.W, b) }; }
function applySnapshot(v, s) {
  pasteRegion(v.dx, v.W, s.b, s.dx); pasteRegion(v.dy, v.W, s.b, s.dy);
  renderRegion(v, s.b.x0, s.b.y0, s.b.x1 + 1, s.b.y1 + 1, 1);
}
function undo() {
  if (is3d()) { if (avatarInited) AV().undo(); return; }
  const v = currentView(); if (!v || !v.history.length) return;
  const s = v.history.pop();
  v.redo.push(snapshot(v, s.b));
  applySnapshot(v, s);
  afterEdit();
}
function redo() {
  if (is3d()) { if (avatarInited) AV().redoStep(); return; }
  const v = currentView(); if (!v || !v.redo.length) return;
  const s = v.redo.pop();
  v.history.push(snapshot(v, s.b));
  applySnapshot(v, s);
  afterEdit();
}
function resetView() {
  if (is3d()) { if (avatarInited && AV().hasEdits() && confirm('Remove every edit on the 3D avatar?')) AV().reset(); return; }
  const v = currentView(); if (!v) return;
  if (!confirm(`Remove every edit on "${v.name}"?`)) return;
  v.dx.fill(0); v.dy.fill(0); v.history = []; v.redo = [];
  renderAll(v);
  afterEdit();
}
function updateHistoryButtons() {
  if (is3d()) { const A = avatarInited && AV(); el.btnUndo.disabled = !A || !A.canUndo(); el.btnRedo.disabled = !A || !A.canRedo(); return; }
  const v = currentView();
  el.btnUndo.disabled = !v || !v.history.length;
  el.btnRedo.disabled = !v || !v.redo.length;
}
function afterEdit() { setMorph(1, false); updateHistoryButtons(); draw(); markDirty(); }

/* ───────────────────────── Display ───────────────────────── */
const sideGap = v => Math.round(v.W * SIDE_GAP);
const afterOffset = v => (state.compare === 'side' && !state.showBefore ? v.W + sideGap(v) : 0);
function contentSize(v) { return state.compare === 'side' ? { w: v.W * 2 + sideGap(v), h: v.H } : { w: v.W, h: v.H }; }

function resizeCanvas() {
  const r = el.stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (el.canvas.width !== w || el.canvas.height !== h) { el.canvas.width = w; el.canvas.height = h; }
}
function fit() {
  const v = currentView(); if (!v) return;
  const r = el.stage.getBoundingClientRect(), c = contentSize(v);
  state.zoom = Math.min(r.width / c.w, r.height / c.h) * 0.94;
  state.panX = (r.width - c.w * state.zoom) / 2;
  state.panY = (r.height - c.h * state.zoom) / 2;
  draw();
}
function zoomAt(factor, sx, sy) {
  const z = clamp(state.zoom * factor, 0.05, 12), f = z / state.zoom;
  state.panX = sx - (sx - state.panX) * f;
  state.panY = sy - (sy - state.panY) * f;
  state.zoom = z;
  draw();
}

let hover = null;
function draw() {
  if (is3d()) return;
  resizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  const cw = el.canvas.width / dpr, ch = el.canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const v = currentView();
  el.divider.hidden = !v || state.compare !== 'slider' || state.showBefore;
  el.zoomVal.textContent = Math.round(state.zoom * 100) + '%';
  if (!v) return;

  const { zoom, panX, panY } = state, W = v.W, H = v.H;
  ctx.save();
  ctx.translate(panX, panY); ctx.scale(zoom, zoom);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const mode = state.showBefore ? 'before' : state.compare;
  const labels = [];
  if (mode === 'before') { ctx.drawImage(v.before, 0, 0); labels.push(['Original', 0, 'left']); }
  else if (mode === 'after') { ctx.drawImage(v.after, 0, 0); labels.push(['Simulated', W, 'right']); }
  else if (mode === 'fade') {
    ctx.drawImage(v.before, 0, 0);
    ctx.globalAlpha = state.fade; ctx.drawImage(v.after, 0, 0); ctx.globalAlpha = 1;
    labels.push([`Simulated ${Math.round(state.fade * 100)}%`, W, 'right']);
  } else if (mode === 'side') {
    ctx.drawImage(v.before, 0, 0);
    ctx.drawImage(v.after, W + sideGap(v), 0);
    labels.push(['Before', 0, 'left'], ['Simulated after', W + sideGap(v), 'left']);
  } else {
    const sx = state.divider * W;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip(); ctx.drawImage(v.before, 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); ctx.drawImage(v.after, 0, 0); ctx.restore();
    labels.push(['Before', 0, 'left'], ['Simulated', W, 'right']);
  }
  if (!state.showBefore) { drawPins(v); if (state.tool === 'landmarks' && v.landmarks) drawLandmarks(v); }
  ctx.restore();

  // Labels in screen space
  ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
  ctx.textBaseline = 'top';
  for (const [text, ix, align] of labels) {
    const tw = ctx.measureText(text).width + 14;
    const x = align === 'left' ? panX + ix * zoom + 8 : panX + ix * zoom - 8 - tw;
    const y = panY + 8;
    ctx.fillStyle = 'rgba(22,33,46,.72)'; ctx.fillRect(x, y, tw, 22);
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 7, y + 4);
  }

  // Divider handle
  if (!el.divider.hidden) el.divider.style.left = (panX + state.divider * W * zoom) + 'px';

  // Brush cursor
  if (hover && isPaintTool() && !stroke) drawBrushCursor(v);
}
function drawBrushCursor(v) {
  const x = state.panX + (hover.x + afterOffset(v)) * state.zoom, y = state.panY + hover.y * state.zoom;
  ctx.beginPath(); ctx.arc(x, y, state.brush * state.zoom, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 0.75; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
}
function drawPins(v) {
  const z = state.zoom, r = 12 / z, off = afterOffset(v);
  ctx.font = `700 ${12 / z}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  v.pins.forEach((p, i) => {
    const x = p.x + off, y = p.y, sel = i === state.selectedPin;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = sel ? '#e08a00' : '#0f7f86'; ctx.fill();
    ctx.lineWidth = 2 / z; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), x, y + 0.5 / z);
  });
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

/* ───────────────────────── Pointer input ───────────────────────── */
const pointers = new Map();
let stroke = null, panDrag = null, pinDrag = null, lmDrag = null, pinch = null, spaceHeld = false, anim = false;
const isPaintTool = () => ['push', 'shrink', 'expand', 'restore'].includes(state.tool);

function toImage(e) {
  const v = currentView(), r = el.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - state.panX) / state.zoom - (v ? afterOffset(v) : 0),
    y: (e.clientY - r.top - state.panY) / state.zoom,
  };
}
function hitPin(v, p) {
  const r = 14 / state.zoom;
  for (let i = v.pins.length - 1; i >= 0; i--) if (Math.hypot(v.pins[i].x - p.x, v.pins[i].y - p.y) <= r) return i;
  return -1;
}
function onDown(e) {
  const v = currentView(); if (!v) return;
  el.canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    endStroke(); panDrag = null; pinDrag = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom, panX: state.panX, panY: state.panY, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (pointers.size > 2) return;
  const p = toImage(e);
  if (e.button === 1 || state.tool === 'hand' || spaceHeld && state.tool !== 'annotate') {
    if (spaceHeld && state.tool !== 'hand') return; // Space is "peek", not pan, unless Move tool
    panDrag = { sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    return;
  }
  if (e.button !== 0) return;
  if (state.tool === 'landmarks') {
    if (!v.landmarks) ensureLandmarks(v);
    const hit = hitLandmark(v, p);
    if (hit) { lmDrag = { name: hit }; e.preventDefault(); }
    return;
  }
  if (state.tool === 'annotate') {
    e.preventDefault(); // keep focus on the note field we are about to open
    const hit = hitPin(v, p);
    if (hit >= 0) { selectPin(hit); pinDrag = { i: hit }; }
    else if (p.x >= 0 && p.y >= 0 && p.x <= v.W && p.y <= v.H) addPin(v, p);
    return;
  }
  if (state.showBefore) return;
  beginStroke(v, p);
}
function beginStroke(v, p) {
  if (anim) return;
  if (state.morph < 1) setMorph(1, true);
  v.preStroke = { dx: v.dx.slice(), dy: v.dy.slice() };
  v.strokeBox = null;
  stroke = { last: p, cur: p, raf: 0 };
  if (state.tool !== 'push') stroke.raf = requestAnimationFrame(strokeTick);
}
function strokeTick() {
  const v = currentView();
  if (!stroke || !v) return;
  dab(v, stroke.cur.x, stroke.cur.y, 0, 0);
  draw();
  stroke.raf = requestAnimationFrame(strokeTick);
}
function onMove(e) {
  const v = currentView(); if (!v) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const z = clamp(pinch.zoom * d / pinch.dist, 0.05, 12), f = z / pinch.zoom;
    const r = el.canvas.getBoundingClientRect();
    state.panX = (mx - r.left) - ((pinch.mx - r.left) - pinch.panX) * f;
    state.panY = (my - r.top) - ((pinch.my - r.top) - pinch.panY) * f;
    state.zoom = z; draw(); return;
  }
  const p = toImage(e); hover = p;
  if (panDrag) {
    state.panX = panDrag.px + (e.clientX - panDrag.sx);
    state.panY = panDrag.py + (e.clientY - panDrag.sy);
    draw(); return;
  }
  if (pinDrag) {
    v.pins[pinDrag.i].x = clamp(p.x, 0, v.W); v.pins[pinDrag.i].y = clamp(p.y, 0, v.H);
    draw(); return;
  }
  if (lmDrag) { v.landmarks[lmDrag.name] = { x: clamp(p.x, 0, v.W), y: clamp(p.y, 0, v.H) }; draw(); return; }
  if (stroke) {
    if (state.tool === 'push') {
      let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!events.length) events = [e];
      for (const ce of events) { const q = toImage(ce); pushMove(v, stroke.last, q); stroke.last = q; }
      stroke.last = p;
    }
    stroke.cur = p;
    draw(); return;
  }
  if (isPaintTool()) draw();
}
function onUp(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) pinch = null;
  if (panDrag) panDrag = null;
  if (pinDrag) { pinDrag = null; markDirty(); }
  if (lmDrag) { lmDrag = null; markDirty(); renderApLandmarks(); }
  if (stroke) endStroke();
}
function endStroke() {
  if (!stroke) return;
  const v = currentView();
  cancelAnimationFrame(stroke.raf);
  stroke = null;
  if (v && v.strokeBox && v.preStroke) {
    const b = v.strokeBox;
    v.history.push({ b: { ...b }, dx: copyRegion(v.preStroke.dx, v.W, b), dy: copyRegion(v.preStroke.dy, v.W, b) });
    if (v.history.length > HISTORY_LIMIT) v.history.shift();
    v.redo = [];
  }
  if (v) { v.preStroke = null; v.strokeBox = null; }
  updateHistoryButtons(); draw(); markDirty();
}
function onWheel(e) {
  if (!currentView()) return;
  e.preventDefault();
  const r = el.canvas.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}
el.canvas.addEventListener('pointerdown', onDown);
el.canvas.addEventListener('pointermove', onMove);
el.canvas.addEventListener('pointerup', onUp);
el.canvas.addEventListener('pointercancel', onUp);
el.canvas.addEventListener('pointerleave', () => { hover = null; if (!stroke) draw(); });
el.canvas.addEventListener('wheel', onWheel, { passive: false });
el.canvas.addEventListener('contextmenu', e => e.preventDefault());

// Comparison slider handle
let divDrag = false;
el.divider.addEventListener('pointerdown', e => { divDrag = true; el.divider.setPointerCapture(e.pointerId); e.preventDefault(); });
el.divider.addEventListener('pointermove', e => {
  const v = currentView(); if (!divDrag || !v) return;
  const r = el.canvas.getBoundingClientRect();
  state.divider = clamp(((e.clientX - r.left) - state.panX) / state.zoom / v.W, 0, 1);
  draw();
});
el.divider.addEventListener('pointerup', () => { divDrag = false; });
el.divider.addEventListener('pointercancel', () => { divDrag = false; });

/* ───────────────────────── Tools & controls ───────────────────────── */
function setTool(t) {
  state.tool = t;
  $$('#toolGrid button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  el.canvas.style.cursor = isPaintTool() ? 'none' : t === 'hand' ? 'grab' : 'crosshair';
  if (t === 'landmarks') { const v = currentView(); if (v && !v.landmarks) { ensureLandmarks(v); markDirty(); } renderApLandmarks(); }
  draw();
}
$('#toolGrid').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
function setTool3d(t) {
  $$('#toolGrid3d button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  if (avatarInited) { AV().setTool(t); if (t === 'landmark' && AV().landmarkStep < 0 && !AV().landmarksReady()) AV().startLandmarks(); }
  renderLmPrompt();
}
$('#toolGrid3d').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTool3d(b.dataset.tool); });
function updateBrushLabel() { const units = +el.brush3d.value / 100; el.brush3dVal.textContent = avatarInited ? `${Math.round(units * AV().mmPerUnit)} mm` : el.brush3d.value; }
el.brush3d.addEventListener('input', () => { if (avatarInited) AV().brush = +el.brush3d.value / 100; updateBrushLabel(); });
el.symmetry.addEventListener('change', () => { if (avatarInited) AV().symmetry = el.symmetry.checked; });
el.autoRotate.addEventListener('change', () => { if (avatarInited) AV().setAutoRotate(el.autoRotate.checked); });
$('#compare3dSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#compare3dSeg button').forEach(x => x.classList.toggle('active', x === b));
  if (avatarInited) AV().setCompare(b.dataset.compare);
});
$('#viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b && avatarInited) AV().setView(b.dataset.view); });

el.brush.addEventListener('input', () => { state.brush = +el.brush.value; el.brushVal.textContent = el.brush.value; draw(); });
el.strength.addEventListener('input', () => { state.strength = +el.strength.value; el.strengthVal.textContent = el.strength.value; if (avatarInited) AV().strength = state.strength / 100; });

function setMorph(t, render) {
  state.morph = t; el.morph.value = Math.round(t * 100); el.morphVal.textContent = Math.round(t * 100);
  if (is3d()) { if (avatarInited && render) AV().setMorph(t); return; }
  const v = currentView();
  if (v && render) renderAll(v, t);
}
el.morph.addEventListener('input', () => { if (anim) return; setMorph(+el.morph.value / 100, true); draw(); });
$('#btnPlay').addEventListener('click', () => {
  const v = currentView(); if ((!v && !is3d()) || anim) return;
  anim = true; const start = performance.now(), dur = 1800;
  const step = now => {
    let t = clamp((now - start) / dur, 0, 1);
    t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    setMorph(t, true); draw();
    if (t < 1) requestAnimationFrame(step); else anim = false;
  };
  requestAnimationFrame(step);
});

el.btnUndo.addEventListener('click', undo);
el.btnRedo.addEventListener('click', redo);
$('#btnReset').addEventListener('click', resetView);
$('#btnFit').addEventListener('click', () => { if (is3d()) { if (avatarInited) AV().resetView(); } else fit(); });
$('#btnZoomIn').addEventListener('click', () => { if (is3d()) { if (avatarInited) AV().zoomBy(1.25); return; } const r = el.stage.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); });
$('#btnZoomOut').addEventListener('click', () => { if (is3d()) { if (avatarInited) AV().zoomBy(0.8); return; } const r = el.stage.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });

$('#compareSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setCompare(b.dataset.compare);
});
function setCompare(mode) {
  state.compare = mode;
  $$('#compareSeg button').forEach(x => x.classList.toggle('active', x.dataset.compare === mode));
  el.fadeWrap.hidden = mode !== 'fade';
  fit();
}
el.fade.addEventListener('input', () => { state.fade = +el.fade.value / 100; draw(); });

const peek = $('#btnPeek');
const setPeek = on => { if (state.showBefore === on) return; state.showBefore = on; if (avatarInited) AV().setShowBefore(on); draw(); };
peek.addEventListener('pointerdown', e => { e.preventDefault(); setPeek(true); });
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => peek.addEventListener(ev, () => setPeek(false)));

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ': e.preventDefault(); if (!spaceHeld) { spaceHeld = true; setPeek(true); } break;
    case 'p': case 'P': is3d() ? setTool3d('grab') : setTool('push'); break;
    case 's': case 'S': is3d() ? setTool3d('sub') : setTool('shrink'); break;
    case 'e': case 'E': is3d() ? setTool3d('add') : setTool('expand'); break;
    case 'm': case 'M': if (is3d()) setTool3d('smooth'); break;
    case 'r': case 'R': is3d() ? setTool3d('restore') : setTool('restore'); break;
    case 'a': case 'A': is3d() ? setTool3d('note') : setTool('annotate'); break;
    case 'd': case 'D': if (is3d()) setTool3d('measure'); break;
    case 'h': case 'H': is3d() ? setTool3d('orbit') : setTool('hand'); break;
    case 'l': case 'L': if (is3d()) { if (avatarInited) { setTool3d('landmark'); AV().startLandmarks(); } } else setTool('landmarks'); break;
    case 'f': case 'F': $('#btnFit').click(); break;
    case '[': { const r = is3d() ? el.brush3d : el.brush; r.value = +r.value - (is3d() ? 2 : 5); r.dispatchEvent(new Event('input')); break; }
    case ']': { const r = is3d() ? el.brush3d : el.brush; r.value = +r.value + (is3d() ? 2 : 5); r.dispatchEvent(new Event('input')); break; }
    case 'Delete': case 'Backspace': { const sel = pinSource().selected; if (sel >= 0) { e.preventDefault(); deletePin(sel); } break; }
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { spaceHeld = false; setPeek(false); } });
window.addEventListener('blur', () => { spaceHeld = false; setPeek(false); });

/* ───────────────────────── Pins (photo notes) ───────────────────────── */
function addPin(v, p) {
  v.pins.push({ x: p.x, y: p.y, text: '' });
  state.selectedPin = v.pins.length - 1;
  renderPinList(); draw(); markDirty();
  focusPin(state.selectedPin);
}
function focusPin(i) {
  const f = () => { const inp = $(`#pinList .pin[data-i="${i}"] input`); if (inp && document.activeElement !== inp) inp.focus(); };
  f(); setTimeout(f, 0); setTimeout(f, 60);
}
function selectPin(i) {
  if (is3d()) { if (avatarInited) AV().selectPin(i); return; }
  state.selectedPin = i; renderPinList(); draw();
}
function deletePin(i) {
  if (is3d()) { if (avatarInited) AV().deletePin(i); return; }
  const v = currentView(); if (!v) return;
  v.pins.splice(i, 1); state.selectedPin = -1;
  renderPinList(); draw(); markDirty();
}
function pinSource() {
  if (is3d()) return avatarInited ? { pins: AV().pins, selected: AV().selectedPin } : { pins: [], selected: -1 };
  const v = currentView();
  return { pins: v ? v.pins : [], selected: state.selectedPin };
}
function renderPinList() {
  const { pins, selected } = pinSource();
  el.pinList.innerHTML = '';
  el.pinCount.textContent = pins.length ? `(${pins.length})` : '';
  el.pinHint.hidden = pins.length > 0;
  pins.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pin' + (i === selected ? ' selected' : '');
    row.dataset.i = i;
    row.innerHTML = `<span class="num" title="Highlight">${i + 1}</span><input placeholder="Describe this change…" value="${esc(p.text)}"><button class="x" title="Remove note">×</button>`;
    row.querySelector('.num').addEventListener('click', () => selectPin(i));
    row.querySelector('input').addEventListener('focus', () => { if (pinSource().selected !== i) selectPin(i); const inp = $(`#pinList .pin[data-i="${i}"] input`); if (inp && inp !== document.activeElement) inp.focus(); });
    row.querySelector('input').addEventListener('input', ev => { p.text = ev.target.value; markDirty(); });
    row.querySelector('.x').addEventListener('click', () => deletePin(i));
    el.pinList.appendChild(row);
  });
}

/* ───────────────────────── View tabs & photo loading ───────────────────────── */
function renderTabs() {
  el.viewTabs.innerHTML = '';
  state.views.forEach((v, i) => {
    const t = document.createElement('button');
    t.className = 'tab' + (i === state.current ? ' active' : '');
    t.innerHTML = `<span>${esc(v.name)}</span>` + (i === state.current ? `<span class="edit" title="Rename">✎</span>` : '') + `<span class="x" title="Remove photo">×</span>`;
    t.addEventListener('click', e => {
      if (e.target.classList.contains('x')) { removeView(i); return; }
      if (e.target.classList.contains('edit')) { const n = prompt('Photo name', v.name); if (n && n.trim()) { v.name = n.trim(); renderTabs(); markDirty(); } return; }
      selectView(i);
    });
    el.viewTabs.appendChild(t);
  });
  const add = document.createElement('button');
  add.className = 'tab tab-add'; add.textContent = '+ Add photo';
  add.addEventListener('click', () => el.filePhotos.click());
  el.viewTabs.appendChild(add);
  el.empty.style.display = state.views.length ? 'none' : '';
  renderRoleSelects();
}
/* ── 3D avatar photo roles ── */
const ROLES = ['front', 'right', 'left'];
const ROLE_MATCH = { front: /front|face|ap\b/i, right: /right|\br\b/i, left: /left|\bl\b/i };
function renderRoleSelects() {
  for (const role of ROLES) {
    const sel = $(`#role-${role}`); if (!sel) continue;
    const cur = avatarInited ? state.views.indexOf(AV().photos[role]) : -1;
    sel.innerHTML = '<option value="-1">— none —</option>' + state.views.map((v, i) => `<option value="${i}"${i === cur ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
    sel.nextElementSibling.disabled = cur < 0;
  }
  if (avatarInited) {
    const A = AV(), missing = ROLES.filter(r => !A.photos[r]);
    el.hint3d.hidden = !(missing.length === 3) || (A.model && A.model.kind === 'glb');
    el.hint3d.textContent = state.views.length ? 'No photo assigned yet — choose the front and profile photos under "Avatar photos".' : 'Add the patient\'s photos (Photo morph tab or "+ Add photo") to dress the avatar. You can sculpt the generic head right away.';
  }
}
function autoAssignRoles() {
  if (!avatarInited) return false;
  const A = AV(); let changed = false;
  for (const role of ROLES) {
    if (A.photos[role] && state.views.includes(A.photos[role])) continue;
    const v = state.views.find(v => ROLE_MATCH[role].test(v.name) && !ROLES.some(r => A.photos[r] === v));
    if (v) { A.setPhoto(role, v); changed = true; }
  }
  if (changed) { A.rebake(); markDirty(); }
  renderRoleSelects();
  return changed;
}
$$('select[data-role]').forEach(sel => sel.addEventListener('change', async () => {
  const A = await ensureAvatar(), v = state.views[+sel.value] || null;
  A.setPhoto(sel.dataset.role, v, null); A.rebake(); renderRoleSelects(); markDirty();
}));
$$('button[data-align]').forEach(b => b.addEventListener('click', () => openAlign(b.dataset.align)));
function selectView(i) {
  if (i === state.current) return;
  endStroke();
  state.current = i; state.selectedPin = -1;
  const v = currentView();
  if (v) { setMorph(1, false); renderAll(v); }
  renderTabs(); renderPinList(); updateHistoryButtons(); fit(); renderApLandmarks();
}
function removeView(i) {
  const v = state.views[i];
  if (!confirm(`Remove the photo "${v.name}" and its edits from this case?`)) return;
  state.views.splice(i, 1);
  if (avatarInited) AV().dropView(v);
  if (state.current >= state.views.length) state.current = state.views.length - 1;
  else if (state.current === i) state.current = Math.min(i, state.views.length - 1);
  state.selectedPin = -1;
  renderTabs(); renderPinList(); updateHistoryButtons(); fit(); draw(); markDirty();
}
async function loadImageFile(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read ' + file.name)); };
      img.src = url;
    });
  }
}
function loadDataUrl(url) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('Bad image data')); img.src = url; });
}
async function addPhotos(files) {
  const list = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!list.length) return;
  setStatus('Loading photos…');
  for (const f of list) {
    try {
      const img = await loadImageFile(f);
      const n = state.views.length;
      const name = DEFAULT_VIEW_NAMES[n] || f.name.replace(/\.[^.]+$/, '') || `Photo ${n + 1}`;
      state.views.push(createView(name, img));
      if (img.close) img.close();
    } catch (err) { alert(err.message); }
  }
  state.current = state.views.length - 1; state.selectedPin = -1;
  renderTabs(); renderPinList(); updateHistoryButtons(); fit(); markDirty(); renderApLandmarks();
  setStatus(`${list.length} photo${list.length > 1 ? 's' : ''} added`);
  if (avatarInited) autoAssignRoles();
}
el.filePhotos.addEventListener('change', () => { addPhotos(el.filePhotos.files); el.filePhotos.value = ''; });
$('#btnAddFirst').addEventListener('click', () => el.filePhotos.click());
['dragenter', 'dragover'].forEach(ev => el.stage.addEventListener(ev, e => { e.preventDefault(); el.stage.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => el.stage.addEventListener(ev, e => { e.preventDefault(); el.stage.classList.remove('dragover'); }));
el.stage.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addPhotos(e.dataTransfer.files); });
document.addEventListener('paste', e => { const files = Array.from(e.clipboardData?.files || []); if (files.length) addPhotos(files); });

/* ───────────────────────── Patient & notes fields ───────────────────────── */
PROCEDURES.forEach(p => { const o = document.createElement('option'); o.value = o.textContent = p; el.pProc.appendChild(o); });
function bindField(input, obj, key, after) {
  input.addEventListener('input', () => { obj[key] = input.value; if (after) after(); markDirty(); });
}
bindField(el.pName, state.patient, 'name');
bindField(el.pRef, state.patient, 'ref');
bindField(el.pDate, state.patient, 'date');
bindField(el.pProc, state.patient, 'procedure', () => { el.pOtherWrap.hidden = state.patient.procedure !== 'Other'; });
bindField(el.pOther, state.patient, 'other');
bindField(el.nPlan, state.notes, 'plan');
bindField(el.nConsult, state.notes, 'consultation');
bindField(el.nDisclaimer, state.notes, 'disclaimer');
function syncFields() {
  el.pName.value = state.patient.name; el.pRef.value = state.patient.ref; el.pDate.value = state.patient.date;
  el.pProc.value = PROCEDURES.includes(state.patient.procedure) ? state.patient.procedure : 'Other';
  el.pOther.value = state.patient.other; el.pOtherWrap.hidden = el.pProc.value !== 'Other';
  el.nPlan.value = state.notes.plan; el.nConsult.value = state.notes.consultation; el.nDisclaimer.value = state.notes.disclaimer;
}
const procedureLabel = () => (state.patient.procedure === 'Other' && state.patient.other.trim()) ? state.patient.other.trim() : state.patient.procedure;

/* ───────────────────────── Landmarks, scale and autopilot support (2D) ───────────────────────── */
const LM_NAMES = ['pupil_r', 'pupil_l', 'nasion', 'rhinion', 'pronasale', 'subnasale', 'pogonion'];
const LM_SHORT = { pupil_r: 'R pupil', pupil_l: 'L pupil', nasion: 'Nasion', rhinion: 'Rhinion', pronasale: 'Tip', subnasale: 'Subnasale', pogonion: 'Chin' };
// Template positions in mm relative to the nasion: [lateral towards patient's left, down, anterior]
const LM_TEMPLATE = { pupil_r: [-31.5, 0, 0], pupil_l: [31.5, 0, 0], nasion: [0, 0, 0], rhinion: [0, 14, 8], pronasale: [0, 30, 24], subnasale: [0, 42, 12], pogonion: [0, 95, 6] };
function viewKind(v) {
  if (v.kind === 'front' || v.kind === 'profile' || v.kind === 'other') return v.kind;
  if (/front|face|ap\b|frontal/i.test(v.name)) return 'front';
  if (/profile|side|lateral|\bl\b|\br\b|left|right/i.test(v.name)) return 'profile';
  return 'other';
}
function viewPxPerMm(v) {
  const lm = v.landmarks; if (!lm) return 0;
  const kind = viewKind(v);
  if (kind === 'front') { if (!lm.pupil_l || !lm.pupil_r) return 0; return Math.hypot(lm.pupil_l.x - lm.pupil_r.x, lm.pupil_l.y - lm.pupil_r.y) / (v.mm || 63); }
  if (!lm.nasion || !lm.pogonion) return 0;
  return Math.hypot(lm.nasion.x - lm.pogonion.x, lm.nasion.y - lm.pogonion.y) / (v.mm || 108);
}
function ensureLandmarks(v) {
  if (v.landmarks) return;
  const kind = viewKind(v); const lm = {};
  // Start from the 3D alignment if the surgeon has set one, else from a centred face.
  const al = avatarInited && AV().photos.front === v ? AV().getAlign('front') : null;
  const cx = al ? al.cx : v.W / 2, nasionY = al ? al.cy - 0.2 * al.s : v.H * 0.42, pxPerMm = al ? al.s / 117 : v.W / 200;
  const noseDir = /left|\bl\b/i.test(v.name) ? -1 : 1;  // a left profile shows the nose pointing left
  for (const n of LM_NAMES) {
    const [lat, down, ant] = LM_TEMPLATE[n];
    if (kind === 'profile') { if (n === 'pupil_r') continue; lm[n] = { x: cx + (n === 'pupil_l' ? -14 : ant) * pxPerMm * noseDir, y: nasionY + down * pxPerMm }; }
    else lm[n] = { x: cx + lat * pxPerMm, y: nasionY + down * pxPerMm };
  }
  v.landmarks = lm; v.kind = v.kind || kind; if (!v.mm) v.mm = kind === 'front' ? 63 : 108;
}
function hitLandmark(v, p) {
  const r = 14 / state.zoom; let best = null, bd = Infinity;
  for (const [n, q] of Object.entries(v.landmarks)) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= r && d < bd) { bd = d; best = n; } }
  return best;
}
function drawLandmarks(v) {
  const z = state.zoom, off = afterOffset(v), r = 6 / z;
  ctx.font = `600 ${11 / z}px ${getComputedStyle(document.body).fontFamily}`; ctx.textBaseline = 'middle';
  for (const [n, q] of Object.entries(v.landmarks)) {
    ctx.beginPath(); ctx.arc(q.x + off, q.y, r, 0, Math.PI * 2); ctx.fillStyle = '#ffd166'; ctx.fill(); ctx.lineWidth = 1.5 / z; ctx.strokeStyle = '#3a2a00'; ctx.stroke();
    const label = LM_SHORT[n], tw = ctx.measureText(label).width + 8 / z;
    ctx.fillStyle = 'rgba(22,33,46,.8)'; ctx.fillRect(q.x + off + r + 3 / z, q.y - 8 / z, tw, 16 / z);
    ctx.fillStyle = '#fff'; ctx.fillText(label, q.x + off + r + 7 / z, q.y);
  }
  const lm = v.landmarks, k = viewKind(v);
  const pairs = k === 'front' ? [['pupil_r', 'pupil_l']] : [['nasion', 'pogonion']];
  for (const [a, b] of pairs) if (lm[a] && lm[b]) { ctx.beginPath(); ctx.moveTo(lm[a].x + off, lm[a].y); ctx.lineTo(lm[b].x + off, lm[b].y); ctx.setLineDash([4 / z, 4 / z]); ctx.strokeStyle = 'rgba(255,209,102,.9)'; ctx.lineWidth = 1 / z; ctx.stroke(); ctx.setLineDash([]); }
  ctx.textBaseline = 'alphabetic';
}
/* Apply autopilot pushes on a photo: { x, y, vx, vy, px, radiusPx, mode: move|bloat|pucker } — one undo step. */
function applyPushes2D(v, pushes) {
  if (!pushes.length) return;
  if (state.morph < 1 && v === currentView()) setMorph(1, true);
  let box = null;
  const grow = (x0, y0, x1, y1) => { x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(v.W - 1, Math.ceil(x1)); y1 = Math.min(v.H - 1, Math.ceil(y1)); if (x1 < x0 || y1 < y0) return; box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 }; };
  for (const p of pushes) grow(p.x - p.radiusPx - Math.abs(p.px) - 2, p.y - p.radiusPx - Math.abs(p.px) - 2, p.x + p.radiusPx + Math.abs(p.px) + 2, p.y + p.radiusPx + Math.abs(p.px) + 2);
  if (!box) return;
  const before = { b: { ...box }, dx: copyRegion(v.dx, v.W, box), dy: copyRegion(v.dy, v.W, box) };
  for (const p of pushes) {
    const r = Math.max(4, p.radiusPx);
    if (p.mode === 'move') {
      const len = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / len, uy = p.vy / len, total = p.px;
      const steps = Math.max(1, Math.ceil(Math.abs(total) / Math.max(1.5, r * 0.15)));
      for (let i = 1; i <= steps; i++) { const t = total / steps; dab(v, p.x + ux * t * (i - 0.5), p.y + uy * t * (i - 0.5), ux * t, uy * t, { tool: 'push', r, k: 1 }); }
    } else {
      // radial: each tick scales the region; a point at r/2 moves ~ r/2 * 0.03 * 0.5625 per tick
      const perTick = (r / 2) * 0.03 * 0.5625, ticks = Math.min(400, Math.max(1, Math.round(Math.abs(p.px) / perTick)));
      for (let i = 0; i < ticks; i++) dab(v, p.x, p.y, 0, 0, { tool: p.mode === 'bloat' ? 'expand' : 'shrink', r, k: 1 });
    }
  }
  v.history.push(before); if (v.history.length > HISTORY_LIMIT) v.history.shift(); v.redo = [];
  renderRegion(v, box.x0, box.y0, box.x1 + 1, box.y1 + 1, 1);
  if (v === currentView()) { updateHistoryButtons(); draw(); }
  markDirty();
}
window.MorphAPI = {
  views: () => state.views.slice(),
  viewInfo: v => ({ kind: viewKind(v), pxPerMm: viewPxPerMm(v), mm: v.mm }),
  applyPushes2D, undoView: v => { if (!v.history.length) return; const s = v.history.pop(); v.redo.push(snapshot(v, s.b)); applySnapshot(v, s); if (v === currentView()) { updateHistoryButtons(); draw(); } markDirty(); },
  notes: () => ({ plan: state.notes.plan, consultation: state.notes.consultation }),
  procedure: () => procedureLabel(),
  markDirty, setStatus,
  saveChat: msgs => { state.chat = msgs; },
  loadChat: () => {},
};
/* Landmark status panel inside the autopilot box */
function renderApLandmarks() {
  const box = $('#apLandmarks'); if (!box) return;
  const rows = [];
  if (avatarInited && AV().model) {
    const A = AV(), ready = A.landmarksReady();
    rows.push(`<div class="lmrow"><span>3D model:</span> <span class="${ready ? 'ok' : 'todo'}">${ready ? 'landmarks set' : 'landmarks needed'}</span>
      <button id="apLm3d">${ready ? 'Check / adjust landmarks' : 'Set landmarks'}</button>
      <label class="check inline"><input type="checkbox" id="apShowLm" ${A.showLandmarks ? 'checked' : ''}> show</label></div>`);
  }
  const v = currentView();
  if (v) {
    const kind = viewKind(v), has = !!v.landmarks;
    rows.push(`<div class="lmrow"><span>Photo “${esc(v.name)}”:</span>
      <select id="apKind"><option value="front" ${kind === 'front' ? 'selected' : ''}>front view</option><option value="profile" ${kind === 'profile' ? 'selected' : ''}>profile view</option><option value="other" ${kind === 'other' ? 'selected' : ''}>other (not editable by AI)</option></select>
      <span class="${has ? 'ok' : 'todo'}">${has ? 'landmarks set' : 'landmarks needed'}</span>
      <button id="apLm2d">${has ? 'Adjust landmarks' : 'Place landmarks'}</button>
      ${kind === 'other' ? '' : `<label class="inline">${kind === 'front' ? 'pupil distance' : 'nasion–chin'} <input type="number" id="apMm" min="20" max="200" value="${v.mm || (kind === 'front' ? 63 : 108)}"> mm</label>`}
      ${has ? `<button id="apLmReset" title="Put the landmarks back on the template">Reset</button>` : ''}</div>`);
  }
  if (!rows.length) rows.push('<div class="lmrow">Add a photo or a 3D model, then place the landmarks so the autopilot knows where the nose, lips and chin are.</div>');
  box.innerHTML = rows.join('');
  $('#apLm3d')?.addEventListener('click', async () => { const A = await ensureAvatar(); if (!is3d()) await setMode('3d'); setTool3d('landmark'); A.startLandmarks(); });
  $('#apShowLm')?.addEventListener('change', e => { AV().setShowLandmarks(e.target.checked); });
  $('#apKind')?.addEventListener('change', e => { const vv = currentView(); vv.kind = e.target.value; vv.landmarks = null; vv.mm = 0; markDirty(); renderApLandmarks(); draw(); });
  $('#apLm2d')?.addEventListener('click', async () => { if (is3d()) await setMode('2d'); setTool('landmarks'); });
  $('#apMm')?.addEventListener('change', e => { const vv = currentView(); vv.mm = +e.target.value || 0; markDirty(); });
  $('#apLmReset')?.addEventListener('click', () => { const vv = currentView(); vv.landmarks = null; ensureLandmarks(vv); markDirty(); draw(); });
}
/* 3D landmark prompt overlay */
function renderLmPrompt() {
  const box = $('#lmPrompt'); if (!box || !avatarInited) return;
  const A = AV();
  if (!is3d() || A.tool !== 'landmark') { box.hidden = true; return; }
  const name = A.currentLandmarkName();
  box.hidden = false;
  box.innerHTML = name
    ? `<span>Click <strong>${esc(A.LANDMARK_LABELS[name])}</strong> <em>(${A.LANDMARK_NAMES.indexOf(name) + 1}/${A.LANDMARK_NAMES.length})</em></span><button id="lmSkip">Skip</button><button id="lmDone">Done</button>`
    : `<span>Landmarks placed. Click near a landmark to move it, or</span><button id="lmRestart">Start again</button><button id="lmDone">Done</button>`;
  $('#lmSkip')?.addEventListener('click', () => A.skipLandmark());
  $('#lmRestart')?.addEventListener('click', () => A.startLandmarks());
  $('#lmDone')?.addEventListener('click', () => { A.finishLandmarks(); setTool3d('orbit'); });
}

/* ───────────────────────── Letters & documents ───────────────────────── */
const DOC_MAX_ONE = 25 * 1024 * 1024, DOC_MAX_TOTAL = 80 * 1024 * 1024;
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function docKind(d) {
  const n = d.name.toLowerCase(), t = d.type || '';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('text/') || /\.(txt|md|csv)$/.test(n)) return 'text';
  if (/\.(docx?|odt|rtf)$/.test(n) || /word|opendocument|rtf/.test(t)) return 'word';
  return 'file';
}
const readAsDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read ' + f.name)); r.readAsDataURL(f); });
function dataUrlToBlob(u) {
  const [head, b64] = u.split(','), mime = (head.match(/^data:([^;]*)/) || [])[1] || 'application/octet-stream';
  const bytes = bytesFromB64(b64); return new Blob([bytes], { type: mime });
}
async function addDocs(files) {
  const list = Array.from(files); if (!list.length) return;
  let total = state.docs.reduce((a, d) => a + d.size, 0), added = 0;
  for (const f of list) {
    if (f.size > DOC_MAX_ONE) { alert(`${f.name} is larger than 25 MB and was skipped.`); continue; }
    if (total + f.size > DOC_MAX_TOTAL) { alert(`Adding ${f.name} would take the case over 80 MB of documents; it was skipped.`); continue; }
    try {
      state.docs.push({ id: 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: f.name, type: f.type || '', size: f.size,
        added: new Date().toISOString(), date: f.lastModified ? new Date(f.lastModified).toISOString().slice(0, 10) : today(), note: '', data: await readAsDataUrl(f) });
      total += f.size; added++;
    } catch (e) { alert(e.message); }
  }
  renderDocs(); markDirty();
  if (added) setStatus(`${added} document${added > 1 ? 's' : ''} attached to the case`);
}
function renderDocs() {
  el.docList.innerHTML = '';
  el.docCount.textContent = state.docs.length ? `(${state.docs.length})` : '';
  const labels = { pdf: 'PDF', image: 'IMG', text: 'TXT', word: 'DOC', file: 'FILE' };
  state.docs.forEach((d, i) => {
    const row = document.createElement('div'); row.className = 'doc';
    row.innerHTML = `<div class="doc-top"><span class="doc-icon">${labels[docKind(d)]}</span>
        <div class="doc-name"><span class="n" title="${esc(d.name)}">${esc(d.name)}</span><span class="s">${fmtSize(d.size)}</span></div>
        <div class="doc-actions"><button class="view">View</button><button class="x" title="Remove document">×</button></div></div>
      <div class="doc-meta"><input type="date" value="${esc(d.date)}" title="Date of the letter"><input type="text" placeholder="e.g. Consultation letter, quote, consent form…" value="${esc(d.note)}"></div>`;
    row.querySelector('.view').addEventListener('click', () => openDoc(d));
    row.querySelector('.x').addEventListener('click', () => { if (confirm(`Remove "${d.name}" from this case?`)) { state.docs.splice(i, 1); renderDocs(); markDirty(); } });
    row.querySelector('input[type="date"]').addEventListener('input', ev => { d.date = ev.target.value; markDirty(); });
    row.querySelector('input[type="text"]').addEventListener('input', ev => { d.note = ev.target.value; markDirty(); });
    el.docList.appendChild(row);
  });
}
let docUrl = null;
function openDoc(d) {
  closeDoc();
  const blob = dataUrlToBlob(d.data); docUrl = URL.createObjectURL(blob);
  el.docTitle.textContent = d.name; el.docDownload.href = docUrl; el.docDownload.download = d.name;
  el.docBody.innerHTML = '';
  const kind = docKind(d);
  if (kind === 'pdf') { const f = document.createElement('iframe'); f.src = docUrl; f.title = d.name; el.docBody.appendChild(f); }
  else if (kind === 'image') { const img = document.createElement('img'); img.src = docUrl; img.alt = d.name; el.docBody.appendChild(img); }
  else if (kind === 'text') { const pre = document.createElement('pre'); blob.text().then(t => { pre.textContent = t; }); el.docBody.appendChild(pre); }
  else { el.docBody.innerHTML = `<div class="none"><p>Preview is not available for this file type.</p><p>Use <strong>Download</strong> to open it in its own application.</p></div>`; }
  el.docModal.hidden = false;
}
function closeDoc() { el.docModal.hidden = true; el.docBody.innerHTML = ''; if (docUrl) { URL.revokeObjectURL(docUrl); docUrl = null; } }
$('#btnAddDocs').addEventListener('click', () => el.fileDocs.click());
el.fileDocs.addEventListener('change', () => { addDocs(el.fileDocs.files); el.fileDocs.value = ''; });
['dragenter', 'dragover'].forEach(ev => el.docs.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); el.docs.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => el.docs.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); el.docs.classList.remove('dragover'); }));
el.docs.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addDocs(e.dataTransfer.files); });
$('#docClose').addEventListener('click', closeDoc);
el.docModal.addEventListener('click', e => { if (e.target === el.docModal) closeDoc(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!el.docModal.hidden) closeDoc(); else if (!el.alignModal.hidden) el.alignModal.hidden = true; } });

/* ───────────────────────── Persistence ───────────────────────── */
function b64FromBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b64) { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

function encodeDisp(v) {
  let any = false;
  for (let i = 0; i < v.dx.length; i++) if (v.dx[i] !== 0 || v.dy[i] !== 0) { any = true; break; }
  if (!any) return null;
  const w = Math.ceil(v.W / DISP_SCALE), h = Math.ceil(v.H / DISP_SCALE), q = new Int16Array(w * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = Math.min(v.H - 1, y * DISP_SCALE) * v.W + Math.min(v.W - 1, x * DISP_SCALE), o = (y * w + x) * 2;
    q[o] = clamp(Math.round(v.dx[i] * DISP_Q), -32768, 32767);
    q[o + 1] = clamp(Math.round(v.dy[i] * DISP_Q), -32768, 32767);
  }
  return { scale: DISP_SCALE, q: DISP_Q, w, h, data: b64FromBytes(new Uint8Array(q.buffer)) };
}
function decodeDisp(v, d) {
  if (!d) return;
  const bytes = bytesFromB64(d.data), q = new Int16Array(bytes.buffer, 0, d.w * d.h * 2), s = d.scale, inv = 1 / d.q;
  for (let y = 0; y < v.H; y++) {
    const gy = Math.min(y / s, d.h - 1), fy = gy | 0, cy = Math.min(fy + 1, d.h - 1), ay = gy - fy;
    for (let x = 0; x < v.W; x++) {
      const gx = Math.min(x / s, d.w - 1), fx = gx | 0, cx = Math.min(fx + 1, d.w - 1), ax = gx - fx;
      const i00 = (fy * d.w + fx) * 2, i10 = (fy * d.w + cx) * 2, i01 = (cy * d.w + fx) * 2, i11 = (cy * d.w + cx) * 2;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay, i = y * v.W + x;
      v.dx[i] = (q[i00] * w00 + q[i10] * w10 + q[i01] * w01 + q[i11] * w11) * inv;
      v.dy[i] = (q[i00 + 1] * w00 + q[i10 + 1] * w10 + q[i01 + 1] * w01 + q[i11 + 1] * w11) * inv;
    }
  }
}
function serialize() {
  return {
    app: 'morph-studio', version: 1, savedAt: new Date().toISOString(),
    patient: { ...state.patient }, notes: { ...state.notes },
    docs: state.docs.map(d => ({ ...d })),
    views: state.views.map(v => ({ name: v.name, W: v.W, H: v.H, image: v.before.toDataURL('image/jpeg', 0.92), disp: encodeDisp(v), pins: v.pins.map(p => ({ ...p })), landmarks: v.landmarks ? JSON.parse(JSON.stringify(v.landmarks)) : null, kind: v.kind || '', mm: v.mm || 0 })),
    chat: state.chat || [],
    avatar: avatarInited ? AV().serialize(v => state.views.indexOf(v)) : (pendingAvatar || null),
  };
}
let pendingAvatar = null;
async function restore(data) {
  if (!data || data.app !== 'morph-studio') throw new Error('This is not a Morph Studio case file.');
  endStroke();
  state.patient = { name: '', ref: '', date: today(), procedure: 'Rhinoplasty', other: '', ...data.patient };
  state.notes = { plan: '', consultation: '', disclaimer: DEFAULT_DISCLAIMER, ...data.notes };
  state.docs = (data.docs || []).filter(d => d && typeof d.data === 'string' && d.data.startsWith('data:')).map(d => ({ id: d.id || 'doc-' + Math.random().toString(36).slice(2), name: String(d.name || 'document'), type: String(d.type || ''), size: +d.size || 0, added: d.added || '', date: d.date || '', note: String(d.note || ''), data: d.data }));
  renderDocs();
  state.views = [];
  for (const d of data.views || []) {
    const v = createView(d.name || 'Photo', await loadDataUrl(d.image));
    decodeDisp(v, d.disp);
    v.pins = (d.pins || []).map(p => ({ x: +p.x || 0, y: +p.y || 0, text: String(p.text || '') }));
    if (d.landmarks && typeof d.landmarks === 'object') { v.landmarks = {}; for (const [k, q] of Object.entries(d.landmarks)) if (LM_NAMES.includes(k) && q && isFinite(q.x) && isFinite(q.y)) v.landmarks[k] = { x: +q.x, y: +q.y }; if (!Object.keys(v.landmarks).length) v.landmarks = null; }
    v.kind = ['front', 'profile', 'other'].includes(d.kind) ? d.kind : ''; v.mm = +d.mm || 0;
    renderAll(v);
    state.views.push(v);
  }
  state.current = state.views.length ? 0 : -1; state.selectedPin = -1;
  pendingAvatar = data.avatar || null;
  if (avatarInited) { await AV().restore(pendingAvatar, i => state.views[i] || null); pendingAvatar = null; if (is3d()) autoAssignRoles(); }
  state.chat = Array.isArray(data.chat) ? data.chat : [];
  if (window.MorphAPI.loadChat) window.MorphAPI.loadChat(state.chat);
  syncFields(); renderTabs(); renderPinList(); updateHistoryButtons(); setMorph(1, false); fit(); draw(); renderApLandmarks();
}

// Local autosave (IndexedDB) so an accidental refresh does not lose the consultation.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('morph-studio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cases');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbRun(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('cases', mode); let out;
    try { out = fn(tx.objectStore('cases')); } catch (e) { db.close(); return rej(e); }
    tx.oncomplete = () => { db.close(); res(out && 'result' in out ? out.result : undefined); };
    tx.onerror = () => { db.close(); rej(tx.error); };
    tx.onabort = () => { db.close(); rej(tx.error); };
  });
}
const idbPut = (key, val) => idbRun('readwrite', s => s.put(val, key));
const idbGet = key => idbRun('readonly', s => s.get(key));
const idbDel = key => idbRun('readwrite', s => s.delete(key));

let saveTimer = 0, dirty = false;
function setStatus(msg) { el.status.textContent = msg; }
function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 1500);
}
async function autosave() {
  try { await idbPut('current', serialize()); setStatus(`Kept on this device · ${nowTime()}`); }
  catch (e) { setStatus('Could not keep a local copy (storage blocked). Use Save case to download a file.'); }
}
window.addEventListener('beforeunload', e => { if (dirty && (state.views.length || state.docs.length)) { e.preventDefault(); e.returnValue = ''; } });

/* ───────────────────────── Case actions ───────────────────────── */
function fileStem() {
  const who = (state.patient.ref || state.patient.name || 'patient').replace(/[^\w-]+/g, '_');
  return `${who}_${state.patient.date || today()}`;
}
function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#btnSave').addEventListener('click', () => {
  if (state.morph < 1) { setMorph(1, true); draw(); }
  download(`morph-case_${fileStem()}.json`, new Blob([JSON.stringify(serialize())], { type: 'application/json' }));
  dirty = false; setStatus('Case file downloaded');
});
$('#btnOpen').addEventListener('click', () => {
  if (state.views.length && dirty && !confirm('Opening a file replaces the current case. Continue?')) return;
  el.fileCase.click();
});
el.fileCase.addEventListener('change', async () => {
  const f = el.fileCase.files[0]; el.fileCase.value = '';
  if (!f) return;
  try { await restore(JSON.parse(await f.text())); dirty = false; setStatus(`Opened ${f.name}`); await idbPut('current', serialize()); }
  catch (e) { alert('Could not open this file: ' + e.message); }
});
$('#btnNew').addEventListener('click', async () => {
  if ((state.views.length || state.docs.length) && !confirm('Start a new case? The current case is removed from this device unless you saved it.')) return;
  await restore({ app: 'morph-studio', version: 1, views: [] });
  dirty = false; await idbDel('current').catch(() => {});
  setStatus('New case');
});

/* ───────────────────────── Export image ───────────────────────── */
function wrapText(c, text, maxW) {
  const lines = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}
$('#btnExport').addEventListener('click', () => {
  if (is3d()) {
    if (!avatarInited) return;
    const A = AV(), before = A.snapshot('before', 'current', 1000), after = A.snapshot('after', 'current', 1000);
    composeSheet(before, after, '3D avatar', `morph3d_${fileStem()}.png`);
    setStatus('3D before / after image downloaded'); return;
  }
  const v = currentView(); if (!v) return alert('Add a photo first.');
  if (state.morph < 1) { setMorph(1, true); draw(); }
  composeSheet(v.before, v.after, v.name, `morph_${fileStem()}_${v.name.replace(/[^\w-]+/g, '_')}.png`);
  setStatus('Before / after image downloaded');
});
function composeSheet(beforeImg, afterImg, label, filename) {
  const W = beforeImg.width, H = beforeImg.height, gap = Math.round(W * 0.03), pad = Math.round(W * 0.04);
  const fs = Math.max(14, Math.round(W * 0.026)), small = Math.round(fs * 0.8), font = getComputedStyle(document.body).fontFamily;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  c.width = W * 2 + gap + pad * 2;
  const innerW = c.width - pad * 2;
  g.font = `${small}px ${font}`;
  const discLines = wrapText(g, state.notes.disclaimer, innerW);
  const headerH = fs * 2 + small + pad, footerH = discLines.length * Math.round(small * 1.35) + pad;
  c.height = headerH + fs * 1.6 + H + footerH + pad;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#16212e'; g.textBaseline = 'top';
  g.font = `700 ${fs}px ${font}`;
  g.fillText(`${procedureLabel()} — simulated result (${label})`, pad, pad * 0.6);
  g.font = `${small}px ${font}`; g.fillStyle = '#5b6876';
  const meta = [state.patient.name, state.patient.ref && `Ref ${state.patient.ref}`, state.patient.date].filter(Boolean).join('  ·  ');
  g.fillText(meta, pad, pad * 0.6 + fs * 1.4);
  const imgY = headerH + fs * 1.6;
  g.font = `600 ${small}px ${font}`; g.fillStyle = '#16212e';
  g.fillText('BEFORE', pad, imgY - fs * 1.3);
  g.fillText('SIMULATED AFTER', pad + W + gap, imgY - fs * 1.3);
  g.drawImage(beforeImg, pad, imgY); g.drawImage(afterImg, pad + W + gap, imgY);
  g.strokeStyle = '#dde3ea'; g.lineWidth = 1;
  g.strokeRect(pad + 0.5, imgY + 0.5, W - 1, H - 1); g.strokeRect(pad + W + gap + 0.5, imgY + 0.5, W - 1, H - 1);
  g.font = `${small}px ${font}`; g.fillStyle = '#5b6876';
  discLines.forEach((l, i) => g.fillText(l, pad, imgY + H + pad * 0.7 + i * Math.round(small * 1.35)));
  c.toBlob(b => download(filename, b), 'image/png');
}

/* ───────────────────────── Print summary ───────────────────────── */
$('#btnPrint').addEventListener('click', () => {
  const A = avatarInited ? AV() : null;
  const has3d = A && (A.hasEdits() || ROLES.some(r => A.photos[r]) || (A.model && A.model.kind === 'glb'));
  if (!state.views.length && !has3d && !state.docs.length) return alert('Add a photo or a document first.');
  if (state.morph < 1) { setMorph(1, true); draw(); }
  const meta = [state.patient.name && `Patient: ${esc(state.patient.name)}`, state.patient.ref && `Ref: ${esc(state.patient.ref)}`, state.patient.date && `Date: ${esc(state.patient.date)}`, `Procedure: ${esc(procedureLabel())}`].filter(Boolean).join(' &nbsp;·&nbsp; ');
  let html = `<h1>Consultation summary — simulated result</h1><div class="meta">${meta}</div>`;
  for (const v of state.views) {
    html += `<section class="print-view"><h2>${esc(v.name)}</h2><div class="pair">
      <figure><img src="${v.before.toDataURL('image/jpeg', 0.9)}" alt="Before"><figcaption>Before</figcaption></figure>
      <figure><img src="${v.after.toDataURL('image/jpeg', 0.9)}" alt="Simulated after"><figcaption>Simulated after</figcaption></figure></div>`;
    if (v.pins.length) html += `<ol>${v.pins.map(p => `<li>${esc(p.text) || '<em>(no text)</em>'}</li>`).join('')}</ol>`;
    html += '</section>';
  }
  if (has3d) {
    const angles = [['front', 'Front'], ['rightQ', 'Three-quarter right'], ['right', 'Right profile'], ['leftQ', 'Three-quarter left'], ['left', 'Left profile']];
    html += '<section class="print-view"><h2>3D avatar</h2>';
    for (const [preset, name] of angles) {
      html += `<div class="pair">
        <figure><img src="${A.snapshot('before', preset, 700).toDataURL('image/jpeg', 0.88)}" alt="Before, ${name}"><figcaption>${name} — before</figcaption></figure>
        <figure><img src="${A.snapshot('after', preset, 700).toDataURL('image/jpeg', 0.88)}" alt="Simulated after, ${name}"><figcaption>${name} — simulated after</figcaption></figure></div>`;
    }
    if (A.pins.length) html += `<ol>${A.pins.map(p => `<li>${esc(p.text) || '<em>(no text)</em>'}</li>`).join('')}</ol>`;
    if (A.measures.length) {
      const src = { calibrated: 'calibrated by the surgeon', file: 'taken from the model file', assumed: 'assumed — not calibrated' }[A.scaleSource] || A.scaleSource;
      html += `<p><strong>Measurements</strong> (scale ${src})</p><table><tr><th>#</th><th>Before</th><th>Simulated after</th><th>Change</th></tr>${A.measures.map((m, i) => { const v = A.measureValues(i); return `<tr><td>${i + 1}</td><td>${v.before.toFixed(1)} mm</td><td>${v.after.toFixed(1)} mm</td><td>${(v.after - v.before >= 0 ? '+' : '') + (v.after - v.before).toFixed(1)} mm</td></tr>`; }).join('')}</table>`;
    }
    html += '</section>';
  }
  if (state.notes.plan.trim()) html += `<h2>Planned changes</h2><p>${esc(state.notes.plan)}</p>`;
  if (state.notes.consultation.trim()) html += `<h2>Consultation notes</h2><p>${esc(state.notes.consultation)}</p>`;
  if (state.docs.length) {
    html += `<h2>Letters &amp; documents</h2><table><tr><th>Date</th><th>Document</th><th>Description</th></tr>${state.docs.map(d => `<tr><td>${esc(d.date)}</td><td>${esc(d.name)}</td><td>${esc(d.note)}</td></tr>`).join('')}</table>`;
    for (const d of state.docs) if (docKind(d) === 'image') html += `<figure class="print-view"><img src="${d.data}" alt="${esc(d.name)}" style="max-height:120mm;width:auto"><figcaption>${esc(d.name)}${d.note ? ' — ' + esc(d.note) : ''}</figcaption></figure>`;
  }
  html += `<div class="disclaimer">${esc(state.notes.disclaimer)}</div>
    <div class="sign"><div>Surgeon signature</div><div>Patient signature</div><div>Date</div></div>`;
  el.printArea.innerHTML = html;
  // Give the browser a moment to decode the images before the print dialog opens.
  const imgs = $$('img', el.printArea);
  Promise.all(imgs.map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => window.print());
});
window.addEventListener('afterprint', () => { el.printArea.innerHTML = ''; });

/* ───────────────────────── Boot ───────────────────────── */
new ResizeObserver(() => { const had = !!currentView(); resizeCanvas(); if (had) draw(); if (avatarInited) AV().resize(); }).observe(el.stage);

/* ───────────────────────── 3D model, scale & measurements ───────────────────────── */
function renderModelPanel() {
  if (!avatarInited) return;
  const A = AV(), info = A.modelInfo(); if (!info) return;
  const glb = info.kind === 'glb';
  el.modelStatus.innerHTML = glb
    ? `${esc(info.name)}<span class="sub">${info.faces.toLocaleString()} faces · ${(info.bytes / 1048576).toFixed(1)} MB · realistic model of the patient</span>`
    : `Generic head<span class="sub">no patient model loaded — photos are projected onto a standard head shape</span>`;
  el.btnRemoveModel.hidden = !glb; el.turnRow.hidden = !glb; el.photoRoles.hidden = glb;
  const src = { calibrated: 'Calibrated by you', file: 'Scale read from the model file', assumed: 'Scale assumed (typical head size) — calibrate for accurate millimetres' }[info.scaleSource] || info.scaleSource;
  el.scaleStatus.innerHTML = `${src}<span class="sub">1 mm on the patient = ${(1 / info.mmPerUnit).toFixed(4)} model units</span>`;
  $('#btnReset').textContent = is3d() ? (glb ? 'Reset model edits' : 'Reset avatar') : 'Reset this photo';
  if (el.hint3d) el.hint3d.hidden = glb || !el.hint3d.textContent;
}
function renderMeasures() {
  if (!avatarInited) return;
  const A = AV();
  el.measureList.innerHTML = '';
  el.btnClearMeasures.hidden = !A.measures.length;
  if (A.pendingPoint) { const p = document.createElement('div'); p.className = 'hint'; p.textContent = 'First point set — click the second point on the head.'; el.measureList.appendChild(p); }
  A.measures.forEach((m, i) => {
    const v = A.measureValues(i); if (!v) return;
    const row = document.createElement('div'); row.className = 'measure';
    const delta = v.after - v.before;
    row.innerHTML = `<span class="num">${i + 1}</span><span class="val"><strong>${v.after.toFixed(1)} mm</strong> ${Math.abs(delta) >= 0.05 ? `<small>was ${v.before.toFixed(1)} mm (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})</small>` : ''}</span><button class="cal" title="Enter the real distance to calibrate the scale">Set as…</button><button class="x" title="Remove">×</button>`;
    row.querySelector('.cal').addEventListener('click', () => {
      const ans = prompt('Real distance between these two points on the patient, in millimetres:', v.before.toFixed(0));
      const mmv = parseFloat(ans); if (!(mmv > 0)) return;
      if (A.calibrate(i, mmv)) setStatus(`Scale calibrated: measurement ${i + 1} = ${mmv} mm`);
    });
    row.querySelector('.x').addEventListener('click', () => A.deleteMeasure(i));
    el.measureList.appendChild(row);
  });
}
el.btnClearMeasures.addEventListener('click', () => { if (avatarInited && confirm('Remove all measurements?')) AV().clearMeasures(); });
let measureTimer = 0;
setInterval(() => { if (is3d() && avatarInited && !el.measureList.matches(':hover')) { const A = AV(); if (A.measures.length && A.hasEdits()) renderMeasures(); } }, 700);

async function loadModelFile(file) {
  if (!file) return;
  if (!/\.(glb|gltf)$/i.test(file.name)) { alert('Please choose a .glb or .gltf 3D model.'); return; }
  if (file.size > 120 * 1024 * 1024) { alert('This model is larger than 120 MB. Please export a lighter version.'); return; }
  setStatus(`Loading ${file.name}…`);
  try {
    const A = await ensureAvatar();
    await A.loadGLB(await file.arrayBuffer(), file.name);
    if (!is3d()) await setMode('3d');
    A.resetView();
    setStatus(`3D model loaded: ${file.name}. Use Measure + "Set as…" to calibrate the scale.`);
  } catch (e) { alert('Could not load this 3D model: ' + (e.message || e)); setStatus('Model not loaded'); }
}
$('#btnLoadModel').addEventListener('click', () => el.fileModel.click());

/* ── AI generation of the patient's 3D model from the front photo ── */
let genJob = null;
function genUI(on, pct, text) {
  const box = $('#genProgress'); box.hidden = !on;
  if (on) { box.querySelector('.fill').style.width = `${Math.max(2, Math.min(100, pct))}%`; box.querySelector('.txt').textContent = text || ''; }
  $('#btnGenModel').disabled = on;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function postJSON(url, data) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  let body = null; const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, raw: r };
}
async function generateModel() {
  const A0 = avatarInited ? AV() : null;
  let view = (A0 && A0.photos.front && state.views.includes(A0.photos.front)) ? A0.photos.front : state.views.find(v => viewKind(v) === 'front') || (currentView() && viewKind(currentView()) !== 'profile' ? currentView() : null);
  if (!view) { alert('Add a front-view photo of the patient first (plain background, neutral expression, hair away from the face).'); return; }
  if (!confirm(`Build a 3D model of the patient from the photo “${view.name}”?\n\nThe photo is sent to the AI 3D service (Meshy) to generate the model and is not kept in this app's servers. Make sure the patient has consented to this. Generation usually takes 1–3 minutes.`)) return;
  genUI(true, 3, 'Sending photo…');
  const image = view.before.toDataURL('image/jpeg', 0.92);
  try {
    const start = await postJSON('api/generate3d', { action: 'start', image });
    if (start.status === 503) { genUI(false); alert('AI 3D generation is not enabled on this deployment yet.\n\nAdd a MESHY_API_KEY environment variable in the Vercel project (Settings → Environment Variables) and redeploy. Until then you can generate the model on the provider\'s website and use “Load 3D model file…”.'); return; }
    if (!start.ok) throw new Error((start.body && start.body.message) || `Could not start generation (${start.status}).`);
    const taskId = start.body.task_id; genJob = { taskId, cancelled: false };
    let glbUrl = null;
    for (let i = 0; i < 400 && !genJob.cancelled; i++) {
      await sleep(i < 5 ? 3000 : 5000);
      const st = await postJSON('api/generate3d', { action: 'status', task_id: taskId });
      if (!st.ok) throw new Error((st.body && st.body.message) || `Status check failed (${st.status}).`);
      const b = st.body;
      if (b.status === 'failed') throw new Error(b.error || 'The AI service could not build a model from this photo.');
      if (b.status === 'succeeded') { glbUrl = b.glb_url; break; }
      genUI(true, 5 + (b.progress || 0) * 0.9, b.status === 'pending' ? `Waiting in the queue${b.preceding ? ` (${b.preceding} ahead)` : ''}…` : `Building the model… ${b.progress || 0}%`);
    }
    if (genJob.cancelled) { genUI(false); setStatus('3D generation cancelled'); return; }
    if (!glbUrl) throw new Error('The model was not ready after a long wait. Try again later.');
    genUI(true, 96, 'Downloading model…');
    let buffer = null;
    try { const r = await fetch(glbUrl); if (r.ok) buffer = await r.arrayBuffer(); } catch { /* CORS or network — fall back to the proxy */ }
    if (!buffer) {
      const r = await postJSON('api/generate3d', { action: 'fetch', task_id: taskId });
      if (r.ok && r.raw) buffer = await r.raw.arrayBuffer();
      else throw new Error((r.body && r.body.error === 'too_large_for_proxy') ? 'The model file is too large to download through the app; open this link in a new tab and load the file with “Load 3D model file…”:\n' + r.body.url : 'Could not download the finished model.');
    }
    const A = await ensureAvatar();
    await A.loadGLB(buffer, `ai-model-${(state.patient.ref || state.patient.name || 'patient').replace(/[^\w-]+/g, '_')}.glb`);
    if (!is3d()) await setMode('3d');
    A.resetView(); genUI(false);
    setStatus('AI 3D model ready — confirm the landmarks, then calibrate the scale with Measure + “Set as…”.');
    setTool3d('landmark'); A.startLandmarks(); markDirty();
  } catch (e) { genUI(false); alert('3D generation: ' + (e.message || e)); setStatus('3D generation failed'); }
  finally { genJob = null; }
}
$('#btnGenModel').addEventListener('click', generateModel);
$('#genCancel').addEventListener('click', () => { if (genJob) genJob.cancelled = true; });
el.fileModel.addEventListener('change', () => { loadModelFile(el.fileModel.files[0]); el.fileModel.value = ''; });
el.btnRemoveModel.addEventListener('click', () => { if (avatarInited && confirm('Remove the 3D model and go back to the generic head? Edits on the model are lost.')) { AV().removeModel(); autoAssignRoles(); } });
$$('#turnRow button').forEach(b => b.addEventListener('click', () => { const [axis, q] = b.dataset.turn.split(':'); if (avatarInited) AV().turnModel(axis, +q); }));
// Drop a .glb anywhere on the stage.
el.stage.addEventListener('drop', e => {
  const f = Array.from(e.dataTransfer?.files || []).find(f => /\.(glb|gltf)$/i.test(f.name));
  if (f) { e.stopImmediatePropagation(); loadModelFile(f); }
}, true);
// Scale bar (kept in sync with the camera distance while the 3D view is open).
(function scaleLoop() {
  if (is3d() && avatarInited) {
    const A = AV(), px = A.pxPerMm();
    let mmLen = 20; if (px * mmLen > 220) mmLen = 10; if (px * mmLen > 220) mmLen = 5; if (px * mmLen < 40) mmLen = 50; if (px * mmLen < 40) mmLen = 100;
    el.scalebar.hidden = false; el.scalebar.querySelector('.bar').style.width = Math.round(px * mmLen) + 'px'; el.scalebar.querySelector('span').textContent = `${mmLen} mm${A.scaleSource === 'assumed' ? ' (approx.)' : ''}`;
  } else el.scalebar.hidden = true;
  requestAnimationFrame(scaleLoop);
})();

/* ───────────────────────── Mode switch (2D photos / 3D avatar) ───────────────────────── */
async function setMode(mode) {
  if (mode === state.mode) return;
  endStroke(); setPeek(false);
  if (mode === '3d') {
    setStatus('Preparing the 3D avatar…');
    const A = await ensureAvatar();
    if (!A.available) { alert(A.error || '3D is not available in this browser.'); setStatus(A.error || '3D unavailable'); return; }
    state.mode = '3d'; document.body.dataset.mode = '3d';
    if (pendingAvatar) { await A.restore(pendingAvatar, i => state.views[i] || null); pendingAvatar = null; }
    autoAssignRoles();
    el.canvas.style.display = 'none'; el.divider.hidden = true; A.show(true);
    A.setTool($('#toolGrid3d button.active')?.dataset.tool || 'orbit');
    A.setCompare($('#compare3dSeg button.active')?.dataset.compare || 'after');
    A.setAutoRotate(el.autoRotate.checked);
    setStatus('3D avatar — drag to rotate, wheel to zoom');
  } else {
    state.mode = '2d'; document.body.dataset.mode = '2d';
    if (avatarInited) AV().show(false);
    el.canvas.style.display = '';
    fit();
  }
  $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderApLandmarks(); renderLmPrompt();
  $('#btnReset').textContent = is3d() ? 'Reset avatar' : 'Reset this photo';
  setMorph(1, true); renderPinList(); renderRoleSelects(); updateHistoryButtons(); draw();
}
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
document.body.dataset.mode = '2d';

/* ───────────────────────── Photo alignment dialog (3D) ───────────────────────── */
const align = { role: null, view: null, a: null, scale: 1, ox: 0, oy: 0, drag: null };
function openAlign(role) {
  const A = AV(); const v = A && A.photos[role]; if (!v) return;
  align.role = role; align.view = v; align.a = { ...(A.getAlign(role) || A.defaultAlign(v)) };
  el.alignTitle.textContent = `Align ${role === 'front' ? 'front' : role + ' profile'} photo — ${v.name}`;
  el.alignFlip.checked = !!align.a.flip;
  el.alignSize.value = Math.round(align.a.s / v.H * 100);
  el.alignModal.hidden = false;
  requestAnimationFrame(drawAlign);
}
function drawAlign() {
  const c = el.alignCanvas, v = align.view, a = align.a; if (!v || el.alignModal.hidden) return;
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const sc = Math.min(r.width / v.W, r.height / v.H) * 0.96;
  align.scale = sc; align.ox = (r.width - v.W * sc) / 2; align.oy = (r.height - v.H * sc) / 2;
  g.drawImage(v.before, align.ox, align.oy, v.W * sc, v.H * sc);
  const toScreen = (X, Y) => [align.ox + (a.cx + (a.flip ? -X : X) * a.s) * sc, align.oy + (a.cy - Y * a.s) * sc];
  const pts = AV().silhouette(align.role);
  g.beginPath(); pts.forEach(([X, Y], i) => { const [x, y] = toScreen(X, Y); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath();
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.45)'; g.stroke();
  g.lineWidth = 1.5; g.strokeStyle = '#4fe0e6'; g.stroke();
  g.font = '600 12px ' + getComputedStyle(document.body).fontFamily; g.textBaseline = 'middle';
  for (const [name, Y] of AV().GUIDES) {
    const [x0, y] = toScreen(-1.1, Y), [x1] = toScreen(1.1, Y);
    g.beginPath(); g.moveTo(Math.min(x0, x1), y); g.lineTo(Math.max(x0, x1), y);
    g.setLineDash([5, 4]); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
    const tw = g.measureText(name).width + 10;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(Math.max(x0, x1) + 4, y - 9, tw, 18);
    g.fillStyle = '#fff'; g.fillText(name, Math.max(x0, x1) + 9, y);
  }
}
el.alignCanvas.addEventListener('pointerdown', e => { align.drag = { x: e.clientX, y: e.clientY, cx: align.a.cx, cy: align.a.cy }; el.alignCanvas.setPointerCapture(e.pointerId); });
el.alignCanvas.addEventListener('pointermove', e => {
  if (!align.drag) return;
  align.a.cx = align.drag.cx + (e.clientX - align.drag.x) / align.scale;
  align.a.cy = align.drag.cy + (e.clientY - align.drag.y) / align.scale;
  drawAlign();
});
['pointerup', 'pointercancel'].forEach(ev => el.alignCanvas.addEventListener(ev, () => { align.drag = null; }));
el.alignCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0012), r = el.alignCanvas.getBoundingClientRect();
  const px = (e.clientX - r.left - align.ox) / align.scale, py = (e.clientY - r.top - align.oy) / align.scale;
  align.a.cx = px + (align.a.cx - px) * f; align.a.cy = py + (align.a.cy - py) * f;
  align.a.s = clamp(align.a.s * f, align.view.H * 0.1, align.view.H * 0.8);
  el.alignSize.value = Math.round(align.a.s / align.view.H * 100);
  drawAlign();
}, { passive: false });
el.alignSize.addEventListener('input', () => { align.a.s = +el.alignSize.value / 100 * align.view.H; drawAlign(); });
el.alignFlip.addEventListener('change', () => { align.a.flip = el.alignFlip.checked; drawAlign(); });
$('#alignReset').addEventListener('click', () => { align.a = AV().defaultAlign(align.view); el.alignFlip.checked = false; el.alignSize.value = Math.round(align.a.s / align.view.H * 100); drawAlign(); });
$('#alignCancel').addEventListener('click', () => { el.alignModal.hidden = true; });
$('#alignDone').addEventListener('click', () => {
  el.alignModal.hidden = true;
  AV().setAlign(align.role, align.a); AV().rebake(); markDirty();
});
el.alignModal.addEventListener('click', e => { if (e.target === el.alignModal) el.alignModal.hidden = true; });
window.addEventListener('resize', () => { if (!el.alignModal.hidden) drawAlign(); });
syncFields(); renderTabs(); renderPinList(); renderDocs(); setTool('push'); setCompare('slider'); renderApLandmarks();
(async () => {
  try {
    const saved = await idbGet('current');
    if (saved && ((saved.views && saved.views.length) || (saved.docs && saved.docs.length))) { await restore(saved); setStatus(`Restored the case from ${new Date(saved.savedAt).toLocaleString()} — use New case to clear it.`); }
  } catch { /* no saved case */ }
})();

// Small test hook (not used by the UI).
window.__morph = { state, addPhotos, addDocs, loadModelFile, generateModel, ensureLandmarks, applyPushes2D, serialize, restore, dab, renderAll, currentView, fit, draw, setMode, ensureAvatar, openAlign };
})();
