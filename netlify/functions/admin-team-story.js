// netlify/functions/admin-team-story.js
//
// Admin side of the team story questionnaire.
//
//   GET  ?circuit=II              → every team in that circuit with its questionnaire
//                                   status, its captain, and the signed link to hand out
//   POST { action: 'send', teamIds?: [...], circuit?, onlyUnanswered?: true, note? }
//                                 → emails each team's captain (and co-captains) the link
//
// The link is the same stateless token team-story.js verifies, bound to the team
// id + the captain's email, so a captain who hands the team over leaves the old
// link dead. Sending to a team with no captain email is skipped and reported.

import { getStore } from '@netlify/blobs';
import { requireAdmin } from './lib/admin-auth.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { liveCircuit } from './lib/current-season.js';
import { shouldHideTestRecord } from './lib/test-data.js';
import { sendEmail } from './lib/email.js';
import { QUESTIONS, answeredCount, signStoryToken, storyUrl } from './lib/team-story.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});
const siteUrl = () => ((typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app').replace(/\/$/, '');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lower = s => String(s || '').toLowerCase().trim();

async function loadTeams(circuit) {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  const out = [];
  for (const b of blobs) {
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!t || !t.id) continue;
    if (shouldHideTestRecord(t, '')) continue;
    if (circuit && circuitCode(t.circuit || t.seasonId) !== circuit) continue;
    out.push(t);
  }
  out.sort((a, b) => String(a.division || '').localeCompare(String(b.division || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

/** Who gets the link: the captain (login identity) plus any active co-captains. */
function leaders(team) {
  const roster = (team.roster || []).filter(p => !p.archived);
  const capEmail = lower(team.captainEmail);
  const list = [];
  if (capEmail) {
    const cap = roster.find(p => lower(p.email) === capEmail);
    list.push({ email: capEmail, name: (cap && cap.name) || team.captainName || '', role: 'captain' });
  }
  for (const p of roster) {
    const e = lower(p.email);
    if (p.isCoCaptain && e && !list.some(x => x.email === e)) list.push({ email: e, name: p.name || '', role: 'cocaptain' });
  }
  return list;
}

function view(team) {
  const story = team.story || null;
  const leads = leaders(team);
  const cap = leads.find(l => l.role === 'captain') || leads[0] || null;
  return {
    id: team.id, name: team.name, emoji: team.emoji || '', division: team.divisionLabel || team.division || '',
    circuit: circuitCode(team.circuit || team.seasonId),
    captainName: cap ? cap.name : (team.captainName || ''), captainEmail: cap ? cap.email : '',
    cocaptains: leads.filter(l => l.role === 'cocaptain').map(l => l.name || l.email),
    answered: answeredCount(story), total: QUESTIONS.length,
    updatedAt: story ? story.updatedAt || null : null, updatedByName: story ? story.updatedByName || null : null,
    sentAt: team.storyInvite ? team.storyInvite.sentAt || null : null, sentCount: team.storyInvite ? team.storyInvite.count || 0 : 0,
    link: cap ? storyUrl(siteUrl(), signStoryToken({ teamId: team.id, email: cap.email })) : null,
  };
}

function renderInvite({ name, teamName, teamEmoji, seasonLabel, link, teamUrl, note }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'Captain';
  return `
    <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:28px;">THE DINK SOCIETY</div>
      <h1 style="font-size:24px;font-weight:800;margin:0 0 10px;line-height:1.15;">Tell us about ${esc(teamName)}, ${esc(first)}</h1>
      <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;">Standings tell us who's winning. They don't tell us who <b style="color:#f5f5f5;">${esc(teamEmoji ? teamEmoji + ' ' : '')}${esc(teamName)}</b> actually are — how you all know each other, how you got into pickleball, where you play when it's not a league night. We want that on your team page, in your words.</p>
      ${note ? `<div style="background:#161616;border-left:3px solid #b8ff2c;border-radius:8px;padding:12px 14px;margin:0 0 18px;font-size:14px;color:#f5f5f5;line-height:1.55;white-space:pre-wrap;">${esc(note)}</div>` : ''}
      <div style="background:#161616;border-radius:8px;padding:14px 16px;margin:0 0 22px;">
        <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px;">✍️ About five minutes · ${QUESTIONS.length} quick questions</div>
        <div style="font-size:13px;color:#cfcfcf;line-height:1.55;">Every question is optional. Whatever you answer goes live on your team page the moment you save, and you can come back and change it any time${seasonLabel ? ' during ' + esc(seasonLabel) : ''}.</div>
      </div>
      <a href="${link}" style="display:inline-block;background:#b8ff2c;color:#0e0e0e;font-weight:800;font-size:14px;padding:13px 24px;border-radius:9999px;text-decoration:none;">Tell your team's story</a>
      <p style="font-size:12px;color:#8a8a8a;line-height:1.6;margin:18px 0 0;">This link is personal to you as captain — no sign-in needed. Your team page is at <a href="${teamUrl}" style="color:#b8ff2c;">${esc(teamUrl.replace(/^https?:\/\//, ''))}</a>.</p>
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">The Dink Society · Sent to you because you captain a Dink Society team.</div>
    </div>`;
}

export default async (req) => {
  try { await requireAdmin(req); } catch { return json({ error: 'Unauthorized' }, 401); }
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const circuit = circuitCode(url.searchParams.get('circuit') || await liveCircuit());
      const teams = await loadTeams(circuit);
      return json({ circuit, season: seasonName(circuit), questions: QUESTIONS, teams: teams.map(view) });
    }

    if (req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch { body = {}; }
      if (body.action !== 'send') return json({ error: 'Unknown action' }, 400);

      const circuit = circuitCode(body.circuit || await liveCircuit());
      let teams = await loadTeams(circuit);
      const ids = Array.isArray(body.teamIds) ? body.teamIds.map(String) : null;
      if (ids && ids.length) teams = teams.filter(t => ids.includes(String(t.id)));
      if (body.onlyUnanswered) teams = teams.filter(t => !answeredCount(t.story));
      const note = String(body.note || '').trim().slice(0, 800);

      const store = getStore('teams');
      const site = siteUrl();
      const label = seasonName(circuit);
      const sent = [], skipped = [];
      for (const team of teams) {
        const leads = leaders(team);
        if (!leads.length) { skipped.push({ id: team.id, name: team.name, reason: 'no captain email' }); continue; }
        const slug = String(team.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const teamUrl = `${site}/team?id=${encodeURIComponent(slug)}`;
        let n = 0;
        for (const who of leads) {
          const link = storyUrl(site, signStoryToken({ teamId: team.id, email: who.email }));
          try {
            await sendEmail({
              to: who.email,
              subject: `Tell us about ${team.name} — five minutes, goes on your team page`,
              html: renderInvite({ name: who.name, teamName: team.name, teamEmoji: team.emoji, seasonLabel: label, link, teamUrl, note }),
            });
            n++;
          } catch (e) {
            console.error('admin-team-story send failed:', team.name, who.email, e?.message || e);
            skipped.push({ id: team.id, name: team.name, reason: `email to ${who.email} failed` });
          }
        }
        if (n) {
          // Stamp the invite on the team so the admin list shows who's been asked.
          const key = `team/${team.id}.json`;
          const fresh = await store.get(key, { type: 'json' }).catch(() => null) || team;
          fresh.storyInvite = { sentAt: new Date().toISOString(), count: ((fresh.storyInvite && fresh.storyInvite.count) || 0) + 1 };
          await store.setJSON(key, fresh).catch(e => console.error('admin-team-story stamp failed:', e?.message || e));
          sent.push({ id: team.id, name: team.name, to: leads.map(l => l.email), emails: n });
        }
      }
      return json({ ok: true, circuit, sent, skipped });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (err) {
    console.error('admin-team-story error:', err);
    return json({ error: err.message || 'Failed' }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-team-story' };
