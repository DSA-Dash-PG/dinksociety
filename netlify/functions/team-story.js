// netlify/functions/team-story.js
//
// The team story questionnaire, captain side.
//
//   GET  /.netlify/functions/team-story?t=<token>     → the team, its saved answers, the questions
//   POST /.netlify/functions/team-story { t?, answers } → save answers (replaces the set)
//
// Auth is EITHER the signed link token from the captain's email (no login
// needed) OR a captain-portal session cookie (the "Tell your story" card in the
// portal). The token is bound to the team AND the captain's email, and that
// email must still be the team's captain or a co-captain — so a link that was
// sent to a captain who has since handed the team over stops working.
//
// Admins get a short email whenever a story is saved so Richard sees what came
// in without checking every team page.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { shouldHideTestRecord } from './lib/test-data.js';
import { adminEmailList } from './lib/admin-auth.js';
import { sendEmail } from './lib/email.js';
import { QUESTIONS, sanitizeAnswers, answeredCount, verifyStoryToken } from './lib/team-story.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});
const siteUrl = () => ((typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app').replace(/\/$/, '');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lower = s => String(s || '').toLowerCase().trim();

/** Captain-side identity for this request: { team, email, name, via } or null. */
async function resolve(req, token) {
  const store = getStore('teams');
  if (token) {
    const t = verifyStoryToken(token);
    if (!t) return { error: 'This link is not valid.' };
    const team = await store.get(`team/${t.teamId}.json`, { type: 'json' }).catch(() => null);
    if (!team) return { error: 'That team is no longer on the site.' };
    const email = lower(t.email);
    const roster = team.roster || [];
    const isCap = email && lower(team.captainEmail) === email;
    const isCo = email && roster.some(p => lower(p.email) === email && p.isCoCaptain && !p.archived);
    if (!isCap && !isCo) return { error: 'This link belonged to a previous captain. Ask the league for a fresh one.' };
    const who = roster.find(p => lower(p.email) === email);
    return { store, team, email, name: (who && who.name) || team.captainName || '', via: 'link' };
  }
  const session = await verifyCaptainSession(req);
  if (!session.valid || !session.payload?.team?.id) return null;
  const id = session.payload.team.id;
  const team = await store.get(`team/${id}.json`, { type: 'json' }).catch(() => null) || session.payload.team;
  const email = lower(session.payload.user?.email || session.payload.session?.email);
  const who = (team.roster || []).find(p => lower(p.email) === email);
  return { store, team, email, name: (who && who.name) || '', via: 'portal' };
}

/** Other teams in the same season — suggestions for the "who do you want to beat" question. */
async function seasonTeams(store, team) {
  const code = circuitCode(team.circuit || team.seasonId);
  const out = [];
  try {
    const { blobs } = await store.list({ prefix: 'team/' });
    for (const b of blobs) {
      const t = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (!t || t.id === team.id) continue;
      if (shouldHideTestRecord(t, team.seasonId || '')) continue;
      if (circuitCode(t.circuit || t.seasonId) !== code) continue;
      out.push({ name: t.name, emoji: t.emoji || '', division: t.divisionLabel || t.division || '', same: t.division === team.division });
    }
  } catch {}
  out.sort((a, b) => (b.same - a.same) || a.name.localeCompare(b.name));
  return out;
}

function teamView(team) {
  const capEmail = lower(team.captainEmail);
  const cap = (team.roster || []).find(p => lower(p.email) === capEmail);
  return {
    id: team.id, name: team.name, emoji: team.emoji || '', color: team.color || null,
    division: team.division || '', divisionLabel: team.divisionLabel || team.division || '',
    captainName: (cap && cap.name) || team.captainName || '',
    rosterNames: (team.roster || []).filter(p => !p.archived).map(p => p.name).filter(Boolean),
    seasonId: team.seasonId || null, circuit: circuitCode(team.circuit || team.seasonId),
  };
}

async function notifyAdmins(team, answers, byName, byEmail) {
  const to = adminEmailList();
  if (!to.length) return;
  const rows = QUESTIONS.filter(q => answers[q.key] != null).map(q => {
    const v = answers[q.key];
    return `<div style="margin:0 0 14px;"><div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:4px;">${esc(q.label)}</div><div style="font-size:14px;color:#f5f5f5;line-height:1.55;white-space:pre-wrap;">${esc(Array.isArray(v) ? v.join(', ') : v)}</div></div>`;
  }).join('');
  const slug = String(team.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const link = `${siteUrl()}/team?id=${encodeURIComponent(slug)}`;
  const html = `
    <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:28px;">THE DINK SOCIETY</div>
      <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;line-height:1.15;">${esc(team.emoji ? team.emoji + ' ' : '')}${esc(team.name)} told their story</h1>
      <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0 0 22px;">${esc(byName || byEmail || 'The captain')} filled in ${Object.keys(answers).length} of ${QUESTIONS.length} questions. It's live on the team page now.</p>
      <div style="background:#161616;border-radius:8px;padding:16px 16px 2px;margin:0 0 22px;">${rows}</div>
      <a href="${link}" style="display:inline-block;background:#b8ff2c;color:#0e0e0e;font-weight:800;font-size:14px;padding:12px 22px;border-radius:9999px;text-decoration:none;">Open the team page</a>
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">The Dink Society · Team story submitted from the questionnaire.</div>
    </div>`;
  await Promise.all(to.map(addr => sendEmail({ to: addr, subject: `Team story: ${team.name}`, html }).catch(e => console.error('team-story admin notify failed:', addr, e?.message || e))));
}

export default async (req) => {
  const url = new URL(req.url);
  try {
    if (req.method === 'GET') {
      const who = await resolve(req, url.searchParams.get('t') || '');
      if (!who) return json({ error: 'Sign in to the Captain Portal, or use the link from your email.' }, 401);
      if (who.error) return json({ error: who.error }, 403);
      const { store, team } = who;
      return json({
        team: teamView(team),
        story: { answers: (team.story && team.story.answers) || {}, updatedAt: (team.story && team.story.updatedAt) || null, answered: answeredCount(team.story), total: QUESTIONS.length },
        questions: QUESTIONS,
        teams: await seasonTeams(store, team),
        you: { name: who.name, email: who.email, via: who.via },
      });
    }

    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { body = {}; }
      const who = await resolve(req, body.t || url.searchParams.get('t') || '');
      if (!who) return json({ error: 'Sign in to the Captain Portal, or use the link from your email.' }, 401);
      if (who.error) return json({ error: who.error }, 403);
      const { store, team } = who;

      const answers = sanitizeAnswers(body.answers);
      const key = `team/${team.id}.json`;
      const fresh = await store.get(key, { type: 'json' }).catch(() => null) || team;
      const first = !(fresh.story && answeredCount(fresh.story));
      fresh.story = {
        answers,
        updatedAt: new Date().toISOString(),
        updatedBy: who.email || null,
        updatedByName: who.name || null,
        createdAt: (fresh.story && fresh.story.createdAt) || new Date().toISOString(),
      };
      fresh.updatedAt = fresh.story.updatedAt;
      await store.setJSON(key, fresh);

      // Tell the admins — every save, so an edited story is seen too. Not on an
      // empty save (a captain clearing everything out is not news).
      if (Object.keys(answers).length) await notifyAdmins(fresh, answers, who.name, who.email).catch(() => {});

      return json({ ok: true, first, story: { answers, updatedAt: fresh.story.updatedAt, answered: answeredCount(fresh.story), total: QUESTIONS.length } });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (err) {
    console.error('team-story error:', err);
    return json({ error: 'Something went wrong saving your story. Try again in a minute.' }, 500);
  }
};

export const config = { path: '/.netlify/functions/team-story' };
