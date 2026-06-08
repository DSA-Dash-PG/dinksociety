// netlify/functions/player-email-waiver.js
// Authed. Emails a copy of the current waiver to the signed-in player's own
// address (for their records). Works whether or not they've signed yet.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getWaiverConfig, getSignature } from './lib/waiver.js';
import { sendEmail, renderWaiverCopy } from './lib/email.js';

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
  const { playerId, player } = ctx;

  const to = player.email || null;
  if (!to) return json({ error: 'No email on file for your account.' }, 400);

  const config = await getWaiverConfig();
  if (!config.text.trim()) return json({ error: 'No waiver text is available to send.' }, 409);

  // Include their signature details if they've already signed the current one.
  const sig = await getSignature(playerId);
  const signedCurrent = sig && sig.version === config.version
    && String(sig.season) === String(circuitCode(ctx.team.circuit));

  try {
    await sendEmail({
      to,
      subject: `${config.title || 'Liability Waiver'} — The Dink Society`,
      html: renderWaiverCopy({
        title: config.title,
        text: config.text,
        playerName: player.name || null,
        signedName: signedCurrent ? sig.signedName : null,
        signedAt: signedCurrent ? sig.signedAt : null,
      }),
    });
    return json({ ok: true, sentTo: to });
  } catch (e) {
    console.error('player-email-waiver send failed:', e);
    return json({ error: 'Could not send the email right now. Please try again.' }, 502);
  }
};

export const config = { path: '/.netlify/functions/player-email-waiver' };
