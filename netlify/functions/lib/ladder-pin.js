// netlify/functions/lib/ladder-pin.js
// PIN gate REMOVED. Ladder scoring now uses the shared admin magic-link session
// (one login covers the league admin, the ladder admin, and courtside scoring).
// These stubs stay so existing imports keep working — PIN auth is permanently off,
// and no LADDER_PIN/ADMIN_PIN env var is read anywhere (so nothing for Netlify's
// secret scanner to flag).

export function ladderPinConfigured() { return false; }
export function checkLadderPin() { return false; }
