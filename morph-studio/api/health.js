// Morph Studio — checks that the AI services are reachable with the configured keys.
import Anthropic from '@anthropic-ai/sdk';
import { anthropicKey, meshyKey, openaiKey } from './_keys.js';

const MODEL = process.env.AUTOPILOT_MODEL || 'claude-opus-5';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const out = { claude: { configured: false, source: 'none', ok: false, model: MODEL, message: '' }, meshy: { configured: false, source: 'none', ok: false, message: '' }, openai: { configured: false, source: 'none', ok: false, model: IMAGE_MODEL, message: '' } };
  const ak = anthropicKey(req);
  out.claude.source = ak.source; out.claude.configured = !!ak.key;
  if (ak.key) {
    try {
      const client = new Anthropic({ apiKey: ak.key });
      const m = await client.models.retrieve(MODEL);
      out.claude.ok = true; out.claude.display_name = m.display_name || MODEL; out.claude.message = `Connected — ${m.display_name || MODEL}`;
    } catch (err) {
      const status = err?.status;
      out.claude.message = status === 401 ? 'The Claude API key was rejected (401). Check it and try again.' : status === 404 ? `Key works but the model ${MODEL} is not available to this account.` : status === 403 ? 'This key is not allowed to use the API (403).' : `Could not reach the Claude API: ${String(err?.message || err).slice(0, 160)}`;
    }
  } else out.claude.message = 'No Claude API key yet.';
  const mk = meshyKey(req);
  out.meshy.source = mk.source; out.meshy.configured = !!mk.key;
  if (mk.key) {
    try {
      const r = await fetch('https://api.meshy.ai/openapi/v1/image-to-3d?page_size=1', { headers: { Authorization: `Bearer ${mk.key}` } });
      out.meshy.ok = r.ok; out.meshy.message = r.ok ? 'Connected' : r.status === 401 ? 'The Meshy API key was rejected (401).' : `Meshy answered ${r.status}.`;
    } catch (err) { out.meshy.message = `Could not reach Meshy: ${String(err?.message || err).slice(0, 160)}`; }
  } else out.meshy.message = 'No Meshy API key yet (needed only for AI 3D model generation).';
  const ok_ = openaiKey(req);
  out.openai.source = ok_.source; out.openai.configured = !!ok_.key;
  if (ok_.key) {
    try {
      const r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/models/${encodeURIComponent(IMAGE_MODEL)}`, { headers: { Authorization: `Bearer ${ok_.key}` } });
      out.openai.ok = r.ok; out.openai.message = r.ok ? `Connected — ${IMAGE_MODEL} (image simulation)` : r.status === 401 ? 'The OpenAI API key was rejected (401).' : r.status === 404 ? `Key works but ${IMAGE_MODEL} is not available to this account (organisation verification may be needed).` : `OpenAI answered ${r.status}.`;
    } catch (err) { out.openai.message = `Could not reach OpenAI: ${String(err?.message || err).slice(0, 160)}`; }
  } else out.openai.message = 'No OpenAI API key yet (needed for the photorealistic AI image simulation).';
  return res.status(200).json(out);
}
