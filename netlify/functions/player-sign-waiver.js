// netlify/functions/player-sign-waiver.js
// Authed. Records a player's ONLINE signature for ONE waiver (current version
// + season).
//
// POST body: { waiverId, signedName, agree:true, version }

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getWaiverById, recordSignature } from './lib/waiver.js';

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

  const waiver = await getWaiverById(body.waiverId);
  if (!waiver || !waiver.enabled || !waiver.text.trim()) {
    return json({ error: 'That waiver is not active.' }, 409);
  }
  if (body.agree !== true) {
    return json({ error: 'You must check the box to agree before signing.' }, 400);
  }
  const signedName = String(body.signedName || '').trim();
  if (signedName.length < 2) {
    return json({ error: 'Please type your full legal name as your signature.' }, 400);
  }
  if (body.version != null && Number(body.version) !== waiver.version) {
    return json({ error: 'This waiver was updated. Please reload and read the current version before signing.', staleVersion: true }, 409);
  }

  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || null;
  const record = await recordSignature({
    waiverId: waiver.id,
    playerId,
    email: player.email || null,
    name: player.name || null,
    signedName,
    season,
    version: waiver.version,
    method: 'online',
    userAgent: req.headers.get('user-agent') || null,
    ip,
  });

  return json({ ok: true, waiverId: waiver.id, signedAt: record.signedAt, version: record.version });
};

export const config = { path: '/.netlify/functions/player-sign-waiver' };
