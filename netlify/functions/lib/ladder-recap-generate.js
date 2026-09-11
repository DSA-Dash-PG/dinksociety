// netlify/functions/lib/ladder-recap-generate.js
//
// Turns one finished ladder night's STATS BRIEF into a two-part recap and saves
// it as a DRAFT.
//   Part 1: a short personalized note for EACH player (keyed by playerId).
//   Part 2: the shared night recap.
//
// The writer is lib/ladder-recap-basic.js: templated straight off the numbers,
// no API and no key. There used to be an Anthropic path here with the templated
// writer as its fallback; it was removed (Richard, 2026-09-11) because the
// league isn't using an API key, and a "fallback" that is always the one doing
// the work is just the writer with extra steps. Everything downstream is
// unchanged — same record shape, same email renderer.

import { buildRecapBrief } from './ladder-recap-insights.js';
import { saveRecapDraft, getRecap } from './ladder-recap.js';
import { buildBasicRecap } from './ladder-recap-basic.js';

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

  const ai = buildBasicRecap(brief);

  const rec = await saveRecapDraft(eventId, {
    generatedBy: 'templated',
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
    // Merge the written prose with the hard numbers per player so the email
    // renderer has both.
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

  return { ok: true, record: rec, engine: 'templated' };
}
