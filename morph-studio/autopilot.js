/* Morph Studio — AI autopilot.
   Turns the surgeon's planned changes, consultation notes and the patient's feedback into
   anatomical edits (in millimetres / degrees) and applies them live to the 3D model and to
   the photos. Understanding comes from Claude through /api/autopilot when the server has an
   API key, with a built-in phrase parser as the offline fallback. Edits are computed here,
   deterministically, from the landmarks. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────────── Anatomy: derived points (mm offsets from the 7 confirmed landmarks) ─────────────
   Offsets are [lateral (towards that side), superior, anterior] in mm. */
const DERIVED = {
  dorsum_upper: { from: ['nasion', 'rhinion'], mix: 0.5 },
  supratip:     { from: ['rhinion', 'pronasale'], mix: 0.7 },
  columella:    { from: 'subnasale', off: [0, 2, 4] },
  lip_upper:    { from: 'subnasale', off: [0, -11, 0] },
  lip_lower:    { from: 'subnasale', off: [0, -26, -1] },
  glabella:     { from: 'nasion', off: [0, 13, 2] },
  submental:    { from: 'pogonion', off: [0, -24, -16] },
  alar_l:       { from: 'pronasale', off: [11, -5, -9], side: 'l' }, alar_r: { from: 'pronasale', off: [11, -5, -9], side: 'r' },
  bridge_l:     { from: 'rhinion', off: [6, 0, -3], side: 'l' },     bridge_r: { from: 'rhinion', off: [6, 0, -3], side: 'r' },
  tipside_l:    { from: 'pronasale', off: [6, 0, -2], side: 'l' },   tipside_r: { from: 'pronasale', off: [6, 0, -2], side: 'r' },
  brow_l:       { from: 'pupil_l', off: [2, 22, 0], side: 'l' },     brow_r: { from: 'pupil_r', off: [2, 22, 0], side: 'r' },
  zygion_l:     { from: 'pupil_l', off: [20, -25, -10], side: 'l' }, zygion_r: { from: 'pupil_r', off: [20, -25, -10], side: 'r' },
  gonion_l:     { from: 'pogonion', off: [48, 8, -42], side: 'l' },  gonion_r: { from: 'pogonion', off: [48, 8, -42], side: 'r' },
  nasolabial_l: { from: 'pronasale', off: [19, -17, -14], side: 'l' }, nasolabial_r: { from: 'pronasale', off: [19, -17, -14], side: 'r' },
  chinside_l:   { from: 'pogonion', off: [11, 0, -4], side: 'l' },   chinside_r: { from: 'pogonion', off: [11, 0, -4], side: 'r' },
};

/* Each operation → a list of pushes. dir: anterior|posterior|superior|inferior|medial|lateral|normal|-normal|smooth|restore.
   mm may be a function of the requested amount. r = radius in mm. share splits the amount across paired pushes. */
