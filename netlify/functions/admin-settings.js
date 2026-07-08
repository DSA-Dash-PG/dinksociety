// netlify/functions/admin-settings.js
// GET  → return current circuit settings (public, no auth)
// POST → save circuit settings (admin-only)

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';

const DEFAULTS = {
  circuitName:    'Season 1',
  startDate:      '2026-06-08',
  teamFee:        '$650',
  agentFee:       '$75',
  defaultVenue:   '',
  divisions:      ['3.0–3.5 Mixed'],
  teamsPerDiv:    6,
  weeks:          8,
  matchTime:      '7:00–9:00 PM',
  depositAmount:  100,
  balanceDueDate: '2026-06-01',
  // Planned game-night date per week (league-wide), keyed by week number →
  // ISO datetime. Lets admins publish a week's date before matchups exist;
  // matches inherit it and the public schedule shows it. e.g. { "6": "2026-07-27T19:00:00.000Z" }
  weekDates:      {},
  // Email appearance for league broadcasts/messages. Blank fields fall back to
  // built-in defaults (see lib/email.js EMAIL_TEMPLATE_DEFAULTS).
  emailTemplate: { accentColor: '#b8ff2c', headerText: 'THE DINK SOCIETY', buttonLabel: 'Open captain portal', footerText: 'The Dink Society · Southern California Pickleball League', logoUrl: '' },
  // Liability waivers — players sign each enabled one on login; editing a
  // waiver's text bumps its version, forcing everyone to re-sign that waiver.
  // Two seeded: the league's own + the Dink House venue form.
  waivers: [
    { id: 'league',     title: 'The Dink Society — Liability Waiver & Release', text: '', version: 0, enabled: false },
    { id: 'dink-house', title: 'Dink House — Participant Waiver & Release',     text: '', version: 0, enabled: false },
  ],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  const store = getStore({ name: 'config', consistency: 'strong' });

  // GET — public, no auth needed
  if (req.method === 'GET') {
    try {
      const raw = await store.get('circuit-settings');
      const s = raw ? JSON.parse(raw) : { ...DEFAULTS };
      // Always expose a normalized waivers[] (migrate legacy single fields, and
      // ensure both seeded waivers exist so the admin UI has cards to edit).
      if (!Array.isArray(s.waivers)) {
        s.waivers = [{ id: 'league', title: s.waiverTitle || DEFAULTS.waivers[0].title, text: s.waiverText || '', version: Number(s.waiverVersion) || 0, enabled: !!s.waiverEnabled }];
      }
      for (const seed of DEFAULTS.waivers) {
        if (!s.waivers.some(w => w.id === seed.id)) s.waivers.push({ ...seed });
      }
      if (!s.emailTemplate) s.emailTemplate = { ...DEFAULTS.emailTemplate };
      return json(s);
    } catch (e) {
      console.error('settings GET error:', e);
      return json({ ...DEFAULTS });
    }
  }

  // POST — admin only
  if (req.method === 'POST') {
    const verified = await verifyAdminSession(req);
    if (!verified.valid) return unauthResponse(verified.error);
    const admin = verified.payload;

    try {
      const body = await req.json();
      const existing = await store.get('circuit-settings');
      const prev = existing ? JSON.parse(existing) : { ...DEFAULTS };

      // Waivers: a list of { id, title, text, version, enabled }. When the
      // client sends `waivers`, each entry's version is bumped if its TEXT
      // changed (or bumpVersion:true) vs the stored one — forcing re-sign of
      // just that waiver. Migrate legacy single-waiver fields first.
      const prevWaivers = Array.isArray(prev.waivers) ? prev.waivers
        : [{ id: 'league', title: prev.waiverTitle || 'Liability Waiver', text: prev.waiverText || '', version: Number(prev.waiverVersion) || 0, enabled: !!prev.waiverEnabled }];
      let waivers = prevWaivers;
      if (Array.isArray(body.waivers)) {
        const prevById = new Map(prevWaivers.map(w => [w.id, w]));
        waivers = body.waivers.map(w => {
          const id = String(w.id || ('w_' + Math.random().toString(36).slice(2, 8)));
          const old = prevById.get(id) || {};
          const oldText = (old.text ?? '').trim();
          const newText = (w.text ?? old.text ?? '').trim();
          const oldVer = Number(old.version) || 0;
          const changed = ('text' in w) && newText !== oldText;
          const force = w.bumpVersion === true;
          return {
            id,
            title: w.title ?? old.title ?? 'Liability Waiver',
            text: w.text ?? old.text ?? '',
            version: (changed || force) ? oldVer + 1 : oldVer,
            enabled: w.enabled ?? old.enabled ?? false,
          };
        });
      }

      const updated = {
        ...prev,
        circuitName:  body.circuitName  ?? prev.circuitName,
        startDate:    body.startDate    ?? prev.startDate,
        teamFee:      body.teamFee      ?? prev.teamFee,
        agentFee:     body.agentFee     ?? prev.agentFee,
        defaultVenue: body.defaultVenue ?? prev.defaultVenue,
        divisions:    body.divisions    ?? prev.divisions,
        teamsPerDiv:  body.teamsPerDiv  ?? prev.teamsPerDiv,
        weeks:          body.weeks          ?? prev.weeks,
        matchTime:      body.matchTime      ?? prev.matchTime      ?? DEFAULTS.matchTime,
        depositAmount:  body.depositAmount  ?? prev.depositAmount  ?? DEFAULTS.depositAmount,
        balanceDueDate: body.balanceDueDate ?? prev.balanceDueDate ?? DEFAULTS.balanceDueDate,
        weekDates:      body.weekDates      ?? prev.weekDates      ?? {},
        emailTemplate:  body.emailTemplate
          ? { ...(prev.emailTemplate || DEFAULTS.emailTemplate), ...body.emailTemplate }
          : (prev.emailTemplate ?? DEFAULTS.emailTemplate),
        waivers,
        updatedAt:    new Date().toISOString(),
        updatedBy:    admin.email || 'admin',
      };
      // Drop legacy single-waiver fields now that the array is canonical.
      delete updated.waiverEnabled; delete updated.waiverTitle; delete updated.waiverText; delete updated.waiverVersion;

      await store.set('circuit-settings', JSON.stringify(updated));
      return json(updated);
    } catch (e) {
      console.error('settings POST error:', e);
      return json({ error: 'Failed to save settings' }, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-settings' };
