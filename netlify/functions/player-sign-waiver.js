// netlify/functions/player-sign-waiver.js
// Authed. Records a player's signature for the CURRENT waiver version + season.
//
// POST  body: { signedName, agree:true, version }
//   - signedName: the full name the player typed (their signature)
//   - agree:      must be true
//   - version:    the version the player saw; must match the current version
//                 (guards against signing a stale waiver after an edit)

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getWaiverConfig, recordSignature } from './lib/waiver.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const { playerId, team, player } = ctx;
  const season = circuitCode(team.circuit);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

  const config = await getWaiverConfig();
  if (!config.enabled || !config.text.trim()) {
    return json({ error: 'No waiver is currently active.' }, 409);
  }

  if (body.agree !== true) {
    return json({ error: 'You must check the box to agree before signing.' }, 400);
  }
  const signedName = String(body.signedName || '').trim();
  if (signedName.length < 2) {
    return json({ error: 'Please type your full legal name as your signature.' }, 400);
  }
  // The client echoes the version it displayed; reject if the waiver changed
  // out from under them (they need to re-read the new text).
  if (body.version != null && Number(body.version) !== config.version) {
    return json({ error: 'The waiver was updated. Please reload and read the current version before signing.', staleVersion: true }, 409);
  }

  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || null;
  const record = await recordSignature({
    playerId,
    email: player.email || null,
    name: player.name || null,
    signedName,
    season,
    version: config.version,
    userAgent: req.headers.get('user-agent') || null,
    ip,
  });

  return json({ ok: true, signedAt: record.signedAt, version: record.version });
};

export const config = { path: '/.netlify/functions/player-sign-waiver' };