const OPS = {
  dorsum:   { reduce: [['rhinion', 'posterior', 13], ['dorsum_upper', 'posterior', 10, 0.6], ['supratip', 'posterior', 9, 0.4]], augment: [['rhinion', 'anterior', 13], ['dorsum_upper', 'anterior', 10, 0.7]] },
  radix:    { reduce: [['nasion', 'posterior', 12]], augment: [['nasion', 'anterior', 12]] },
  tip:      { reduce: [['pronasale', 'posterior', 12]], augment: [['pronasale', 'anterior', 12]], project: [['pronasale', 'anterior', 12]], deproject: [['pronasale', 'posterior', 12]],
              lift: [['pronasale', 'superior', 12], ['pronasale', 'posterior', 12, 0.3]], lower: [['pronasale', 'inferior', 12], ['pronasale', 'anterior', 12, 0.2]],
              narrow: [['tipside_l', 'medial', 7, 0.5], ['tipside_r', 'medial', 7, 0.5]], widen: [['tipside_l', 'lateral', 7, 0.5], ['tipside_r', 'lateral', 7, 0.5]] },
  supratip: { reduce: [['supratip', 'posterior', 9]], augment: [['supratip', 'anterior', 9]] },
  alar_base:{ narrow: [['alar_l', 'medial', 8, 0.5], ['alar_r', 'medial', 8, 0.5]], reduce: [['alar_l', 'medial', 8, 0.5], ['alar_r', 'medial', 8, 0.5]], widen: [['alar_l', 'lateral', 8, 0.5], ['alar_r', 'lateral', 8, 0.5]] },
  nasal_bridge: { narrow: [['bridge_l', 'medial', 8, 0.5], ['bridge_r', 'medial', 8, 0.5]], widen: [['bridge_l', 'lateral', 8, 0.5], ['bridge_r', 'lateral', 8, 0.5]], reduce: [['rhinion', 'posterior', 13]], augment: [['rhinion', 'anterior', 13]] },
  columella:{ lift: [['columella', 'superior', 6]], lower: [['columella', 'inferior', 6]], reduce: [['columella', 'posterior', 6]], augment: [['columella', 'anterior', 6]] },
  chin:     { augment: [['pogonion', 'anterior', 18]], project: [['pogonion', 'anterior', 18]], reduce: [['pogonion', 'posterior', 18]], deproject: [['pogonion', 'posterior', 18]],
              lift: [['pogonion', 'superior', 16]], lower: [['pogonion', 'inferior', 16]], narrow: [['chinside_l', 'medial', 12, 0.5], ['chinside_r', 'medial', 12, 0.5]], widen: [['chinside_l', 'lateral', 12, 0.5], ['chinside_r', 'lateral', 12, 0.5]] },
  jawline:  { augment: [['gonion_l', 'normal', 20], ['gonion_r', 'normal', 20]], widen: [['gonion_l', 'lateral', 20], ['gonion_r', 'lateral', 20]], reduce: [['gonion_l', '-normal', 20], ['gonion_r', '-normal', 20]], narrow: [['gonion_l', 'medial', 20], ['gonion_r', 'medial', 20]] },
  cheeks:   { augment: [['zygion_l', 'normal', 18], ['zygion_r', 'normal', 18]], reduce: [['zygion_l', '-normal', 18], ['zygion_r', '-normal', 18]] },
  lips:     { augment: [['lip_upper', 'normal', 9, 0.8], ['lip_lower', 'normal', 10]], reduce: [['lip_upper', '-normal', 9, 0.8], ['lip_lower', '-normal', 10]] },
  lip_upper:{ augment: [['lip_upper', 'normal', 9]], reduce: [['lip_upper', '-normal', 9]], lift: [['lip_upper', 'superior', 9]] },
  lip_lower:{ augment: [['lip_lower', 'normal', 10]], reduce: [['lip_lower', '-normal', 10]] },
  brow:     { lift: [['brow_l', 'superior', 15], ['brow_r', 'superior', 15]], lower: [['brow_l', 'inferior', 15], ['brow_r', 'inferior', 15]] },
  forehead: { augment: [['glabella', 'normal', 24]], reduce: [['glabella', '-normal', 24]] },
  nasolabial_fold: { reduce: [['nasolabial_l', 'normal', 12], ['nasolabial_r', 'normal', 12]], augment: [['nasolabial_l', 'normal', 12], ['nasolabial_r', 'normal', 12]] },
  neck:     { reduce: [['submental', 'posterior', 22], ['submental', 'superior', 22, 0.5]], augment: [['submental', 'anterior', 22]] },
};
const TARGETS = Object.keys(OPS);
const ACTIONS = ['reduce', 'augment', 'narrow', 'widen', 'lift', 'lower', 'project', 'deproject', 'smooth', 'restore'];
const ALIASES = { raise: 'augment', remove: 'reduce', shave: 'reduce', refine: 'narrow', define: 'augment', fill: 'augment', enhance: 'augment', rotate_up: 'lift', rotate_down: 'lower', retract: 'lift', advance: 'project', setback: 'deproject', soften: 'smooth' };
const DEG_TO_MM = 0.35; // tip rotation: ~20 mm lever → 0.35 mm per degree

