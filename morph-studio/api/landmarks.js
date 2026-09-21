// Morph Studio — landmark estimation with Claude vision for photos the local detector cannot
// handle (true profiles). Returns normalised (0–1) coordinates of the anatomical landmarks.
import Anthropic from '@anthropic-ai/sdk';
import { anthropicKey } from './_keys.js';

const MODEL = process.env.AUTOPILOT_MODEL || 'claude-opus-5';
const NAMES = ['pupil_r', 'pupil_l', 'nasion', 'rhinion', 'pronasale', 'subnasale', 'pogonion'];
const TOOL = {
  name: 'report_landmarks', strict: true,
  description: 'Report the pixel position of each visible facial landmark as fractions of the image width (x) and height (y), measured from the top-left corner.',
  input_schema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['front', 'profile_left', 'profile_right', 'oblique', 'unknown'], description: 'profile_right = the patient\'s right side faces the camera (nose points to the viewer\'s right).' },
      landmarks: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string', enum: NAMES }, x: { type: 'number' }, y: { type: 'number' }, visible: { type: 'boolean' } }, required: ['name', 'x', 'y', 'visible'], additionalProperties: false },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['view', 'landmarks', 'confidence'], additionalProperties: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const ak = anthropicKey(req);
  if (!ak.key) return res.status(503).json({ error: 'no_key', message: 'No Claude API key: add it under AI settings.' });
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  const m = String(body?.image || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!m) return res.status(400).json({ error: 'bad_image' });
  const client = new Anthropic({ apiKey: ak.key });
  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 1500,
      system: 'You locate anatomical landmarks on clinical facial photographs for a surgical planning tool. Be precise: coordinates are fractions of the image size from the top-left corner. Definitions: pupil_r/pupil_l = centre of the patient\'s right/left pupil (on a front view the patient\'s right eye appears on the viewer\'s left); nasion = deepest point of the bridge between the eyes; rhinion = midpoint of the bony dorsum (where a hump sits); pronasale = most projecting point of the nose tip; subnasale = junction of the columella and upper lip; pogonion = most forward point of the chin. On a profile only one pupil is visible: report the visible one and mark the other visible=false. Always call report_landmarks.',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: `Locate the landmarks. Expected view: ${String(body.hint || 'unknown').slice(0, 40)}.` }] }],
      tools: [TOOL], tool_choice: { type: 'tool', name: 'report_landmarks', disable_parallel_tool_use: true },
    });
    const call = response.content.find(b => b.type === 'tool_use');
    if (!call) return res.status(502).json({ error: 'no_tool_call' });
    const out = {};
    for (const l of call.input.landmarks || []) if (NAMES.includes(l.name) && l.visible && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1) out[l.name] = { x: l.x, y: l.y };
    return res.status(200).json({ view: call.input.view, confidence: call.input.confidence, landmarks: out, engine: MODEL });
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) return res.status(503).json({ error: 'bad_key', message: 'The Claude API key was rejected.' });
    return res.status(502).json({ error: 'upstream', message: String(err?.message || err).slice(0, 300) });
  }
}
