// netlify/functions/lib/traffic.js
//
// Page-level site analytics: who is on the site right now, which pages they
// open, how long they spend on each, and how long a visit lasts. Powers the
// admin "Traffic" page (public/admin-traffic.html via admin-traffic.js).
// The beacon is public/js/ds-track.js → track.js.
//
// Store: `site-traffic`
//
//   pv/<day>/<pvid>.json   one blob per PAGE VIEW, rewritten by that page only
//                          (start → heartbeats → end), so there is no shared
//                          counter to race on. <day> is the Pacific date the
//                          view started.
//   live/<sid>.json        presence — one per browser session, current page
//   vid/<vid>.json         browser id → the signed-in person last seen on it,
//                          so anonymous views from that browser get a name
//   day/<day>.json         compacted rows for a finished day (built lazily
//                          by the admin read, raw pv/ blobs deleted after)
//   cache/<day>.json       etag-keyed row cache for the day still in progress
//
// Durations are ACTIVE time: the tab is visible and the person has touched,
// scrolled or typed within the last few minutes. A tab left open overnight
// does not count as eight hours on the Schedule page.
//
// Everything that runs on the beacon path NEVER throws.

import { getStore } from '@netlify/blobs';
import { requireAdmin } from './admin-auth.js';
import { requirePlayer, getPlayerToken } from './player-auth.js';
import { requireCaptain, getCaptainToken } from './captain-auth.js';
import { recordPageview } from './activity-log.js';

export const STORE = 'site-traffic';
export const TZ = 'America/Los_Angeles';
export const LIVE_WINDOW_MS = 75 * 1000;      // heartbeat is 30s → 2 missed = gone
const WHO_TTL_MS = 10 * 60 * 1000;             // re-resolve identity at most every 10 min
const MAX_PV_MS = 4 * 60 * 60 * 1000;          // cap a single page view at 4h active
const QUERY_KEYS = ['slug', 'id', 'team', 'player', 'tab', 'week', 'circuit', 'division', 'season', 'ladder', 'event', 'm'];
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|node-fetch|axios/i;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });

/** Pacific calendar date YYYY-MM-DD for a timestamp. */
export function pacificDay(ms = Date.now()) { return dayFmt.format(new Date(ms)); }
/** Pacific hour 0–23 for a timestamp. */
export function pacificHour(ms) { return parseInt(hourFmt.format(new Date(ms)), 10) % 24; }

