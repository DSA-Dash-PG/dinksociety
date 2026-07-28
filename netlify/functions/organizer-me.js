// netlify/functions/organizer-me.js
// GET /api/organizer-me — is the signed-in player an active organizer?
// Powers the organizer portal's auth gate:
//   401 { signedIn:false }               → not signed in at all
//   200 { signedIn:true, organizer:null } → signed in, but not an organizer
//   200 { signedIn:true, organizer:{…} }  → active organizer

import { verifyPlayerSession } from './lib/auth.js';
import { getOrganizer } from './lib/organizers.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const v = await verifyPlayerSession(req);
  if (!v.valid) return json({ signedIn: false, organizer: null }, 401);
  const email = normalizeEmail(v.payload.session?.email || v.payload.player?.email || v.payload.email);
  const org = email ? await getOrganizer(email) : null;
  const active = !!org && org.status === 'active';
  return json({
    signedIn: true,
    email,
    name: v.payload.player?.name || org?.name || '',
    organizer: active ? { email: org.email, name: org.name, status: org.status } : null,
  });
};

export const config = { path: '/.netlify/functions/organizer-me' };
