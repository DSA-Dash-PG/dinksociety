// netlify/functions/lib/drop-generate.js
//
// Core of the weekly auto-draft. Builds the stats brief, asks the Claude API to
// write the editorial (lead + 3–4 picked storylines), and saves it as a DRAFT.
// NEVER publishes — that stays a human action in the admin composer.
//
// Invoked two ways:
//   - drop-cron.js          (Netlify scheduled function, Tuesdays)
//   - admin-drop-generate.js (admin "Draft with Claude" button, on demand)
//
// Env:
//   ANTHROPIC_API_KEY  (required)  — the API key for generation
//   DROP_MODEL         (optional)  — model id, default 'claude-sonnet-4-6'
//
// Idempotency: skips a week that is already PUBLISHED or whose draft was
// hand-edited (generatedBy:'manual'), unless force=true. Re-generates its own
// prior auto-drafts.

import { circuitCode } from './circuit.js';
import { getDrop, saveDraft } from './drop.js';
import { buildWeeklyBrief } from './drop-insights.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function apiKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('ANTHROPIC_API_KEY')) || process.env.ANTHROPIC_API_KEY || '';
}
function modelId() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_MODEL')) || process.env.DROP_MODEL || DEFAULT_MODEL;
}

const SYSTEM = `You are the editorial voice of "The Drop", the weekly column for The Dink Society — a social pickleball league in Southern California. You write like a great sports columnist who is secretly having the time of their life: confident, specific, very funny, and warm. Pickleball texture is welcome (the kitchen, dinks, the third shot, gold-game finishes) but never forced.

VOICE — study and match this:
- Give the week's standout team or player an EARNED epithet — a one-line identity ("The Apex Predator", "The [Name] Show, Hunting #2", "Started Hot, Holding On"). Make the reader grin.
- Name REAL players with their EXACT numbers — DSR rating, W–L record, +/- game differential — and the context ("dropped a season-high 97.3 with a +38"). Specificity is the whole game: it's what makes it funny AND gives players their shine.
- Deadpan, affectionate hyperbole for dominance ("a differential that breaks the spreadsheet", "that's not a beating, that's a deposition"). Land the joke, then move on.
- NEVER punch down. Every team and player gets a real bright spot and is treated with dignity — a swept team gets "long shots become folklore" / "please bounce back, we believe in you", never cruelty. Roast records and math, never people.
- When the brief carries standings stakes (seeds, magic numbers, clinching, playoff race), lean in and treat the math as a character ("three races at once", "magic number is 4"). Do NOT invent stakes that aren't in the data — early weeks have no playoff race, so play the sweeps, streaks, and individual nights instead.
- Recurring deadpan refrains and callbacks are welcome when they earn it.

You will be given a STATS BRIEF for one week. Your job:
1. Pick the 3–4 BEST storylines from the brief — the ones a reader would actually care about. Lead with the single biggest one.
2. Write a lead story (2–3 short punchy paragraphs) and 2–3 shorter follow storylines.
3. Secondary goal: make sure the standout team and players of the week get their due BY NAME, with their numbers, woven into the stories.

Only use facts present in the brief. Do not invent scores, names, ratings, or streaks. If the brief is thin, write a shorter column rather than padding.

Return ONLY valid JSON, no markdown fence, in exactly this shape:
{
  "title": "lead headline (no team name colon-style clickbait)",
  "dek": "one-sentence sub-headline",
  "leadHtml": "<p>…</p><p>…</p>  (you may include one <blockquote>…</blockquote> pull-quote)",
  "storylines": [
    { "tag": "short label e.g. Upset", "tagKind": "title|upset|streak|riser|note", "title": "headline", "html": "<p>…</p>", "chips": [ { "label": "Streak", "value": "11 games" } ] }
  ]
}
The first storyline in the array is the SECOND story on the page (the lead above is separate). Keep HTML to <p>, <strong>, <em>, <blockquote> only.`;

function buildUserPrompt(brief) {
  return `STATS BRIEF — ${brief.circuit} · Week ${brief.week}\n\n` + JSON.stringify({
    week: brief.week,
    results: brief.results,
    streaks: brief.streaks,
    upsets: brief.upsets,
    blowouts: brief.blowouts,
    playersOfTheWeek: brief.performers?.potw,
    teamOfTheWeek: brief.performers?.teamOfWeek,
    dsrRisers: brief.performers?.risers,
  }, null, 2);
}

function extractJson(text) {
  if (!text) throw new Error('Empty model response');
  // Tolerate a stray ```json fence or surrounding prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON object in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

async function callClaude(brief) {
  const key = apiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId(),
      max_tokens: 1800,
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
 * Generate (or regenerate) a DRAFT for one week.
 * @returns {Promise<{ ok, status, week, skipped?, reason? , record? }>}
 */
export async function generateDropDraft(circuit, { week = null, force = false } = {}) {
  const code = circuitCode(circuit);
  const brief = await buildWeeklyBrief(code, week);
  if (brief.empty || !brief.week) {
    return { ok: false, skipped: true, reason: 'no-finalized-results', week: brief.week || 0 };
  }

  // Respect human work + published editions.
  const existing = await getDrop(code, brief.week);
  if (existing && !force) {
    if (existing.status === 'published') return { ok: false, skipped: true, reason: 'already-published', week: brief.week };
    if (existing.generatedBy === 'manual') return { ok: false, skipped: true, reason: 'manual-draft-exists', week: brief.week };
  }

  const ed = await callClaude(brief);

  const rec = await saveDraft(code, brief.week, {
    kicker: `The Drop · Week ${brief.week}`,
    title: ed.title || `Week ${brief.week} in the books`,
    dek: ed.dek || null,
    byline: 'By The Society Desk',
    leadHtml: ed.leadHtml || '',
    storylines: Array.isArray(ed.storylines) ? ed.storylines : [],
    performers: brief.performers,
    generatedBy: 'auto',
    source: { briefAt: new Date().toISOString(), model: modelId(), counts: { streaks: brief.streaks.length, upsets: brief.upsets.length, blowouts: brief.blowouts.length } },
  }, 'drop-generator');

  return { ok: true, status: rec.status, week: rec.week, record: rec };
}
