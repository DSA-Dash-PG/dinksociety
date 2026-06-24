// netlify/functions/admin-potw.js
// Admin side of the K'CHN Player of the Week emails.
//
//   GET                      → { weeks:[{week,preparedAt}], week, records:[...] }
//                              (records = the selected/latest week's winners, with
//                               subject, recipient, status, shirt size, and the
//                               rendered HTML for preview)
//   GET ?week=N              → same shape for a specific week
//   POST action=generate     → (re)draft the latest completed week silently
//                              (no approval email; the panel is the surface)
//   POST action=send         → { week, winnerKey } send one winner's email now,
//                              as dink@dinksociety.app with reply-to there
//
// Mirrors admin-drop.js: cookie-authed admin only, circuit defaults to 'I'.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import {
  prepareWeeklyPotwApproval, sendApprovedPotw,
  listPendingForWeek, listPreparedWeeks,
} from './lib/potw-email.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

// Trim a pending record to what the admin UI needs (keeps the HTML for preview).
function toAdmin(rec) {
  if (!rec) return null;
  const w = rec.winner || {};
  return {
    winnerKey: rec.winnerKey,
    name: w.name || '',
    teamName: w.teamName || '',
    gender: w.gender || null,
    stats: { w: w.w, l: w.l, dsr: w.dsr, diff: w.diff, ps: w.ps },
    subject: rec.subject || '',
    to: rec.to || null,
    recipientType: rec.recipientType || 'none',
    captainName: rec.captainName || null,
    status: rec.status || 'pending',
    size: rec.size || null,
    sentAt: rec.sentAt || null,
    html: rec.html || '',
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  if (req.method === 'GET') {
    const weeks = await listPreparedWeeks(circuit);
    const wkParam = url.searchParams.get('week');
    const week = wkParam ? Number(wkParam) : (weeks[0]?.week ?? null);
    const records = week != null ? (await listPendingForWeek(circuit, week)).map(toAdmin) : [];
    return json({
      circuit,
      week,
      weeks: weeks.map(m => ({ week: m.week, preparedAt: m.preparedAt })),
      records,
    });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    if (body.action === 'generate') {
      // Silent draft of the latest completed week (no approval email).
      const result = await prepareWeeklyPotwApproval(circuit, { force: true, notify: false });
      return json({ ok: !!result.ok, result });
    }

    if (body.action === 'send') {
      if (!body.week || !body.winnerKey) return json({ error: 'week and winnerKey required' }, 400);
      const out = await sendApprovedPotw(circuit, Number(body.week), body.winnerKey, admin.email);
      const status = out.ok ? 200 : (out.reason === 'already-sent' ? 409 : 400);
      return json(out, status);
    }

    return json({ error: `Unknown action: ${body.action}` }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-potw' };
