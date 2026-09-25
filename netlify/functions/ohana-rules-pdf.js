// netlify/functions/ohana-rules-pdf.js
// GET → the full PVTC 2026 league rules PDF, for the Ohana roster only.

import { loadLeague, viewer, json } from './lib/ohana.js';
import { RULES_PDF_B64, RULES_PDF_NAME } from './lib/ohana-rules-pdf.js';

export default async (req) => {
  const league = await loadLeague();
  const v = await viewer(req, league);
  if (!v.signedIn) return json({ error: 'Sign in first' }, 401);
  if (!v.allowed) return json({ error: 'Roster only' }, 403);
  const inline = new URL(req.url).searchParams.get('dl') !== '1';
  return new Response(Buffer.from(RULES_PDF_B64, 'base64'), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${RULES_PDF_NAME}"`,
      'Cache-Control': 'private, max-age=86400',
      'X-Robots-Tag': 'noindex',
    },
  });
};

export const config = { path: '/.netlify/functions/ohana-rules-pdf' };