function normaliseOp(op) {
  if (!op || typeof op !== 'object') return null;
  let target = String(op.target || '').toLowerCase().replace(/[\s-]+/g, '_'), action = String(op.action || '').toLowerCase().replace(/[\s-]+/g, '_');
  const tmap = { hump: 'dorsum', dorsal_hump: 'dorsum', bridge: 'dorsum', nose_bridge: 'nasal_bridge', nasal_tip: 'tip', nose_tip: 'tip', alar: 'alar_base', ala: 'alar_base', nostrils: 'alar_base', nostril: 'alar_base', alar_flare: 'alar_base', jaw: 'jawline', mandible: 'jawline', cheek: 'cheeks', malar: 'cheeks', lip: 'lips', upper_lip: 'lip_upper', lower_lip: 'lip_lower', brows: 'brow', eyebrow: 'brow', eyebrows: 'brow', glabella: 'forehead', nasolabial: 'nasolabial_fold', submental: 'neck', double_chin: 'neck', mentum: 'chin', nose: 'dorsum' };
  if (tmap[target]) target = tmap[target];
  action = ALIASES[action] || action;
  if (!TARGETS.includes(target) || !ACTIONS.includes(action)) return null;
  let mm = Number(op.amount_mm != null ? op.amount_mm : op.mm);
  if (!(mm > 0) && op.amount_deg > 0) mm = Number(op.amount_deg) * DEG_TO_MM;
  if (!(mm > 0)) mm = action === 'narrow' && target === 'tip' ? 1.5 : 2;
  mm = Math.min(mm, 12);
  const side = ['left', 'right', 'both'].includes(op.side) ? op.side : 'both';
  return { target, action, mm, side, note: String(op.note || '').slice(0, 120) };
}

/* Resolve an op to concrete pushes for an adapter: { point(name) → vec|null, axis(name, side) → unit vec|null, dims: 2|3 }. */
function resolve(op, adapter) {
  let table = OPS[op.target][op.action];
  if (!table && (op.action === 'smooth' || op.action === 'restore')) {
    const anchor = { dorsum: 'rhinion', radix: 'nasion', tip: 'pronasale', supratip: 'supratip', alar_base: 'alar_l', nasal_bridge: 'rhinion', columella: 'columella', chin: 'pogonion', jawline: 'gonion_l', cheeks: 'zygion_l', lips: 'lip_upper', lip_upper: 'lip_upper', lip_lower: 'lip_lower', brow: 'brow_l', forehead: 'glabella', nasolabial_fold: 'nasolabial_l', neck: 'submental' }[op.target];
    table = [[anchor, op.action, 16], [anchor.replace(/_l$/, '_r'), op.action, 16]].filter((r, i, a) => a.findIndex(x => x[0] === r[0]) === i);
  }
  if (!table) return { pushes: [], skipped: `${op.action} is not defined for ${op.target}` };
  const pushes = [], skipped = [];
  for (const [name, dir, r, share = 1] of table) {
    const sideOf = name.endsWith('_l') ? 'left' : name.endsWith('_r') ? 'right' : null;
    if (sideOf && op.side !== 'both' && op.side !== sideOf) continue;
    const point = adapter.point(name); if (!point) { skipped.push(name); continue; }
    if (dir === 'smooth' || dir === 'restore') { pushes.push({ name, point, mode: dir, mm: Math.min(1, op.mm / 4), radiusMm: r }); continue; }
    let sign = 1, d = dir;
    if (d === '-normal') { sign = -1; d = 'normal'; }
    if (d === 'normal') { if (adapter.dims === 3) { pushes.push({ name, point, useNormal: true, dir: null, mm: sign * op.mm * share, radiusMm: r }); continue; } d = sign > 0 ? 'anterior' : 'posterior'; sign = 1; }
    const axis = adapter.axis(d, sideOf || (op.side === 'left' ? 'left' : op.side === 'right' ? 'right' : null), name);
    if (!axis) { skipped.push(`${name} (${d} not visible in this view)`); continue; }
    pushes.push({ name, point, dir: axis, mm: sign * op.mm * share, radiusMm: r, mode: axis.mode || 'move' });
  }
  const scale = op.side === 'both' ? 1 : 1; // paired pushes already carry their share
  return { pushes, skipped: skipped.length ? skipped.join(', ') : '' };
}

function derivedPoint(name, primary, frame) {
  if (primary(name)) return primary(name);
  const d = DERIVED[name]; if (!d) return null;
  if (d.mix != null) { const a = primary(d.from[0]), b = primary(d.from[1]); if (!a || !b) return null; return frame.mix(a, b, d.mix); }
  const base = primary(d.from); if (!base) return null;
  const side = d.side === 'l' ? 'left' : d.side === 'r' ? 'right' : null;
  return frame.offset(base, d.off, side);
}

