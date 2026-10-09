// netlify/functions/desk-inbox.js
//
// Where the scheduled write-up tasks FILE their work, so nobody has to
// copy/paste it into the admin composer. Guarded by the DESK_INBOX_KEY env
// (header `x-desk-key`) instead of an admin session — a task has no browser.
//
//   POST ?kind=drop&circuit=II&edition=week-5            body: the Markdown
//        (Content-Type: text/markdown)                         composer template
//   POST (Content-Type: application/json)
//        { kind:'drop', circuit, edition, after?, markdown | fields…, notes?, replace? }
//        { kind:'ladder-recap', eventId, title, dek, html, seasonNote, notes?, replace? }
//   GET  ?kind=&circuit=   (with the key) → what is already filed / approved,
//        so a task can check before it writes and never redo an edition
//   GET  (no key)          → { ok:true } — "is this deployed?" and nothing else
//
// Filing only ever creates a DRAFT and emails the admins a one-tap approve
// link (lib/desk-inbox.js). The approve link is never returned to the caller:
// holding the inbox key must not be enough to publish.

import { fileDrop, fileLadderRecap, listItems, inboxKey, keyMatches } from './lib/desk-inbox.js';

const MAX_BODY = 400 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function givenKey(req) {
  const bearer = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return req.headers.get('x-desk-key') || (bearer ? bearer[1] : '');
}

export default async (req) => {
  const url = new URL(req.url);
  const q = (k) => (url.searchParams.get(k) || '').trim();

  if (req.method === 'GET') {
    if (!keyMatches(givenKey(req))) return json({ ok: true, service: 'desk-inbox' });
    const items = await listItems({ kind: q('kind') || null, circuit: q('circuit') || null });
    return json({ ok: true, items });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (inboxKey().length < 24) return json({ ok: false, reason: 'not-configured', message: 'DESK_INBOX_KEY is not set on the site.' }, 503);
  if (!keyMatches(givenKey(req))) return json({ ok: false, reason: 'unauthorized', message: 'Bad or missing inbox key.' }, 401);

  let raw;
  try { raw = await req.text(); } catch { return json({ ok: false, reason: 'bad-body', message: 'Could not read the body.' }, 400); }
  if (raw.length > MAX_BODY) return json({ ok: false, reason: 'too-large', message: 'Body is larger than 400 KB.' }, 413);

  // JSON when it says so (or looks like it); otherwise the body IS the Markdown file.
  let body;
  const type = (req.headers.get('content-type') || '').toLowerCase();
  if (type.includes('json') || /^\s*\{/.test(raw)) {
    try { body = JSON.parse(raw); } catch { return json({ ok: false, reason: 'bad-json', message: 'Body is not valid JSON.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, reason: 'bad-json', message: 'Body must be a JSON object.' }, 400);
  } else {
    body = { markdown: raw };
  }
  for (const k of ['kind', 'circuit', 'edition', 'after', 'eventId', 'source']) {
    if (body[k] == null && q(k)) body[k] = q(k);
  }
  if (body.replace == null && q('replace') === '1') body.replace = true;

  const kind = String(body.kind || 'drop').toLowerCase();
  try {
    const out = kind === 'drop' ? await fileDrop(body)
      : kind === 'ladder-recap' ? await fileLadderRecap(body)
      : { ok: false, http: 400, reason: 'unknown-kind', message: `Unknown kind "${kind}". Use "drop" or "ladder-recap".` };
    const { http, ...rest } = out;
    return json(rest, out.ok ? 200 : (http || 400));
  } catch (e) {
    console.error('[desk-inbox] failed:', e);
    return json({ ok: false, reason: 'error', message: String(e && e.message || e) }, 500);
  }
};

export const config = { path: '/.netlify/functions/desk-inbox' };
