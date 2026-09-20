// Morph Studio — AI autopilot endpoint (Vercel serverless function).
// Reads the surgeon's instruction, notes and the patient's feedback and returns a structured
// list of anatomical edits. The browser applies them; no image ever reaches this function.
// Requires ANTHROPIC_API_KEY in the deployment's environment variables; without it the
// endpoint answers 503 and the app falls back to its built-in phrase parser.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AUTOPILOT_MODEL || 'claude-opus-5';
const TARGETS = ['dorsum', 'radix', 'tip', 'supratip', 'alar_base', 'nasal_bridge', 'columella', 'chin', 'jawline', 'cheeks', 'lips', 'lip_upper', 'lip_lower', 'brow', 'forehead', 'nasolabial_fold', 'neck'];
const ACTIONS = ['reduce', 'augment', 'narrow', 'widen', 'lift', 'lower', 'project', 'deproject', 'smooth', 'restore'];

const TOOL = {
  name: 'apply_simulation_edits',
  description: 'Apply anatomical edits to the facial surgery simulation (3D model and photos). Call this exactly once with every edit implied by the instruction.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'One or two short sentences for the surgeon, in plain language, summarising what is being applied and any caveat. No markdown.' },
      ops: {
        type: 'array',
        description: 'Edits to apply now, relative to the CURRENT state of the simulation. Empty if nothing should change.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: TARGETS },
            action: { type: 'string', enum: ACTIONS },
            amount_mm: { type: 'number', description: 'Magnitude in millimetres (0.5–8 typical). For tip rotation use amount_deg instead and set this to 0.' },
            amount_deg: { type: 'number', description: 'Tip rotation in degrees for lift/lower on the tip (0 otherwise).' },
            side: { type: 'string', enum: ['both', 'left', 'right'] },
            note: { type: 'string', description: 'The phrase from the surgeon or patient this edit comes from.' },
          },
          required: ['target', 'action', 'amount_mm', 'amount_deg', 'side', 'note'],
          additionalProperties: false,
        },
      },
      questions: { type: 'array', items: { type: 'string' }, description: 'At most one clarifying question, only when the instruction cannot be applied at all without it.' },
    },
    required: ['reply', 'ops', 'questions'],
    additionalProperties: false,
  },
};

const SYSTEM = `You are the planning engine of Morph Studio, a before/after simulation aid used by facial plastic surgeons during consultations. You never draw; you translate what the surgeon plans and what the patient says into a list of anatomical edits that the app applies to a 3D model of the patient and to their photos.

How to plan:
- Read the surgeon's planned changes, the consultation notes and the latest message. The latest message may be the surgeon's instruction or the patient's feedback relayed by the surgeon (e.g. "she feels the tip is too upturned").
- Output edits relative to the CURRENT simulation state. The context lists what has already been applied. If feedback asks for less, output the opposite action for a fraction of the previous amount (typically half). If it asks for more, add roughly half again. Never re-apply the whole plan.
- Use realistic surgical magnitudes: dorsal hump reduction 1–4 mm, tip rotation 3–10 degrees, tip deprojection 1–3 mm, alar base narrowing 2–5 mm total, chin augmentation 3–8 mm, lip augmentation 1–3 mm, cheek augmentation 2–4 mm. When no amount is given, choose a conservative typical value; words like "slightly" mean about 1 mm or 3 degrees.
- Vague wishes map to concrete edits: "smaller nose" → dorsum reduce + tip deproject; "straighter profile" → dorsum reduce; "refine the tip" → tip narrow ~1.5 mm; "more balanced profile" with a weak chin → chin augment; "less droopy tip" → tip lift; "open the nasolabial angle" → tip lift.
- Keep symmetry unless a side is named. Do not invent procedures the surgeon has not mentioned when the message is patient feedback; adjust the existing plan instead.
- Only ask a question when nothing can be applied without it. Otherwise apply and mention assumptions in the reply.
- Always respond by calling apply_simulation_edits.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'no_key', message: 'ANTHROPIC_API_KEY is not configured on the server.' });
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  const message = String(body?.message || '').slice(0, 4000);
  if (!message.trim()) return res.status(400).json({ error: 'empty_message' });
  const history = Array.isArray(body?.history) ? body.history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })) : [];
  const ctx = body?.context || {};
  const contextText = [
    `Procedure: ${String(ctx.procedure || 'not stated').slice(0, 200)}`,
    `Planned changes (surgeon): ${String(ctx.notes?.plan || 'none').slice(0, 3000)}`,
    `Consultation notes: ${String(ctx.notes?.consultation || 'none').slice(0, 3000)}`,
    `3D model: ${ctx.model3d ? `${ctx.model3d.kind}, landmarks ${ctx.model3d.landmarks ? 'set' : 'NOT set'}, scale ${ctx.model3d.scale}` : 'none'}`,
    `Photos: ${(ctx.photos || []).map(p => `${p.name} (${p.kind}, landmarks ${p.landmarks ? 'set' : 'not set'})`).join('; ') || 'none'}`,
    `Already applied (in order): ${(ctx.applied || []).length ? ctx.applied.map((a, i) => `${i + 1}. ${a}`).join(' ') : 'nothing yet'}`,
    `Measurements: ${(ctx.measurements || []).join('; ') || 'none'}`,
  ].join('\n');

  // Trim any dangling assistant turn so the conversation ends with the new user message.
  while (history.length && history[history.length - 1].role === 'assistant') history.pop();
  const messages = [...history, { role: 'user', content: `<context>\n${contextText}\n</context>\n\nLatest message: ${message}` }];

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'apply_simulation_edits', disable_parallel_tool_use: true },
    });
    const call = response.content.find(b => b.type === 'tool_use');
    if (!call) return res.status(502).json({ error: 'no_tool_call', stop_reason: response.stop_reason });
    const input = call.input || {};
    const ops = (Array.isArray(input.ops) ? input.ops : []).filter(o => TARGETS.includes(o.target) && ACTIONS.includes(o.action)).slice(0, 20);
    return res.status(200).json({ reply: String(input.reply || ''), ops, questions: Array.isArray(input.questions) ? input.questions.slice(0, 1) : [], engine: MODEL });
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status === 401 || status === 403 ? 503 : 502).json({ error: 'upstream', message: String(err?.message || err).slice(0, 300) });
  }
}
