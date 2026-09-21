/* Morph Studio — automatic facial landmark detection (runs in the browser).
   Uses the vendored face-api (68-point landmarks) to find the pupils, nasion, rhinion, nose tip,
   subnasale and chin on a front-facing photo or on a rendered front view of the 3D model.
   Returns null when no face is found (e.g. a true profile), so the caller can fall back. */
let api = null, loaded = null, backend = null;
async function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    api = await import('./vendor/faceapi/face-api.esm.js');
    // The bundle registers a WASM backend at the highest priority, but its .wasm binaries are not shipped
    // here, so pick WebGL explicitly and fall back to the CPU backend before touching any model.
    const tf = api.tf;
    let ok = false;
    for (const name of ['webgl', 'cpu']) {
      try { ok = await tf.setBackend(name); if (ok) { await tf.ready(); break; } } catch { ok = false; }
    }
    if (!ok) throw new Error('no TensorFlow backend available');
    backend = tf.getBackend();
    const base = new URL('./vendor/faceapi/model/', import.meta.url).href;
    await Promise.all([api.nets.tinyFaceDetector.loadFromUri(base), api.nets.faceLandmark68Net.loadFromUri(base)]);
    return api;
  })();
  return loaded;
}
async function loadSsd() { const a = await load(); if (!a.nets.ssdMobilenetv1.isLoaded) await a.nets.ssdMobilenetv1.loadFromUri(new URL('./vendor/faceapi/model/', import.meta.url).href); return a; }
const mean = pts => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/* Map the 68 iBUG points to Morph Studio's anatomical landmarks. Image x grows to the viewer's right,
   so points 36–41 (viewer's left eye) are the PATIENT'S RIGHT eye. */
function mapLandmarks(pts) {
  const eyeR = mean(pts.slice(36, 42)), eyeL = mean(pts.slice(42, 48));
  const nasion = pts[27], rhinion = lerp(pts[28], pts[29], 0.5), pronasale = pts[30], subnasale = pts[33];
  const menton = pts[8], ipd = Math.hypot(eyeL.x - eyeR.x, eyeL.y - eyeR.y);
  const pxPerMm = ipd / 63;
  // Pogonion (most forward chin point) sits ~7 mm above the menton on a front view.
  const pogonion = { x: menton.x, y: menton.y - 7 * pxPerMm };
  // Yaw estimate: how far the nose tip sits from the eye midpoint, in eye widths.
  const midEye = mean([eyeR, eyeL]);
  const yaw = (pronasale.x - midEye.x) / (ipd || 1);
  return { landmarks: { pupil_r: eyeR, pupil_l: eyeL, nasion, rhinion, pronasale, subnasale, pogonion }, ipd, yaw, menton, all: pts };
}
/* Detect on a canvas/image element. Returns { landmarks, ipd, yaw, score, box } or null. */
export async function detectFace(source, opts = {}) {
  const a = await load();
  let det = null;
  for (const inputSize of opts.sizes || [512, 320, 608]) {
    det = await a.detectSingleFace(source, new a.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 })).withFaceLandmarks();
    if (det) break;
  }
  if (!det && opts.thorough !== false) {
    try { await loadSsd(); det = await a.detectSingleFace(source, new a.SsdMobilenetv1Options({ minConfidence: 0.25 })).withFaceLandmarks(); } catch (e) { console.warn('ssd detector unavailable', e); }
  }
  if (!det) return null;
  const m = mapLandmarks(det.landmarks.positions.map(p => ({ x: p.x, y: p.y })));
  return { ...m, score: det.detection.score, box: det.detection.box };
}
export function isFrontal(result) { return result && Math.abs(result.yaw) < 0.22; }
window.FaceDetect = { detectFace, isFrontal, load, backend: () => backend };
window.dispatchEvent(new Event('facedetect-ready'));
