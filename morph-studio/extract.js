/* Morph Studio — text extraction from uploaded consultation notes and letters.
   Text and Word files are read in the browser; PDFs through the vendored pdf.js; scanned
   PDFs and photos of notes go to /api/extract (Claude vision) when the server has a key. */
const PDF_MIN_CHARS = 60;
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href; return m; });
  return pdfjsPromise;
}
const kindOf = (name, type) => {
  const n = name.toLowerCase();
  if (type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx') || type.includes('wordprocessingml')) return 'docx';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || /\.(txt|md|csv|rtf)$/.test(n)) return 'text';
  return 'other';
};
function dataUrlToBytes(u) { const b64 = u.split(',')[1] || ''; const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

/* ── DOCX: a zip with word/document.xml; inflate with the browser's DecompressionStream ── */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid Word file.');
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  let p = cdOff; const td = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true), start = lho + 30 + lnlen + lelen;
      const data = bytes.subarray(start, start + csize);
      return method === 0 ? data : method === 8 ? await inflateRaw(data) : Promise.reject(new Error('Unsupported compression in Word file.'));
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}
const decodeEntities = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
function docxXmlToText(xml) {
  return decodeEntities(xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t')
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function extractDocx(bytes) {
  const xml = await unzipEntry(bytes, 'word/document.xml');
  if (!xml) throw new Error('This Word file has no document body.');
  return docxXmlToText(new TextDecoder().decode(xml));
}
/* ── PDF ── */
async function extractPdf(bytes) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
    const page = await doc.getPage(i), content = await page.getTextContent();
    let line = '', lastY = null, out = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { out.push(line.trimEnd()); line = ''; }
      line += it.str + (it.hasEOL ? '\n' : ''); lastY = y;
    }
    out.push(line); pages.push(out.join('\n'));
  }
  return { text: pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(), pages: doc.numPages };
}
/* ── Server (Claude vision) for scans and photos ── */
async function extractViaServer(doc) {
  const r = await ((window.MorphAPI && window.MorphAPI.apiFetch) || fetch)('api/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: doc.name, type: doc.type, data: doc.data }) });
  if (r.status === 503) return { unavailable: true };
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `Extraction service error (${r.status})`);
  return { text: String(body.text || ''), engine: body.engine || 'server' };
}

/* Main entry: returns { text, method, warning } */
export async function extractText(doc) {
  const kind = kindOf(doc.name, doc.type || '');
  if (kind === 'text') return { text: new TextDecoder().decode(dataUrlToBytes(doc.data)), method: 'text' };
  if (kind === 'docx') return { text: await extractDocx(dataUrlToBytes(doc.data)), method: 'word' };
  if (kind === 'pdf') {
    let local = null;
    try { local = await extractPdf(dataUrlToBytes(doc.data)); } catch (e) { local = null; }
    if (local && local.text.length >= PDF_MIN_CHARS) return { text: local.text, method: `pdf (${local.pages} page${local.pages > 1 ? 's' : ''})` };
    const srv = await extractViaServer(doc);
    if (srv.unavailable) return { text: local ? local.text : '', method: 'pdf', warning: 'This PDF looks scanned (no text layer). Reading scans needs the Claude AI: add your key under AI settings, or upload the notes as a Word or text file.' };
    return { text: srv.text, method: 'scan (AI transcription)' };
  }
  if (kind === 'image') {
    const srv = await extractViaServer(doc);
    if (srv.unavailable) return { text: '', method: 'image', warning: 'Reading a photo of notes needs the Claude AI: add your key under AI settings, or upload the notes as a PDF, Word or text file.' };
    return { text: srv.text, method: 'photo (AI transcription)' };
  }
  return { text: '', method: 'unsupported', warning: 'This file type cannot be read. Use PDF, Word (.docx), text or an image.' };
}
window.Extract = { extractText };
window.dispatchEvent(new Event('extract-ready'));
