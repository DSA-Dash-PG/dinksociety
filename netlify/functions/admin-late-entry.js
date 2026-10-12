// netlify/functions/admin-late-entry.js
//
// Admin-only. The private invite that lets one team join a season already
// under way (a replacement team). See lib/late-entry.js for the whole flow.
//
// GET  ?circuit=II                → { lateEntry, url, weeks, divisions, teams }
// POST { circuit?, name, email, division?, price?, startWeek?, replaces?, send? }
//      Creates (or refreshes) the invite and, unless send:false, emails the
//      captain the registration link. `replaces` is the team name/id leaving
//      (used for its division and the admin's notes). A fresh code is issued
//      whenever the old one has already been used; otherwise the same link is
//      kept so an earlier email still works.
// DELETE ?circuit=II              → revokes the invite (link stops working)

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { liveCircuit } from './lib/current-season.js';
import { circuitCode, seasonCircuitCode } from './lib/circuit.js';
import { sendEmail } from './lib/email.js';
import {
  DEFAULT_LATE_PRICE, newInviteCode, inviteUrl, findSeasonByCircuit,
  lateEntryWeeks, renderInviteEmail, seasonLabelOf,
} from './lib/late-entry.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  try {
    const url = new URL(req.url);
    let body = {};
    if (req.method === 'POST') body = await req.json().catch(() => ({}));
    const circuit = circuitCode(body.circuit || url.searchParams.get('circuit') || await liveCircuit());

    const hit = await findSeasonByCircuit(circuit);
    if (!hit) return json({ error: `No season record for ${circuit}` }, 404);
    const { key, season } = hit;
    const seasons = getStore('seasons');

    if (req.method === 'GET') {
      const le = season.lateEntry || null;
      const weeks = le ? await lateEntryWeeks({ circuit, division: le.division, startWeek: le.startWeek }) : [];
      return json({
        circuit,
        lateEntry: le,
        url: le?.code ? inviteUrl(le.code) : null,
        weeks,
        divisions: (season.divisions || []).map(d => ({ id: d.id, name: d.name })),
      });
    }

    if (req.method === 'DELETE') {
      delete season.lateEntry;
      season.updatedAt = new Date().toISOString();
      await seasons.set(key, JSON.stringify(season));
      return json({ ok: true, revoked: true });
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid captain email is required' }, 400);

    // The team leaving decides the division (and is noted on the invite).
    let replaces = null;
    const replacesIn = String(body.replaces || '').trim();
    if (replacesIn) {
      const teams = getStore('teams');
      const { blobs } = await teams.list({ prefix: 'team/' });
      for (const b of blobs) {
        const t = await teams.get(b.key, { type: 'json' }).catch(() => null);
        if (!t || circuitCode(t.circuit || '') !== circuit) continue;
        if (t.id === replacesIn || norm(t.name) === norm(replacesIn)) {
          replaces = { id: t.id, name: t.name, division: t.division || null };
          break;
        }
      }
      if (!replaces) return json({ error: `No team called "${replacesIn}" in season ${circuit}` }, 400);
    }

    const divisions = season.divisions || [];
    const division = String(body.division || replaces?.division || (divisions.length === 1 ? divisions[0].id : '')).trim();
    const div = divisions.find(d => d.id === division);
    if (!division) return json({ error: 'Pick the division the new team joins' }, 400);

    const price = Number(body.price);
    const startWeek = Number(body.startWeek) || 6;
    const prev = season.lateEntry || null;
    const keepCode = prev?.code && !prev.registrationId;
    const now = new Date().toISOString();

    season.lateEntry = {
      code: keepCode ? prev.code : newInviteCode(),
      division,
      divisionLabel: div?.name || division,
      price: price > 0 ? price : DEFAULT_LATE_PRICE,
      startWeek,
      replaces: replaces ? { id: replaces.id, name: replaces.name } : (prev?.replaces || null),
      invitedName: name,
      invitedEmail: email,
      createdAt: keepCode ? prev.createdAt : now,
      createdBy: admin.email || 'admin',
      updatedAt: now,
    };

    const link = inviteUrl(season.lateEntry.code);
    const weeks = await lateEntryWeeks({ circuit, division, startWeek });
    let sent = false;
    if (body.send !== false) {
      await sendEmail({
        to: email,
        subject: `You're invited — join ${seasonLabelOf(season)} of The Dink Society`,
        html: renderInviteEmail({
          name, seasonName: seasonLabelOf(season), divisionLabel: season.lateEntry.divisionLabel,
          price: season.lateEntry.price, weeks, url: link,
        }),
      });
      sent = true;
      season.lateEntry.sentAt = now;
    }

    season.updatedAt = now;
    await seasons.set(key, JSON.stringify(season));
    return json({ ok: true, sent, url: link, lateEntry: season.lateEntry, weeks, circuit: seasonCircuitCode(season) });
  } catch (err) {
    console.error('admin-late-entry error:', err);
    return json({ error: 'Invite failed', detail: err.message }, 500);
  }
};

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/.netlify/functions/admin-late-entry' };
