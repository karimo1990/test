// Morph Studio — AI 3D model generation (Vercel serverless function).
// Builds a realistic 3D head of the patient from the front photo through Meshy's Image to 3D API.
// The browser posts the photo here; this function starts the task, reports progress and hands
// back the finished GLB. Requires MESHY_API_KEY in the deployment's environment variables;
// without it the endpoint answers 503 and the app explains how to enable the feature.
import { meshyKey } from './_keys.js';

const MESHY = 'https://api.meshy.ai/openapi/v1/image-to-3d';
const MESHY_MULTI = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // base64 data URI size accepted from the browser
const MAX_PROXY_BYTES = 4 * 1024 * 1024;    // Vercel function response limit is ~4.5 MB

let currentKey = '';
const headers = () => ({ Authorization: `Bearer ${currentKey}`, 'Content-Type': 'application/json' });

async function startTask(images) {
  // One photo → image-to-3d; front + profiles → multi-image-to-3d (first image is the front view).
  const multi = images.length > 1;
  const body = {
    ...(multi ? { image_urls: images.slice(0, 4) } : { image_url: images[0] }),
    ai_model: process.env.MESHY_MODEL || 'latest',
    should_texture: true,
    enable_pbr: false,
    should_remesh: true,
    topology: 'triangle',
    target_polycount: Number(process.env.MESHY_POLYCOUNT) || 120000,
    image_enhancement: false,   // keep the patient's exact appearance
    target_formats: ['glb'],
  };
  const r = await fetch(multi ? MESHY_MULTI : MESHY, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || `Meshy error ${r.status}`), { status: r.status });
  const id = data.result || data.id;
  if (!id) throw new Error('Meshy did not return a task id.');
  return { id, multi };
}
async function getTask(id, multi) {
  const r = await fetch(`${multi ? MESHY_MULTI : MESHY}/${encodeURIComponent(id)}`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || `Meshy error ${r.status}`), { status: r.status });
  return data;
}
const normaliseStatus = s => ({ PENDING: 'pending', IN_PROGRESS: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'failed' }[s] || 'running');

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const mk = meshyKey(req);
  if (!mk.key) return res.status(503).json({ error: 'no_key', message: 'No Meshy API key: add it under AI settings in the app, or set MESHY_API_KEY on the server.' });
  currentKey = mk.key;
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  const action = body?.action;
  try {
    if (action === 'start') {
      const images = (Array.isArray(body.images) ? body.images : [body.image]).filter(Boolean).map(String);
      if (!images.length || !images.every(img => /^data:image\/(jpeg|jpg|png);base64,/.test(img))) return res.status(400).json({ error: 'bad_image', message: 'Send JPEG or PNG data URIs.' });
      if (images.some(img => img.length > MAX_IMAGE_BYTES * 1.37)) return res.status(413).json({ error: 'too_large', message: 'Image larger than 12 MB.' });
      const { id, multi } = await startTask(images);
      return res.status(200).json({ task_id: id, provider: 'meshy', multi, images: images.length });
    }
    if (action === 'status') {
      const id = String(body.task_id || ''); if (!/^[\w-]{6,80}$/.test(id)) return res.status(400).json({ error: 'bad_task' });
      const t = await getTask(id, !!body.multi);
      const status = normaliseStatus(t.status);
      return res.status(200).json({ status, progress: Number(t.progress) || 0, preceding: t.preceding_tasks ?? null, glb_url: status === 'succeeded' ? (t.model_urls && t.model_urls.glb) || null : null, error: status === 'failed' ? (t.task_error && t.task_error.message) || 'Generation failed.' : null });
    }
    if (action === 'fetch') {
      // Proxy the GLB when the browser cannot download it directly (CORS). Small files only.
      const id = String(body.task_id || ''); if (!/^[\w-]{6,80}$/.test(id)) return res.status(400).json({ error: 'bad_task' });
      const t = await getTask(id, !!body.multi);
      const url = t.model_urls && t.model_urls.glb;
      if (normaliseStatus(t.status) !== 'succeeded' || !url) return res.status(409).json({ error: 'not_ready' });
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json({ error: 'download_failed', status: r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_PROXY_BYTES) return res.status(413).json({ error: 'too_large_for_proxy', size: buf.length, url });
      res.setHeader('Content-Type', 'model/gltf-binary'); res.setHeader('Content-Length', String(buf.length)); res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(buf);
    }
    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) return res.status(503).json({ error: 'bad_key', message: 'The Meshy API key was rejected.' });
    if (status === 402) return res.status(402).json({ error: 'no_credits', message: 'The Meshy account has no credits left.' });
    return res.status(502).json({ error: 'upstream', message: String(err?.message || err).slice(0, 300) });
  }
}
