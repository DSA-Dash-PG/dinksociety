// =============================================================
// netlify/functions/admin-traffic.js
//
// Admin-only read API for the Traffic page (public/admin-traffic.html).
//
// GET ?view=live                         → who is on the site right now
// GET ?view=report&from=YYYY-MM-DD&to=…  → pages, people, sessions, time on
//                                          site for a Pacific date range
//     &admins=1                          → include admin browsing (off by default)
// GET ?view=person&key=<e:email|v:vid>&from&to → every session for one person
//
// Data comes from lib/traffic.js (store `site-traffic`).
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import {
  STORE, pacificDay, addDays, dayRange, loadDayRows, loadVidMap, attribute,
  buildReport, buildSessions, loadLive, pruneOld, personKey,
} from './lib/traffic.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'report';
  const includeAdmins = url.searchParams.get('admins') === '1';
  const store = getStore(STORE);
  const now = Date.now();

  try {
    const vidMap = await loadVidMap(store);

    if (view === 'live') {
      const live = await loadLive(store, vidMap, now);
      if (!includeAdmins) {
        live.active = live.active.filter(r => !r.who?.adm);
        live.recent = live.recent.filter(r => !r.who?.adm);
      }
      return json(live);
    }

    const today = pacificDay(now);
    let to = url.searchParams.get('to');
    let from = url.searchParams.get('from');
    if (!DAY_RE.test(to || '')) to = today;
    if (to > today) to = today;
    if (!DAY_RE.test(from || '')) from = to;
    if (from > to) from = to;
    if (from < addDays(to, -89)) from = addDays(to, -89);
    const days = dayRange(from, to);

    const perDay = [];
    for (const d of days) perDay.push(await loadDayRows(store, d, now)); // sequential: bounded memory + blob load
    let rows = attribute(perDay.flat().map(r => ({ ...r, who: r.who ? { ...r.who } : { k: 'anon' } })), vidMap);
    if (!includeAdmins) rows = rows.filter(r => !r.who?.adm);

    if (view === 'person') {
      const key = url.searchParams.get('key') || '';
      const mine = rows.filter(r => personKey(r.who, r.vid) === key);
      const sessions = buildSessions(mine);
      const report = buildReport(mine, { from, to });
      return json({ key, from, to, person: report.people[0] || null, kpis: report.kpis, pages: report.pages, sessions });
    }

    const report = buildReport(rows, { from, to });
    await pruneOld(store, now);
    return json(report);
  } catch (err) {
    console.error('admin-traffic failed:', err);
    return json({ error: err.message || 'Failed' }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-traffic' };
