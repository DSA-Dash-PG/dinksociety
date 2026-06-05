// netlify/functions/player-logout.js
import { getPlayerToken, deletePlayerSession, buildClearPlayerCookie } from './lib/player-auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const sid = getPlayerToken(req);
    await deletePlayerSession(sid);
  } catch { /* ignore */ }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': buildClearPlayerCookie() },
  });
};

export const config = { path: '/.netlify/functions/player-logout' };
