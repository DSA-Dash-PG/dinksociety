// netlify/functions/ladder-pin-verify.js
// GET/POST ?pin=XXXX (or X-Ladder-Pin header) → { valid:bool, configured:bool }
// Lets the scoreboard check a PIN before showing controls.

import { checkLadderPin, ladderPinConfigured } from './lib/ladder-pin.js';

export default async (req) => {
  return new Response(JSON.stringify({ valid: checkLadderPin(req), configured: ladderPinConfigured() }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/.netlify/functions/ladder-pin-verify' };
