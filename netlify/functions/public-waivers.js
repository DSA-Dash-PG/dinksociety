// netlify/functions/public-waivers.js
//
// Public, read-only copy of the ACTIVE waivers — title, text, version — so the
// league can hand a stable link (/waiver) to players, venues and the insurance
// carrier. Nothing about who has signed is exposed here; signatures stay behind
// the player session (player-me / player-sign-waiver) and admin-waivers.
//
// Rich-text waivers are sanitized server-side with the same allowlist the
// email renderer uses, so the page can inject them directly.

import { getActiveWaivers } from './lib/waiver.js';
import { waiverLooksHtml, sanitizeWaiverHtml } from './lib/email.js';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  let waivers = [];
  try {
    waivers = (await getActiveWaivers()).map(w => ({
      id: w.id,
      title: w.title,
      version: w.version,
      // Always ship HTML the page can drop straight in: sanitized rich text,
      // or escaped plain text with line breaks preserved.
      html: waiverLooksHtml(w.text)
        ? sanitizeWaiverHtml(w.text)
        : `<div style="white-space:pre-wrap;">${escHtml(w.text)}</div>`,
    }));
  } catch (e) {
    console.error('public-waivers read error:', e);
  }

  return new Response(JSON.stringify({ waivers }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
};

export const config = { path: '/.netlify/functions/public-waivers' };
