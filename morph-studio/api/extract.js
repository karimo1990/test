// Morph Studio — transcription of scanned notes and photos of notes (Vercel serverless function).
// Used only when the browser cannot read the text itself (scanned PDF, image). Returns the
// text verbatim so the autopilot can plan from it. Requires ANTHROPIC_API_KEY.
import Anthropic from '@anthropic-ai/sdk';
import { anthropicKey } from './_keys.js';

const MODEL = process.env.EXTRACT_MODEL || process.env.AUTOPILOT_MODEL || 'claude-opus-5';
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const ak = anthropicKey(req);
  if (!ak.key) return res.status(503).json({ error: 'no_key', message: 'No Claude API key: add it under AI settings in the app, or set ANTHROPIC_API_KEY on the server.' });
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  const data = String(body?.data || ''), m = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return res.status(400).json({ error: 'bad_data', message: 'Send the file as a base64 data URI.' });
  const mediaType = m[1].toLowerCase(), b64 = m[2];
  if (b64.length > MAX_BYTES * 1.37) return res.status(413).json({ error: 'too_large', message: 'File larger than 20 MB.' });
  let block;
  if (mediaType === 'application/pdf') block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (IMAGE_TYPES.includes(mediaType)) block = { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
  else return res.status(415).json({ error: 'unsupported', message: 'Only PDF and JPEG/PNG/GIF/WebP images are transcribed here.' });

  const client = new Anthropic({ apiKey: ak.key });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: 'You transcribe clinical consultation notes and letters for a facial surgery planning tool. Return the full text of the document verbatim as plain text, preserving headings, lists and line breaks. Transcribe handwriting as faithfully as possible and mark unreadable words as [illegible]. Do not summarise, do not add commentary, do not include anything that is not in the document.',
      messages: [{ role: 'user', content: [block, { type: 'text', text: `Transcribe this document (${String(body.name || 'notes').slice(0, 120)}).` }] }],
    });
    if (response.stop_reason === 'refusal') return res.status(422).json({ error: 'refused', message: 'The document could not be transcribed.' });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return res.status(200).json({ text, engine: MODEL, pages: null });
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) return res.status(503).json({ error: 'bad_key', message: 'The Anthropic API key was rejected.' });
    return res.status(502).json({ error: 'upstream', message: String(err?.message || err).slice(0, 300) });
  }
}