/** Inclusive list of YYYY-MM-DD strings from → to (max 92). */
export function dayRange(from, to) {
  const out = [];
  const a = Date.parse(from + 'T12:00:00Z'), b = Date.parse(to + 'T12:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return out;
  for (let t = a; t <= b && out.length < 92; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Shift a YYYY-MM-DD by n days. */
export function addDays(day, n) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
}

export function isBot(ua) { return !ua || BOT_RE.test(ua); }

export function cleanId(v) {
  return typeof v === 'string' && /^[a-z0-9]{8,40}$/i.test(v) ? v.toLowerCase() : null;
}

/** Path only, lowercase, no .html, no trailing slash; "/" for home. */
export function cleanPath(p) {
  let s = String(p || '/').split('?')[0].split('#')[0].toLowerCase().slice(0, 120);
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Keep only whitelisted query params — magic-link tokens never get stored. */
export function cleanQuery(q) {
  const out = {};
  if (!q || typeof q !== 'object') return out;
  for (const k of QUERY_KEYS) {
    const v = q[k];
    if (typeof v === 'string' && v && v.length <= 60) out[k] = v;
  }
  return out;
}

export function cleanHash(h) {
  const s = String(h || '').replace(/^#/, '');
  return /^[a-z0-9/_-]{1,30}$/i.test(s) ? s.toLowerCase() : '';
}

/** The "screen" a page view is grouped under: path + tab (query or hash). */
export function screenKey({ path, q, h }) {
  const tab = (q && q.tab) || h || '';
  return tab ? `${path}#${String(tab).toLowerCase()}` : path;
}

export function refHost(ref) {
  if (!ref || typeof ref !== 'string') return '';
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, '').replace(/^(l|lm|m)\.(instagram|facebook)\.com$/, '$2.com').slice(0, 60);
  } catch { return ''; }
}

export function parseDevice(ua = '', { pwa = false, sw = 0, touch = false } = {}) {
  let os = 'Other', type = 'desktop', br = 'Other';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) { os = 'iPadOS'; type = 'tablet'; } // iPadOS Safari sends a Mac UA
  else if (/iPhone|iPod/.test(ua)) { os = 'iOS'; type = 'mobile'; }
  else if (/Android/.test(ua)) { os = 'Android'; type = /Mobile/.test(ua) ? 'mobile' : 'tablet'; }
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (type === 'desktop' && sw && sw < 700) type = 'mobile';
  if (/Instagram/.test(ua)) br = 'Instagram';
  else if (/FBAN|FBAV/.test(ua)) br = 'Facebook';
  else if (/SamsungBrowser/.test(ua)) br = 'Samsung';
  else if (/Edg\//.test(ua)) br = 'Edge';
  else if (/Firefox|FxiOS/.test(ua)) br = 'Firefox';
  else if (/Chrome|CriOS/.test(ua)) br = 'Chrome';
  else if (/Safari/.test(ua)) br = 'Safari';
  if (pwa) br = 'App';
  return { type, os, br };
}

// ── Identity ────────────────────────────────────────────────────────────────

function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

/**
 * Who is behind this request? Only touches session stores when the matching
 * cookie is actually present, so anonymous visitors cost nothing.
 * → { k: 'player'|'captain'|'admin'|'anon', n, e, t, tid, pid, adm }
 */
export async function resolveWho(req) {
  const who = { k: 'anon' };
  try {
    if (cookie(req, 'admin_session')) {
      const a = await requireAdmin(req).catch(() => null);
      if (a?.email) { who.adm = true; who.e = a.email.toLowerCase(); }
    }
    if (getPlayerToken(req)) {
      const ctx = await requirePlayer(req).catch(() => null);
      if (ctx?.player) {
        return {
          ...who, k: 'player', n: ctx.player.name || null, e: (ctx.session?.email || ctx.player.email || '').toLowerCase() || null,
          t: ctx.team?.name || null, tid: ctx.teamId || null, pid: ctx.playerId || null,
        };
      }
    }
    if (getCaptainToken(req)) {
      const ctx = await requireCaptain(req).catch(() => null);
      if (ctx?.team) {
        const email = (ctx.user?.email || '').toLowerCase();
        const p = (ctx.team.roster || []).find(r => (r.normalizedEmail || (r.email || '').toLowerCase()) === email);
        return { ...who, k: 'captain', n: p?.name || null, e: email || null, t: ctx.team.name || null, tid: ctx.team.id || null, pid: p?.id || null };
      }
    }
    if (who.adm) return { ...who, k: 'admin', n: null };
  } catch (err) {
    console.warn('resolveWho failed (non-fatal):', err?.message || err);
  }
  return who;
}

// ── Beacon write path ───────────────────────────────────────────────────────

/**
 * Record one beacon. body (from ds-track.js):
 *   { k: 'start'|'hb'|'hide'|'end', vid, sid, pvid, st, ms, sc, path, q, h,
 *     title, ref, src, sw, pwa, ss }
 */
export async function recordHit(body, req, context = {}) {
  try {
    const ua = req.headers.get('user-agent') || '';
    if (isBot(ua)) return;
    const vid = cleanId(body.vid), sid = cleanId(body.sid), pvid = cleanId(body.pvid);
    if (!vid || !sid || !pvid) return;

    const now = Date.now();
    let st = Number(body.st);
    if (!Number.isFinite(st) || st > now + 60e3 || st < now - 12 * 3600e3) st = now; // bad clock → server time
    const day = pacificDay(st);
    // A beacon for a day that has already been compacted is dropped: the
    // client starts a fresh view when a stale tab wakes up (ds-track.js).
    if (day < pacificDay(now - 3 * 3600e3) && day !== pacificDay(now)) return;

    const store = getStore(STORE);
    const key = `pv/${day}/${pvid}.json`;
    const liveKey = `live/${sid}.json`;
    const kind = ['start', 'hb', 'hide', 'end'].includes(body.k) ? body.k : 'hb';
    const ms = Math.max(0, Math.min(MAX_PV_MS, Math.round(Number(body.ms) || 0)));
    const sc = Math.max(0, Math.min(100, Math.round(Number(body.sc) || 0)));

    const [prev, live] = await Promise.all([
      store.get(key, { type: 'json' }).catch(() => null),
      store.get(liveKey, { type: 'json' }).catch(() => null),
    ]);

    // Identity: reuse the session's cached answer; re-resolve every 10 min or
    // when a new page view starts on a browser that had no name yet.
    let who = prev?.who || null;
    let whoAt = live?.whoAt || 0;
    if (!who) {
      const cached = live?.who && (now - whoAt) < WHO_TTL_MS
        && !(live.who.k === 'anon' && hasSessionCookie(req)); // just signed in → look again
      if (cached) who = live.who;
      else { who = await resolveWho(req); whoAt = now; }
    }

    const path = cleanPath(body.path);
    const q = cleanQuery(body.q);
    const h = cleanHash(body.h);
    const title = String(body.title || '').replace(/\s*[·|–-]\s*The Dink Society\s*$/i, '').slice(0, 80);

    let rec;
    if (prev) {
      rec = prev;
      rec.ms = Math.max(prev.ms || 0, ms);
      rec.sc = Math.max(prev.sc || 0, sc);
      rec.last = now;
      if (kind === 'end') rec.end = true;
    } else {
      const geo = context?.geo || {};
      const dev = parseDevice(ua, { pwa: !!body.pwa, sw: Number(body.sw) || 0, touch: !!body.tp });
      rec = {
        id: pvid, sid, vid, day,
        at: st, last: now, ms, sc,
        path, q, h, s: screenKey({ path, q, h }), title,
        ref: refHost(body.ref), src: typeof body.src === 'string' ? body.src.slice(0, 40).toLowerCase() : '',
        dev: dev.type, os: dev.os, br: dev.br,
        city: geo.city || '', region: geo.subdivision?.code || '', country: geo.country?.code || '',
        who,
        end: kind === 'end',
      };
    }
    await store.setJSON(key, rec);

    // Presence. A hide/end from an older page that lands after the next
    // page's start must not overwrite it.
    const away = kind === 'hide' || kind === 'end';
    const sameView = !live || live.pvid === pvid;
    if (!(away && !sameView)) {
      const newView = !live || live.pvid !== pvid;
      await store.setJSON(liveKey, {
        sid, vid, pvid,
        path: rec.s, title: rec.title, pvAt: rec.at, ms: rec.ms,
        sessAt: live?.sessAt || rec.at,
        pages: live ? (live.pages || 1) + (newView ? 1 : 0) : 1,
        ref: live ? (live.ref || '') : rec.ref,
        dev: rec.dev, os: rec.os, br: rec.br, city: rec.city, region: rec.region,
        who, whoAt, last: now, away,
      });
    }

    // Remember which person this browser belongs to.
    if (who && who.k !== 'anon' && who.e && !prev) {
      const v = await store.get(`vid/${vid}.json`, { type: 'json' }).catch(() => null);
      if (!v || v.e !== who.e || (now - (v.at || 0)) > 864e5) {
        await store.setJSON(`vid/${vid}.json`, { ...who, at: now });
      }
    }

    // Keep the older daily counter (admin Analytics → Public site traffic) fed.
    if (!prev && kind === 'start') await recordPageview({ path: body.path, vid });
  } catch (err) {
    console.error('recordHit failed (non-fatal):', err);
  }
}

function hasSessionCookie(req) {
  return !!(getPlayerToken(req) || getCaptainToken(req) || cookie(req, 'admin_session'));
}

// ── Admin read path ─────────────────────────────────────────────────────────

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

function compact(r) {
  return {
    id: r.id, sid: r.sid, vid: r.vid, at: r.at, last: r.last, ms: r.ms || 0, sc: r.sc || 0,
    s: r.s || r.path, path: r.path, title: r.title || '', ref: r.ref || '', src: r.src || '',
    dev: r.dev, os: r.os, br: r.br, city: r.city || '', region: r.region || '', who: r.who || { k: 'anon' },
  };
}

/**
 * All page-view rows for one Pacific day. Finished days are compacted once
 * into day/<day>.json and their raw blobs deleted; today is read through an
 * etag cache so each refresh only fetches views that changed.
 */
export async function loadDayRows(store, day, now = Date.now()) {
  const final = day < pacificDay(now - 3 * 3600e3);
  if (final) {
    const done = await store.get(`day/${day}.json`, { type: 'json' }).catch(() => null);
    if (done?.rows) return done.rows;
  }
  const { blobs } = await store.list({ prefix: `pv/${day}/` }).catch(() => ({ blobs: [] }));
  const cache = (await store.get(`cache/${day}.json`, { type: 'json' }).catch(() => null)) || { etags: {}, rows: {} };
  const need = blobs.filter(b => cache.etags[b.key] !== b.etag || !cache.rows[b.key]);
  const got = await mapLimit(need, 40, b => store.get(b.key, { type: 'json' }).catch(() => null));
  need.forEach((b, i) => { if (got[i]) { cache.rows[b.key] = compact(got[i]); cache.etags[b.key] = b.etag; } });
  const liveKeys = new Set(blobs.map(b => b.key));
  for (const k of Object.keys(cache.rows)) if (!liveKeys.has(k)) { delete cache.rows[k]; delete cache.etags[k]; }
  const rows = Object.values(cache.rows);

  if (final) {
    await store.setJSON(`day/${day}.json`, { day, builtAt: new Date(now).toISOString(), rows });
    await mapLimit(blobs.map(b => b.key), 20, k => store.delete(k).catch(() => null));
    await store.delete(`cache/${day}.json`).catch(() => null);
  } else if (need.length || blobs.length !== Object.keys(cache.rows).length) {
    await store.setJSON(`cache/${day}.json`, cache).catch(() => null);
  }
  return rows;
}

export async function loadVidMap(store) {
  const { blobs } = await store.list({ prefix: 'vid/' }).catch(() => ({ blobs: [] }));
  const docs = await mapLimit(blobs, 40, b => store.get(b.key, { type: 'json' }).catch(() => null));
  const map = new Map();
  blobs.forEach((b, i) => { if (docs[i]) map.set(b.key.slice(4, -5), docs[i]); });
  return map;
}

/** Give anonymous rows the name of whoever has signed in on that browser. */
export function attribute(rows, vidMap) {
  for (const r of rows) {
    if ((!r.who || r.who.k === 'anon') && vidMap.has(r.vid)) {
      const w = vidMap.get(r.vid);
      r.who = { k: w.k, n: w.n, e: w.e, t: w.t, tid: w.tid, pid: w.pid, adm: w.adm, inferred: true };
    }
  }
  return rows;
}

export function personKey(who, vid) { return who?.e ? `e:${who.e}` : `v:${vid}`; }

export function displayName(who, row = {}) {
  if (who?.n) return who.n;
  if (who?.e) return who.e;
  const place = row.city ? ` · ${row.city}` : '';
  return `Visitor ${String(row.vid || '').slice(0, 4).toUpperCase()}${place}`;
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/** Group rows into sessions (by sid), newest first. */
export function buildSessions(rows) {
  const by = new Map();
  for (const r of rows) {
    let s = by.get(r.sid);
    if (!s) { s = { sid: r.sid, vid: r.vid, rows: [] }; by.set(r.sid, s); }
    s.rows.push(r);
  }
  const out = [];
  for (const s of by.values()) {
    s.rows.sort((a, b) => a.at - b.at);
    const first = s.rows[0];
    const who = s.rows.map(r => r.who).find(w => w && w.k !== 'anon') || first.who || { k: 'anon' };
    const start = first.at;
    const end = Math.max(...s.rows.map(r => r.last || r.at));
    out.push({
      sid: s.sid, vid: s.vid, key: personKey(who, s.vid), who, name: displayName(who, first),
      start, end, span: end - start, ms: s.rows.reduce((t, r) => t + (r.ms || 0), 0),
      ref: first.ref || '', src: first.src || '', dev: first.dev, os: first.os, br: first.br, city: first.city, region: first.region,
      pages: s.rows.map(r => ({ s: r.s, title: r.title, at: r.at, ms: r.ms || 0, sc: r.sc || 0 })),
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

/** Full report for a set of rows. */
export function buildReport(rows, { from, to } = {}) {
  const sessions = buildSessions(rows);
  const sessByKey = new Map();
  const pages = new Map();
  const byDay = new Map();
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, pv: 0, v: new Set() }));
  const refs = {}, devs = {}, brs = {}, cities = {};

  for (const s of sessions) {
    if (!sessByKey.has(s.key)) sessByKey.set(s.key, []);
    sessByKey.get(s.key).push(s);
    const refLabel = s.src ? `${s.src} (link)` : (s.ref || 'Direct / app');
    refs[refLabel] = (refs[refLabel] || 0) + 1;
    devs[s.dev || 'desktop'] = (devs[s.dev || 'desktop'] || 0) + 1;
    brs[s.br || 'Other'] = (brs[s.br || 'Other'] || 0) + 1;
    if (s.city) { const c = s.region ? `${s.city}, ${s.region}` : s.city; cities[c] = (cities[c] || 0) + 1; }
    s.pages.forEach((p, i) => {
      let g = pages.get(p.s);
      if (!g) { g = { s: p.s, titles: {}, views: 0, v: new Set(), ms: 0, timed: 0, sc: 0, entries: 0, exits: 0, msList: [] }; pages.set(p.s, g); }
      g.views++; g.v.add(s.key); g.ms += p.ms; g.sc += p.sc;
      if (p.ms > 0) { g.timed++; g.msList.push(p.ms); }
      if (p.title) g.titles[p.title] = (g.titles[p.title] || 0) + 1;
      if (i === 0) g.entries++;
      if (i === s.pages.length - 1) g.exits++;
      const d = pacificDay(p.at);
      let dd = byDay.get(d);
      if (!dd) { dd = { date: d, pv: 0, v: new Set(), sessions: new Set(), ms: 0 }; byDay.set(d, dd); }
      dd.pv++; dd.v.add(s.key); dd.sessions.add(s.sid); dd.ms += p.ms;
      const hr = hours[pacificHour(p.at)]; hr.pv++; hr.v.add(s.key);
    });
  }

  const people = [];
  for (const [key, list] of sessByKey) {
    const who = list.map(s => s.who).find(w => w && w.k !== 'anon') || list[0].who;
    const pv = list.reduce((t, s) => t + s.pages.length, 0);
    const ms = list.reduce((t, s) => t + s.ms, 0);
    const counts = {};
    list.forEach(s => s.pages.forEach(p => { counts[p.s] = (counts[p.s] || 0) + p.ms + 1; }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    people.push({
      key, who, name: list[0].name && who === list[0].who ? list[0].name : displayName(who, list[0]),
      kind: who?.k || 'anon', team: who?.t || '', adm: !!who?.adm, inferred: !!who?.inferred,
      sessions: list.length, pv, ms, avgSessionMs: Math.round(ms / list.length),
      first: Math.min(...list.map(s => s.start)), last: Math.max(...list.map(s => s.end)),
      top, dev: list[0].dev, br: list[0].br, city: list[0].city,
    });
  }
  people.sort((a, b) => b.last - a.last);

  const sessMs = sessions.map(s => s.ms);
  const pvMs = rows.map(r => r.ms || 0).filter(x => x > 0);
  const identified = people.filter(p => p.kind !== 'anon').length;
  const bounces = sessions.filter(s => s.pages.length === 1).length;
  const top = (o, n = 10) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, n]) => ({ label, n }));

  return {
    range: { from, to },
    kpis: {
      pageviews: rows.length,
      visitors: people.length,
      signedIn: identified,
      anonymous: people.length - identified,
      sessions: sessions.length,
      avgSessionMs: sessions.length ? Math.round(sessMs.reduce((a, b) => a + b, 0) / sessions.length) : 0,
      medianSessionMs: median(sessMs),
      avgPageMs: pvMs.length ? Math.round(pvMs.reduce((a, b) => a + b, 0) / pvMs.length) : 0,
      totalMs: sessMs.reduce((a, b) => a + b, 0),
      pagesPerSession: sessions.length ? +(rows.length / sessions.length).toFixed(1) : 0,
      bounceRate: sessions.length ? Math.round(100 * bounces / sessions.length) : 0,
    },
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ date: d.date, pv: d.pv, visitors: d.v.size, sessions: d.sessions.size, ms: d.ms })),
    byHour: hours.map(h => ({ h: h.h, pv: h.pv, visitors: h.v.size })),
    pages: [...pages.values()].map(g => ({
      s: g.s, title: Object.entries(g.titles).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      views: g.views, visitors: g.v.size, totalMs: g.ms,
      avgMs: g.timed ? Math.round(g.ms / g.timed) : 0, medianMs: median(g.msList),
      avgScroll: g.views ? Math.round(g.sc / g.views) : 0,
      entries: g.entries, exits: g.exits, exitRate: g.views ? Math.round(100 * g.exits / g.views) : 0,
    })).sort((a, b) => b.views - a.views),
    people,
    sessions: sessions.slice(0, 250),
    sessionsTotal: sessions.length,
    referrers: top(refs), devices: top(devs), browsers: top(brs), cities: top(cities, 12),
  };
}

