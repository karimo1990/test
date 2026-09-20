// Shared helpers for the serverless functions: which API keys apply to a request.
// A key configured on the server (environment variable) always wins. Otherwise the app may
// send the surgeon's own key in a request header; it is used for that request only and never
// stored or logged.
export function anthropicKey(req) {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) return { key: env, source: 'server' };
  const h = String(req.headers['x-anthropic-key'] || '').trim();
  if (/^sk-ant-[\w-]{20,}$/.test(h)) return { key: h, source: 'browser' };
  return { key: '', source: 'none' };
}
export function meshyKey(req) {
  const env = process.env.MESHY_API_KEY;
  if (env) return { key: env, source: 'server' };
  const h = String(req.headers['x-meshy-key'] || '').trim();
  if (/^[\w-]{16,}$/.test(h)) return { key: h, source: 'browser' };
  return { key: '', source: 'none' };
}
