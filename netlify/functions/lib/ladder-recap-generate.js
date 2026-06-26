// netlify/functions/lib/ladder-recap-generate.js
//
// Turns one finished ladder night's STATS BRIEF into a two-part recap and saves
// it as a DRAFT (never sends — the admin reviews and hits Send).
//   Part 1: a short personalized note for EACH player (keyed by playerId).
//   Part 2: the shared night recap "article", weaving in prior ladders.
//
// Mirrors lib/drop-generate.js: same Claude API call shape + env vars.
//   ANTHROPIC_API_KEY (required), LADDER_RECAP_MODEL or DROP_MODEL (optional).

import { buildRecapBrief } from './ladder-recap-insights.js';
import { saveRecapDraft, getRecap } from './ladder-recap.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
function apiKey() { return (typeof Netlify !== 'undefined' && Netlify.env.get('ANTHROPIC_API_KEY')) || process.env.ANTHROPIC_API_KEY || ''; }
function modelId() {
  return (typeof Netlify !== 'undefined' && (Netlify.env.get('LADDER_RECAP_MODEL') || Netlify.env.get('DROP_MODEL')))
    || process.env.LADDER_RECAP_MODEL || process.env.DROP_MODEL || DEFAULT_MODEL;
}

const SYSTEM = `You are the editorial voice of The Dink Society — a social pickleball league in Southern California — writing the recap email that goes out right after a ladder night. Same voice as the league's column "The Drop": a great sports columnist secretly having the time of their life — confident, specific, very funny, and warm.

You write TWO things from one night's STATS BRIEF:

PART 1 — a short personalized note for EVERY player in the brief, addressed to them as "you". Lead with the single most interesting TRUE thing about their night, using the "angle" hint and their exact numbers. Two short story paragraphs max. Then a one-line "call" (a highlight or a forward-looking nudge) and a one-line "streak"/season note with a fitting emoji. Use the player's FIRST NAME only (they're being addressed directly). Be uplifting even on a rough night — find the real bright spot (close games, good differential, a tough draw, season consistency). Never sarcastic at the reader's expense.

PART 2 — the shared night recap, an "article" people enjoy reading. 2–4 short punchy paragraphs. Name players with first name + last initial on first mention, first name after. Reference PRIOR ladders from the brief when it makes the story richer (rivalries, repeat winners, a climber's arc, attendance trend). Give the night an earned, grinning headline.

HARD RULES:
- Only use facts present in the brief. Never invent scores, names, ratings, finishes, or streaks.
- Roast records and math, never people. Everyone keeps their dignity.
- No em dashes anywhere. Recast the sentence instead.
- HTML only where asked, limited to <p>, <strong>/<b>, <em>, <blockquote>.
- You MUST return a Part 1 entry for EVERY playerId in night.players, using their exact id as the key.

Return ONLY valid JSON, no markdown fence, in exactly this shape:
{
  "recap": {
    "title": "grinning headline for the night",
    "dek": "one-line sub-headline with the night's shape (players, courts, rounds)",
    "html": "<p>…</p><p>…</p> (Part 2 article; one optional <blockquote> pull-quote)",
    "seasonNote": "<p>…</p> one short paragraph tying tonight to the season so far / a rivalry / a trend"
  },
  "players": {
    "<playerId>": {
      "hi": "short greeting line, e.g. 'Wire to wire, Gopi.'",
      "sub": "one-line tagline under their finish",
      "story": ["<p text, no tags>", "<p text, no tags>"],
      "call": { "title": "2–3 word label", "body": "one sentence" },
      "streak": { "emoji": "🔥", "text": "one sentence season/streak note" }
    }
  }
}`;

function buildUserPrompt(brief) {
  return `STATS BRIEF — ${brief.event.name} · ${brief.event.date || ''} · ${brief.event.type}\n\n` + JSON.stringify({
    event: brief.event,
    night: brief.night,
    recap: brief.recap,
  }, null, 2) + `\n\nWrite Part 1 for ALL ${brief.night.players.length} players (use each player's "id" as the JSON key) and the Part 2 recap.`;
}

function extractJson(text) {
  if (!text) throw new Error('Empty model response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON object in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

async function callClaude(brief) {
  const key = apiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modelId(),
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUserPrompt(brief) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(text);
}

/**
 * Generate (or regenerate) a recap DRAFT for one finished event.
 * Skips if a draft was already SENT (unless force).
 * @returns {Promise<{ ok, skipped?, reason?, record? }>}
 */
export async function generateLadderRecapDraft(eventId, { force = false } = {}) {
  const existing = await getRecap(eventId);
  if (existing && existing.status === 'sent' && !force) {
    return { ok: false, skipped: true, reason: 'already-sent' };
  }

  const brief = await buildRecapBrief(eventId);
  if (!brief) return { ok: false, skipped: true, reason: 'no-scored-play' };
  if (!brief.night.players.length) return { ok: false, skipped: true, reason: 'no-players' };

  const ai = await callClaude(brief);

  const rec = await saveRecapDraft(eventId, {
    generatedBy: 'auto',
    model: modelId(),
    event: brief.event,
    recap: {
      title: ai.recap?.title || `${brief.event.name} — recap`,
      dek: ai.recap?.dek || `${brief.night.count} players · ${brief.night.courts} courts · ${brief.night.rounds} rounds`,
      html: ai.recap?.html || '',
      seasonNote: ai.recap?.seasonNote || '',
      podium: brief.recap.podium,
      minis: {
        biggestMover: brief.recap.biggestMover,
        topGame: brief.recap.topGame,
        mvpMale: brief.recap.mvpMale,
        mvpFemale: brief.recap.mvpFemale,
        attendance: brief.recap.attendance,
      },
    },
    // Merge AI prose with the hard numbers per player so the email renderer has both.
    players: Object.fromEntries(brief.night.players.map(p => {
      const a = (ai.players && (ai.players[p.id] || ai.players[String(p.id)])) || {};
      return [p.id, {
        name: p.name, gender: p.gender, rank: p.rank, count: brief.night.count,
        w: p.w, l: p.l, diff: p.diff, dr: p.dr, delta: p.delta, angle: p.angle,
        hi: a.hi || `Nice work, ${String(p.name).split(' ')[0]}.`,
        sub: a.sub || '',
        story: Array.isArray(a.story) ? a.story : [],
        call: a.call || null,
        streak: a.streak || null,
      }];
    })),
    recipients: brief.recipients,
  });

  return { ok: true, record: rec };
}