/* 3D adapter over Avatar3D. */
function adapter3d(A) {
  const V = (x, y, z) => ({ x, y, z });
  const pri = n => { const p = A.landmarkPoint(n); return p ? V(p.x, p.y, p.z) : null; };
  const u = mm => A.mmToUnits(mm);
  const lateral = side => (side === 'left' ? V(1, 0, 0) : side === 'right' ? V(-1, 0, 0) : null);
  const frame = {
    mix: (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t),
    offset: (b, off, side) => { const l = lateral(side) || V(0, 0, 0); return V(b.x + l.x * u(off[0]), b.y + u(off[1]), b.z + u(off[2])); },
  };
  return {
    dims: 3,
    point: n => derivedPoint(n, pri, frame),
    axis: (d, side) => {
      if (d === 'anterior') return V(0, 0, 1); if (d === 'posterior') return V(0, 0, -1);
      if (d === 'superior') return V(0, 1, 0); if (d === 'inferior') return V(0, -1, 0);
      if (d === 'lateral') return lateral(side); if (d === 'medial') { const l = lateral(side); return l && V(-l.x, 0, 0); }
      return null;
    },
    toEngine: p => ({ ...p, point: new A.Vec3(p.point.x, p.point.y, p.point.z), dir: p.dir ? new A.Vec3(p.dir.x, p.dir.y, p.dir.z) : new A.Vec3(0, 0, 1) }),
  };
}
/* 2D adapter over a photo view (image pixels; y grows downwards). */
function adapter2d(view, M) {
  const lm = view.landmarks || {}; const info = M.viewInfo(view); const pxPerMm = info.pxPerMm;
  const V = (x, y) => ({ x, y });
  const pri = n => (lm[n] ? V(lm[n].x, lm[n].y) : null);
  const front = info.kind === 'front';
  const noseSign = (() => { if (front || !lm.pronasale || !lm.nasion) return 1; return lm.pronasale.x >= lm.nasion.x ? 1 : -1; })();
  const lateral = side => (front ? (side === 'left' ? V(1, 0) : side === 'right' ? V(-1, 0) : null) : null);
  const frame = {
    mix: (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
    offset: (b, off, side) => {
      if (front) { const l = lateral(side) || V(0, 0); return V(b.x + l.x * off[0] * pxPerMm, b.y - off[1] * pxPerMm); }
      return V(b.x + noseSign * off[2] * pxPerMm, b.y - off[1] * pxPerMm);
    },
  };
  return {
    dims: 2, pxPerMm,
    point: n => derivedPoint(n, pri, frame),
    axis: d => {
      if (d === 'superior') return V(0, -1); if (d === 'inferior') return V(0, 1);
      if (front) {
        if (d === 'anterior') return { mode: 'bloat' }; if (d === 'posterior') return { mode: 'pucker' };
        return null; // lateral/medial resolved per side below
      }
      if (d === 'anterior') return V(noseSign, 0); if (d === 'posterior') return V(-noseSign, 0);
      return null;
    },
  };
}
// front-view lateral/medial need the side; wrap axis to handle it
function withSides(ad, view) {
  const base = ad.axis;
  ad.axis = (d, side) => {
    if (ad.dims === 2 && (d === 'lateral' || d === 'medial')) {
      if (!side) return null;
      const info = window.MorphAPI.viewInfo(view); if (info.kind !== 'front') return null;
      const l = side === 'left' ? 1 : -1; return { x: d === 'lateral' ? l : -l, y: 0 };
    }
    return base(d, side);
  };
  return ad;
}

/* ───────────── Built-in phrase parser (offline fallback) ───────────── */
const WORD_AMOUNT = [[/\b(very slight|tiny|touch|hair|minimal)\b/, 0.7], [/\b(slight|slightly|subtle|subtly|a little|a bit|little|gentle|gently|mild|mildly|small)\b/, 1], [/\b(moderate|moderately|some|somewhat|medium)\b/, 2], [/\b(significant|significantly|substantial|substantially|a lot|much|strong|strongly|marked|markedly|big|major)\b/, 4]];
const TARGET_RX = [
  [/\bnasolabial\b/, 'nasolabial_fold'], [/\b(columella|columellar)\b/, 'columella'], [/\b(supratip|supra-tip)\b/, 'supratip'],
  [/\b(alar|ala|alae|nostril|nostrils|nasal base|alar base|flare|flaring)\b/, 'alar_base'], [/\b(radix)\b/, 'radix'],
  [/\b(hump|dorsum|dorsal|dorsal hump|nasal bridge|bridge of the nose|bridge)\b/, 'dorsum'], [/\b(tip|nasal tip|nose tip)\b/, 'tip'],
  [/\b(upper lip)\b/, 'lip_upper'], [/\b(lower lip)\b/, 'lip_lower'], [/\b(lips?|mouth|vermilion)\b/, 'lips'],
  [/\b(chin|genioplasty|mentum|mental)\b/, 'chin'], [/\b(jaw|jawline|jaw line|mandible|mandibular|gonial|jaw angle)\b/, 'jawline'],
  [/\b(cheek|cheeks|cheekbone|cheekbones|malar|zygoma|zygomatic|midface)\b/, 'cheeks'], [/\b(brow|brows|eyebrow|eyebrows|forehead lift)\b/, 'brow'],
  [/\b(forehead|glabella)\b/, 'forehead'], [/\b(neck|submental|double chin|under the chin|jowl|jowls)\b/, 'neck'], [/\b(nose|nasal|rhinoplasty)\b/, 'nose'],
];
const ACTION_RX = [
  [/\b(rotate|rotation|rotated).{0,30}\b(up|upward|upwards|cephalic|cephalically)|\b(upturn|upturned|up-turn)\b|\b(lift|lifted|lifting|raise the tip|elevate|elevated)\b/, 'lift'],
  [/\b(rotate|rotation).{0,30}\b(down|downward|caudal|caudally)|\b(derotate|de-rotate|drop|dropped|droop|lower|lowered|lowering|lengthen)\b/, 'lower'],
  [/\b(narrow|narrower|narrowing|thin|thinner|slim|slimmer|refine|refined|refinement|define|defined|definition|tighten|pinch)\b/, 'narrow'],
  [/\b(widen|wider|broaden|broader|flare out)\b/, 'widen'],
  [/\b(project|projection|projecting|advance|advancement|forward|bring out)\b/, 'project'],
  [/\b(deproject|de-project|set back|setback|retrude|retrusion|push back|less projection|reduce projection)\b/, 'deproject'],
  [/\b(reduce|reduced|reduction|remove|removal|removed|shave|shaved|take down|taken down|lower the hump|smaller|less prominent|flatten|flattened|resect|resection|decrease|trim|slimmer|shrink|smooth out the hump)\b/, 'reduce'],
  [/\b(augment|augmented|augmentation|increase|increased|build up|build|add volume|fill|filler|filled|enhance|enhanced|enhancement|fuller|plump|plumper|volumise|volumize|implant|graft|bigger|larger|more prominent|strengthen|stronger|raise|raised)\b/, 'augment'],
  [/\b(smooth|smoothen|soften|softened|even out)\b/, 'smooth'],
  [/\b(restore|revert|original|undo the change|back to normal)\b/, 'restore'],
];
function parseLocal(text) {
  const ops = [], notes = [];
  const clauses = String(text).replace(/\r/g, '').split(/(?<=[.;!?\n])\s+|\n+|,\s+(?=(?:and\s+)?(?:also\s+)?[a-z])|\s+and\s+(?=[a-z]+\s+(?:the\s+)?[a-z])/i).map(c => c.trim()).filter(Boolean);
  for (const raw of clauses) {
    const c = raw.toLowerCase();
    if (/\b(no|not|without|avoid|leave|unchanged|no change|don't|do not|declined|does not want|doesn't want|not keen|rather not)\b/.test(c) && !/\b(not too|not much|no more than)\b/.test(c)) continue;
    let target = null; for (const [rx, t] of TARGET_RX) if (rx.test(c)) { target = t; break; }
    if (!target) continue;
    let action = null; for (const [rx, a] of ACTION_RX) if (rx.test(c)) { action = a; break; }
    if (!action && /\b(hump)\b/.test(c)) action = 'reduce';
    if (!action) continue;
    let mm = 0; const num = c.match(/(\d+(?:[.,]\d+)?)\s*(mm|millimet(?:re|er)s?|°|deg|degrees?)/); const half = /\b(half|0\.5)\s*(a\s*)?(mm|millimet)/.test(c);
    if (num) { mm = parseFloat(num[1].replace(',', '.')); if (/°|deg/.test(num[2])) mm *= DEG_TO_MM; } else if (half) mm = 0.5;
    else for (const [rx, v] of WORD_AMOUNT) if (rx.test(c)) { mm = v; break; }
    const side = /\b(left)\b/.test(c) && !/\bright\b/.test(c) ? 'left' : /\bright\b/.test(c) && !/\bleft\b/.test(c) ? 'right' : 'both';
    const push = (t, a, m) => { const op = normaliseOp({ target: t, action: a, amount_mm: m, side, note: raw.slice(0, 120) }); if (op) ops.push(op); };
    if (target === 'nose') {
      if (action === 'narrow') { push('nasal_bridge', 'narrow', mm); push('alar_base', 'narrow', mm); }
      else if (action === 'reduce') { push('dorsum', 'reduce', mm); push('tip', 'reduce', mm ? mm * 0.6 : 0); }
      else if (action === 'augment' || action === 'project') push('dorsum', 'augment', mm);
      else if (action === 'lift') push('tip', 'lift', mm); else if (action === 'lower') push('tip', 'lower', mm);
      else if (action === 'widen') push('alar_base', 'widen', mm); else push('dorsum', action, mm);
    } else push(target, action, mm);
  }
  return { ops, notes };
}
/* Relative feedback ("a bit less", "too much on the tip", "more") applied to previous steps. */
function parseRelative(text, history) {
  const c = String(text).toLowerCase();
  const less = /\b(too much|too strong|too big|too far|overdone|less|dial back|tone down|bit much|reduce the change|not that much|soften the change|half)\b/.test(c);
  const more = /\b(more|further|not enough|stronger|go further|bit more|increase the change|still)\b/.test(c) && !less;
  if (!less && !more) return null;
  let target = null; for (const [rx, t] of TARGET_RX) if (rx.test(c)) { target = t; break; }
  const prev = [...history].reverse().find(step => step.ops.some(o => !target || o.target === target || (target === 'nose' && /dorsum|tip|alar|bridge|radix/.test(o.target))));
  if (!prev) return null;
  const frac = /\bhalf\b/.test(c) ? 0.5 : less ? 0.5 : 0.5;
  const ops = prev.ops.filter(o => !target || o.target === target || (target === 'nose' && /dorsum|tip|alar|bridge|radix/.test(o.target))).map(o => ({ ...o, mm: o.mm * frac, action: less ? invert(o.action) : o.action, note: (less ? 'Reduced by half: ' : 'Increased by half: ') + o.note }));
  return ops.filter(Boolean);
}
const INVERSES = { reduce: 'augment', augment: 'reduce', narrow: 'widen', widen: 'narrow', lift: 'lower', lower: 'lift', project: 'deproject', deproject: 'project' };
const invert = a => INVERSES[a] || null;

/* ───────────── Applying a plan ───────────── */
function describeOp(o) {
  const verbs = { reduce: 'reduce', augment: 'augment', narrow: 'narrow', widen: 'widen', lift: 'lift', lower: 'lower', project: 'project', deproject: 'set back', smooth: 'smooth', restore: 'restore' };
  const names = { dorsum: 'nasal dorsum', radix: 'radix', tip: 'nasal tip', supratip: 'supratip', alar_base: 'alar base', nasal_bridge: 'nasal bridge', columella: 'columella', chin: 'chin', jawline: 'jawline', cheeks: 'cheeks', lips: 'lips', lip_upper: 'upper lip', lip_lower: 'lower lip', brow: 'brows', forehead: 'forehead', nasolabial_fold: 'nasolabial folds', neck: 'submental area' };
  const amt = o.action === 'smooth' || o.action === 'restore' ? '' : ` by ${o.mm.toFixed(1)} mm`;
  return `${verbs[o.action]} the ${names[o.target]}${amt}${o.side !== 'both' ? ` (${o.side})` : ''}`;
}
function applyOps(ops) {
  const M = window.MorphAPI, A = window.Avatar3D, results = [], targets = [];
  const clean = ops.map(normaliseOp).filter(Boolean);
  if (!clean.length) return { results: ['Nothing to apply.'], targets, ops: clean };
  // 3D model
  if (A && A.available && A.model) {
    if (!A.landmarksReady()) results.push('3D model: skipped — confirm the landmarks first (Landmarks tool).');
    else {
      const ad = adapter3d(A); const pushes = [], skipped = [];
      for (const op of clean) { const r = resolve(op, ad); pushes.push(...r.pushes.map(ad.toEngine)); if (r.skipped) skipped.push(r.skipped); }
      if (pushes.length) { A.applyPushes(pushes); targets.push('3d'); results.push(`3D model: ${pushes.length} adjustment${pushes.length > 1 ? 's' : ''} applied${A.scaleSource === 'assumed' ? ' (scale not calibrated — millimetres are approximate)' : ''}.`); }
      if (skipped.length) results.push('3D model, not applied: ' + skipped.join('; '));
    }
  }
  // photos
  for (const view of M.views()) {
    const info = M.viewInfo(view);
    if (!view.landmarks) { results.push(`${view.name}: skipped — set landmarks on this photo first.`); continue; }
    if (info.kind === 'other') { results.push(`${view.name}: skipped — mark this photo as front or profile.`); continue; }
    const ad = withSides(adapter2d(view, M), view); const pushes = [], skipped = [];
    for (const op of clean) { const r = resolve(op, ad); pushes.push(...r.pushes); if (r.skipped) skipped.push(r.skipped); }
    if (pushes.length) { M.applyPushes2D(view, pushes.map(p => ({ x: p.point.x, y: p.point.y, vx: p.dir ? p.dir.x : 0, vy: p.dir ? p.dir.y : 0, mode: p.mode || 'move', px: Math.abs(p.mm) * ad.pxPerMm * (p.mm < 0 && p.mode === 'move' ? -1 : 1), sign: Math.sign(p.mm) || 1, radiusPx: p.radiusMm * ad.pxPerMm }))); targets.push(view); results.push(`${view.name}: ${pushes.length} adjustment${pushes.length > 1 ? 's' : ''} applied.`); }
    if (skipped.length) results.push(`${view.name}, not applied: ${skipped.join('; ')}`);
  }
  return { results, targets, ops: clean };
}

/* ───────────── Chat state & UI ───────────── */
const chat = { messages: [], steps: [], busy: false, engine: '' };
const el = { log: $('#apLog'), input: $('#apInput'), send: $('#apSend'), plan: $('#apPlan'), notes: $('#apNotes'), undo: $('#apUndo'), engine: $('#apEngine'), status: $('#apStatus') };

function render() {
  el.log.innerHTML = chat.messages.map(m => `<div class="ap-msg ap-${m.role}">${m.role === 'assistant' ? '<span class="ap-who">Autopilot</span>' : m.role === 'system' ? '' : '<span class="ap-who">You</span>'}<div>${m.html || esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('') || '<p class="hint">Describe the change in plain words, or press <strong>Apply planned changes</strong>. Patient feedback works too: “the tip looks too upturned — a bit less”.</p>';
  el.log.scrollTop = el.log.scrollHeight;
  el.undo.hidden = !chat.steps.length;
  el.engine.textContent = chat.engine || '';
  window.MorphAPI.saveChat(chat.messages.map(m => ({ role: m.role, text: m.text })));
}
function add(role, text, html) { chat.messages.push({ role, text, html }); render(); }
window.MorphAPI.loadChat = msgs => { chat.messages = (msgs || []).map(m => ({ role: m.role, text: m.text })); chat.steps = []; render(); };

async function askServer(userText, isDocument) {
  const M = window.MorphAPI, A = window.Avatar3D;
  const context = {
    procedure: M.procedure(), notes: M.notes(),
    model3d: A && A.model ? { kind: A.model.kind, landmarks: A.landmarksReady(), scale: A.scaleSource } : null,
    photos: M.views().map(v => ({ name: v.name, kind: M.viewInfo(v).kind, landmarks: !!v.landmarks })),
    applied: chat.steps.map(s => s.ops.map(describeOp).join('; ')),
    measurements: A && A.measures ? A.measures.map((m, i) => { const v = A.measureValues(i); return v ? `#${i + 1}: before ${v.before.toFixed(1)} mm, now ${v.after.toFixed(1)} mm` : ''; }).filter(Boolean) : [],
  };
  const history = chat.messages.filter(m => m.role !== 'system').slice(-12).map(m => ({ role: m.role, content: m.text }));
  const res = await (window.MorphAPI.apiFetch || fetch)('api/autopilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: userText, history, context: { ...context, is_document: !!isDocument } }) });
  if (res.status === 503) { const b = await res.json().catch(() => ({})); chat.noKeyMessage = b.message || ''; return null; } // no key → offline parser
  if (!res.ok) throw new Error(`AI service error (${res.status})`);
  return res.json();
}
async function handle(userText, source) {
  if (chat.busy) return;
  const text = String(userText || '').trim(); if (!text) return;
  chat.busy = true; el.send.disabled = true; el.status.textContent = 'Thinking…';
  add('user', source ? `${source}\n${text.length > 700 ? text.slice(0, 700) + ' …' : text}` : text);
  try {
    if (/^\s*(undo|undo that|undo last|go back)\s*[.!]?\s*$/i.test(text)) { undoStep(); add('assistant', 'Undone.'); return; }
    let plan = null;
    try { plan = await askServer(text, /^Notes from|^Planned changes:|^Consultation notes:/.test(source || '')); } catch (e) { plan = null; chat.engine = 'built-in parser (AI service unreachable)'; }
    let ops, reply;
    if (plan && Array.isArray(plan.ops)) { ops = plan.ops.map(normaliseOp).filter(Boolean); reply = plan.reply || ''; chat.engine = plan.engine || 'Claude'; if (plan.questions && plan.questions.length) reply += (reply ? '\n' : '') + plan.questions.join('\n'); }
    else {
      chat.engine = chat.engine || 'built-in parser — connect Claude in AI settings for full understanding';
      ops = parseRelative(text, chat.steps) || parseLocal(text).ops; reply = '';
    }
    if (!ops.length) { add('assistant', reply || 'I could not find a change to make in that. Try something like “reduce the dorsal hump by 2 mm”, “rotate the tip up 5°”, “narrow the alar base 3 mm”, “augment the chin 4 mm”, or “a bit less on the tip”.'); return; }
    const out = applyOps(ops);
    if (out.targets.length) chat.steps.push({ ops: out.ops, targets: out.targets });
    const html = `${reply ? esc(reply).replace(/\n/g, '<br>') + '<br>' : ''}<ul>${out.ops.map(o => `<li>${esc(describeOp(o))}</li>`).join('')}</ul><div class="ap-res">${out.results.map(esc).join('<br>')}</div>`;
    add('assistant', reply + '\n' + out.ops.map(describeOp).join('; ') + '\n' + out.results.join(' '), html);
    window.MorphAPI.markDirty();
  } catch (e) { add('assistant', 'Something went wrong: ' + (e.message || e)); }
  finally { chat.busy = false; el.send.disabled = false; el.status.textContent = ''; }
}
function undoStep() {
  const step = chat.steps.pop(); if (!step) return;
  for (const t of step.targets) { if (t === '3d') window.Avatar3D.undo(); else window.MorphAPI.undoView(t); }
  render();
}
el.send.addEventListener('click', () => { const t = el.input.value; el.input.value = ''; handle(t); });
el.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.send.click(); } });
el.plan.addEventListener('click', () => { const n = window.MorphAPI.notes(); if (!n.plan.trim()) { add('assistant', 'The “Planned changes” box is empty — write the plan there or type it here.'); return; } handle(n.plan, 'Planned changes:'); });
el.notes.addEventListener('click', () => { const n = window.MorphAPI.notes(); if (!n.consultation.trim()) { add('assistant', 'The “Consultation notes” box is empty.'); return; } handle(n.consultation, 'Consultation notes:'); });
el.undo.addEventListener('click', () => { undoStep(); add('assistant', 'Last autopilot step undone.'); });

window.Autopilot = { parseLocal, parseRelative, normaliseOp, resolve, applyOps, handle, say: text => add('assistant', text), applyDocumentText: (text, name) => handle(text, `Notes from “${name}”:`), OPS, DERIVED };
render();
})();
