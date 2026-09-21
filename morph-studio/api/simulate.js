// Morph Studio — AI image simulation from the surgeon's notes.
//   action "plan"   : Claude reads the patient photo and the notes/feedback and writes a precise,
//                     photorealistic edit instruction plus the region of the face allowed to change.
//   action "render" : the instruction, the photo and a mask go to OpenAI's image-edit model
//                     (gpt-image-1, high input fidelity) which paints the simulated result.
// Keys: ANTHROPIC_API_KEY / OPENAI_API_KEY on the server, or per-request browser headers (see _keys.js).
import Anthropic from '@anthropic-ai/sdk';
import { anthropicKey, openaiKey } from './_keys.js';

const PLAN_MODEL = process.env.AUTOPILOT_MODEL || 'claude-opus-5';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';
const MAX_BODY = 9 * 1024 * 1024;

const PLAN_TOOL = {
  name: 'plan_simulation', strict: true,
  description: 'Plan the photorealistic simulation of the planned procedure on this exact photo.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two plain-language sentences for the patient and surgeon: what the simulation will show changed.' },
      changes: {
        type: 'array', description: 'Each anatomical change the notes ask for, as it applies to this view.',
        items: { type: 'object', properties: { target: { type: 'string' }, action: { type: 'string' }, amount: { type: 'string', description: 'e.g. "2 mm", "5°", "slight"' } }, required: ['target', 'action', 'amount'], additionalProperties: false },
      },
      edit_prompt: { type: 'string', description: 'The instruction for the image-editing model. Photorealistic; the same person, pose, expression, lighting, skin texture, hair and background must stay identical; describe ONLY the anatomical changes visually and with realistic subtlety (surgical results are modest), naming the view (front/profile) and left/right from the patient\'s point of view. No text or labels in the image.' },
      region: {
        type: 'object', description: 'Bounding box of the area allowed to change, as fractions of the image width/height from the top-left. Cover the changed anatomy generously (nose + a margin, chin, lips…) but not the eyes unless they change.',
        properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false,
      },
      applies: { type: 'boolean', description: 'false when nothing in the notes applies to this view (e.g. only profile changes on a front photo, or the notes are not a surgical plan).' },
      unclear: { type: 'string', description: 'Anything ambiguous the surgeon should confirm, or empty.' },
    },
    required: ['summary', 'changes', 'edit_prompt', 'region', 'applies', 'unclear'], additionalProperties: false,
  },
};

const SYSTEM = `You plan before/after simulations for a facial plastic surgeon's consultation aid (rhinoplasty, chin, lips, brow and similar). You are given the patient's photo, which view it is, the surgeon's notes (plan, consultation notes, uploaded letters) and any feedback from the patient or surgeon on an earlier simulation.
Call plan_simulation exactly once. Translate the notes into what would visibly change in THIS photo: a 2 mm dorsal hump reduction is a straighter, slightly lower bridge line; 5° of tip rotation is a subtly lifted tip and a marginally shorter nose; alar base narrowing is slightly narrower nostrils. Keep results realistic and modest — a surgeon must be able to stand behind the image. Feedback such as "a bit less" or "the tip is too upturned" reduces the corresponding change; "more" increases it. Never change identity, age, expression, skin, hair, make-up, glasses, jewellery, clothing, lighting or background. Millimetre and degree amounts in the notes are relative to a real face about 65 mm between the pupils. If the notes do not describe a change visible in this view, set applies=false and say why in summary.`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = ''; req.setEncoding('utf8');
    req.on('data', c => { raw += c; if (raw.length > MAX_BODY) { reject(new Error('too_large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function dataUrlParts(s, what) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw Object.assign(new Error(`${what} must be a JPEG, PNG or WebP data URL`), { status: 400 });
  return { mediaType: m[1], b64: m[2], buffer: Buffer.from(m[2], 'base64') };
}
const clamp01 = n => Math.min(1, Math.max(0, Number.isFinite(+n) ? +n : 0));

async function plan(req, res, body) {
  const ak = anthropicKey(req);
  if (!ak.key) return res.status(503).json({ error: 'no_key', message: 'No Claude API key: add it under AI settings.' });
  const img = dataUrlParts(body.image, 'image');
  const view = ['front', 'profile', 'other'].includes(body.view) ? body.view : 'unknown';
  const notes = String(body.notes || '').slice(0, 12000), feedback = String(body.feedback || '').slice(0, 4000), previous = String(body.previous || '').slice(0, 3000);
  const text = [
    `View: ${view}${body.name ? ` ("${String(body.name).slice(0, 60)}")` : ''}. Image size ${+body.width || '?'}×${+body.height || '?'} px.`,
    body.landmarks ? `Detected landmarks (fractions of width/height): ${JSON.stringify(body.landmarks).slice(0, 800)}` : '',
    `SURGEON'S NOTES:\n${notes || '(none given)'}`,
    previous ? `PREVIOUS SIMULATION INSTRUCTION:\n${previous}` : '',
    feedback ? `FEEDBACK ON THE PREVIOUS SIMULATION (from the surgeon and the patient, latest last):\n${feedback}` : '',
  ].filter(Boolean).join('\n\n');
  const client = new Anthropic({ apiKey: ak.key, maxRetries: 1, timeout: 50_000 });
  let msg;
  try {
    msg = await client.messages.create({
      model: PLAN_MODEL, max_tokens: 4000, system: SYSTEM, tools: [PLAN_TOOL], tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.b64 } }, { type: 'text', text }] }],
    });
  } catch (err) {
    const status = err?.status;
    if (status === 401) return res.status(401).json({ error: 'bad_key', message: 'The Claude API key was rejected (401).' });
    if (status === 429) return res.status(429).json({ error: 'rate_limited', message: 'The Claude API is rate-limited right now; try again in a moment.' });
    return res.status(502).json({ error: 'upstream', message: `Claude request failed: ${String(err?.message || err).slice(0, 200)}` });
  }
  if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'refused', message: 'The AI declined to plan this simulation.' });
  const call = msg.content.find(b => b.type === 'tool_use' && b.name === 'plan_simulation');
  if (!call) { const t = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 500); return res.status(422).json({ error: 'no_plan', message: t || 'The AI did not produce a plan.' }); }
  const p = call.input, r = p.region || {};
  const region = { x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) };
  if (region.w < 0.05 || region.h < 0.05) { region.x = 0.25; region.y = 0.3; region.w = 0.5; region.h = 0.5; }
  return res.status(200).json({ summary: String(p.summary || ''), changes: Array.isArray(p.changes) ? p.changes.slice(0, 20) : [], edit_prompt: String(p.edit_prompt || ''), region, applies: p.applies !== false, unclear: String(p.unclear || ''), model: PLAN_MODEL });
}