/** Who is on the site right now (plus who left in the last 15 minutes). */
export async function loadLive(store, vidMap, now = Date.now()) {
  const { blobs } = await store.list({ prefix: 'live/' }).catch(() => ({ blobs: [] }));
  const docs = await mapLimit(blobs, 40, b => store.get(b.key, { type: 'json' }).catch(() => null));
  const active = [], recent = [], stale = [];
  blobs.forEach((b, i) => {
    const d = docs[i];
    if (!d) return;
    const age = now - (d.last || 0);
    if (age > 864e5) { stale.push(b.key); return; }
    let who = d.who || { k: 'anon' };
    if (who.k === 'anon' && vidMap.has(d.vid)) { const w = vidMap.get(d.vid); who = { ...w, inferred: true }; }
    const row = {
      sid: d.sid, vid: d.vid, key: personKey(who, d.vid), who, name: displayName(who, d),
      path: d.path, title: d.title, pvAt: d.pvAt, ms: d.ms || 0, sessAt: d.sessAt, pages: d.pages || 1,
      ref: d.ref || '', dev: d.dev, os: d.os, br: d.br, city: d.city, region: d.region, last: d.last,
    };
    if (!d.away && age <= LIVE_WINDOW_MS) active.push(row);
    else if (age <= 15 * 60e3) recent.push(row);
  });
  if (stale.length) await mapLimit(stale.slice(0, 200), 20, k => store.delete(k).catch(() => null));
  active.sort((a, b) => a.sessAt - b.sessAt);
  recent.sort((a, b) => b.last - a.last);
  return { now, active, recent };
}

/** Drop compacted days older than ~13 months. Cheap: one list. */
export async function pruneOld(store, now = Date.now()) {
  try {
    const cutoff = pacificDay(now - 400 * 864e5);
    const { blobs } = await store.list({ prefix: 'day/' }).catch(() => ({ blobs: [] }));
    const old = blobs.map(b => b.key).filter(k => k.slice(4, 14) < cutoff);
    await mapLimit(old.slice(0, 50), 10, k => store.delete(k).catch(() => null));
  } catch {}
}