async function render(req, res, body) {
  const ok = openaiKey(req);
  if (!ok.key) return res.status(503).json({ error: 'no_openai_key', message: 'No OpenAI API key: add it under AI settings to render the AI image simulation.' });
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  if (!prompt) return res.status(400).json({ error: 'no_prompt', message: 'Missing edit instruction.' });
  const img = dataUrlParts(body.image, 'image');
  const mask = body.mask ? dataUrlParts(body.mask, 'mask') : null;
  const size = ['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(body.size) ? body.size : 'auto';
  const quality = ['low', 'medium', 'high', 'auto'].includes(body.quality) ? body.quality : IMAGE_QUALITY;
  const fullPrompt = `${prompt}\n\nThis is a medical consultation aid: the output must be a photorealistic photograph of the same person with only the described change. Keep everything else pixel-faithful to the input: face shape elsewhere, eyes, skin texture, hair, lighting, background, colours, framing. No text, watermarks or labels.`;
  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('prompt', fullPrompt);
  form.append('image', new Blob([img.buffer], { type: img.mediaType }), img.mediaType === 'image/png' ? 'photo.png' : 'photo.jpg');
  if (mask) form.append('mask', new Blob([mask.buffer], { type: 'image/png' }), 'mask.png');
  form.append('n', '1'); form.append('size', size); form.append('quality', quality);
  form.append('input_fidelity', 'high'); form.append('output_format', 'jpeg'); form.append('output_compression', '92');
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 56_000);
  let r, data;
  try {
    r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${ok.key}` }, body: form, signal: ctrl.signal });
    data = await r.json().catch(() => ({}));
  } catch (err) {
    clearTimeout(timer);
    return res.status(504).json({ error: 'timeout', message: err?.name === 'AbortError' ? 'The image model took too long (over 55 s). Try again, or set OPENAI_IMAGE_QUALITY=low.' : `Could not reach OpenAI: ${String(err?.message || err).slice(0, 160)}` });
  }
  clearTimeout(timer);
  if (!r.ok) {
    const m = data?.error?.message || `OpenAI answered ${r.status}`;
    const status = r.status === 401 ? 401 : r.status === 429 ? 429 : r.status === 400 && /safety|moderation|policy/i.test(m) ? 422 : 502;
    return res.status(status).json({ error: r.status === 401 ? 'bad_openai_key' : status === 422 ? 'rejected' : 'upstream', message: String(m).slice(0, 300) });
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return res.status(502).json({ error: 'upstream', message: 'OpenAI returned no image.' });
  const fmt = data.output_format === 'png' ? 'png' : 'jpeg';
  return res.status(200).json({ image: `data:image/${fmt};base64,${b64}`, model: IMAGE_MODEL, quality, usage: data.usage || null });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  let body;
  try { body = await readJson(req); } catch (err) { return res.status(err.message === 'too_large' ? 413 : 400).json({ error: err.message }); }
  try {
    if (body.action === 'plan') return await plan(req, res, body);
    if (body.action === 'render') return await render(req, res, body);
    return res.status(400).json({ error: 'bad_action', message: 'action must be "plan" or "render"' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'failed', message: String(err?.message || err).slice(0, 300) });
  }
}
