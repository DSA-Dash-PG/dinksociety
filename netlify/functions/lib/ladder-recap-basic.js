// netlify/functions/lib/ladder-recap-basic.js
//
// The recap writer. Takes the STATS BRIEF (buildRecapBrief) and templates the
// two-part recap straight from the numbers. No API, no key, no external call:
// this is THE writer, not a fallback, so it has to be both accurate and worth
// reading. Output shape: { recap:{title,dek,html,seasonNote}, players }.
//
// Two rules, in this order:
//
//   1. NEVER say something the numbers don't support. The old version told a
//      player whose differential was -39 across 8 games that "the games were
//      tight and you were in every one". A -39 is about 5 points a game. Say
//      the true thing; there is always a real bright spot, and a real one lands
//      better than a made up one.
//   2. Be funny. Roast the record and the math, never the person. Everyone
//      keeps their dignity, especially whoever finished last.
//
// House style: address players by first name, first name + last initial on
// first mention in the article, no em dashes anywhere (recast instead).
//
// Lines vary per player and drift over a season via pick(), which is seeded on
// the player id plus their night count, so the same person doesn't open the
// same sentence every week and two people never get the same line on one night.

const firstName = n => String(n || '').includes(' & ')
  ? String(n).split(' & ').map(firstName).join(' & ')
  : (String(n || '').trim().split(/\s+/)[0] || 'Player');

function lastInitial(n) {
  if (String(n || '').includes(' & ')) return String(n).split(' & ').map(lastInitial).join(' & ');
  const parts = String(n || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || 'Player');
}

const isPair = p => !!(p && (p.pair || String(p.name || '').includes(' & ')));
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
const rec = p => `${p.w}-${p.l}`;
const dff = p => `${p.diff >= 0 ? '+' : ''}${p.diff}`;
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plural = (n, w, s) => `${n} ${n === 1 ? w : (s || w + 's')}`;

/** Deterministic choice, so copy varies between players and across weeks. */
function pick(seed, arr) {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return arr[(h >>> 0) % arr.length];
}

/** Points per game, to one decimal, when the brief carries pf/pa. */
function perGame(p) {
  const g = (p.w || 0) + (p.l || 0);
  if (!g) return null;
  const out = { games: g, margin: Math.round((p.diff / g) * 10) / 10 };
  if (p.pf != null) out.for = Math.round((p.pf / g) * 10) / 10;
  if (p.pa != null) out.against = Math.round((p.pa / g) * 10) / 10;
  return out;
}

/**
 * Part 1: one player's own note. `angle` is precomputed in the brief; every
 * sentence below is built from that player's actual numbers.
 */
function basicPlayer(p) {
  const fn = firstName(p.name);
  const seed = `${p.id}|${p.nights || 0}`;
  const pg = perGame(p);
  let hi, sub, story = [], call = null, streak = null;

  switch (p.angle) {
    case 'won':
      hi = pick(seed, [`Wire to wire, ${fn}.`, `That's the night, ${fn}.`, `Nobody else got a look in, ${fn}.`]);
      sub = pick(seed, ['Top of the board.', 'First place, no argument.', 'The whole thing.']);
      story.push(pick(seed, [
        `You won the night, ${fn}. ${rec(p)} with a ${dff(p)} differential is the kind of line that ends with your name on top.`,
        `${rec(p)}, ${dff(p)}, first place. There is not a lot to analyze here, ${fn}. You were the best player on the court.`,
      ]));
      if (pg && pg.against != null) {
        story.push(`You gave up ${pg.against} points a game. Everyone else spent the night trying to solve that and going home unsolved.`);
      }
      break;

    case 'first_podium':
      hi = `Podium debut, ${fn}.`;
      sub = 'First trip to the podium.';
      story.push(`Your first time on the podium, ${fn}, and you did not sneak in. ${rec(p)} at ${dff(p)} is a finish you earned in front of witnesses.`);
      break;

    case 'podium':
      hi = pick(seed, [`On the podium, ${fn}.`, `Top three, ${fn}.`]);
      sub = 'In the mix all night.';
      story.push(`${ordinal(p.rank)} place at ${rec(p)}, ${dff(p)}. In the title conversation from the first round to the last, which is where you want to be standing when the math gets done.`);
      break;

    case 'big_climb':
    case 'climb':
      hi = pick(seed, [`Climbing, ${fn}.`, `Up the board, ${fn}.`]);
      sub = 'Trending the right way.';
      story.push(`You moved up ${plural(p.delta, 'spot')} to ${ordinal(p.rank)} tonight, ${fn}, on a ${rec(p)} record. The ladder is a slow machine and it is currently pointed your direction.`);
      break;

    case 'best_finish':
      hi = `New high, ${fn}.`;
      sub = 'A personal best.';
      story.push(`${ordinal(p.rank)} of ${p.count} is the best you have finished, ${fn}. ${rec(p)} at ${dff(p)}, and the old number is now just something that used to be true.`);
      break;

    case 'streak':
      hi = pick(seed, [`On a heater, ${fn}.`, `${p.maxStreak} in a row, ${fn}.`]);
      sub = `Rode a ${p.maxStreak}-game run.`;
      story.push(`You stacked ${plural(p.maxStreak, 'straight win')} in there, ${fn}, and finished ${rec(p)} at ${dff(p)}. For one stretch of the evening nobody had an answer.`);
      break;

    case 'tough': {
      // The honest branch. Separate a genuinely close night from a rough one
      // instead of calling every loss "tight", and find the real bright spot.
      const heavy = pg && pg.margin <= -3;
      const close = pg && pg.margin > -2;
      hi = pick(seed, [`Long night, ${fn}.`, `Rough one, ${fn}.`, `Tough draw, ${fn}.`]);

      if (close) {
        sub = 'Closer than the record says.';
        story.push(`${rec(p)} does not read well, but you lost the night by about ${Math.abs(pg.margin)} points a game, ${fn}. That is a couple of rallies, not a gap in level.`);
      } else if (heavy) {
        sub = 'One to file and forget.';
        story.push(pick(seed, [
          `We are not going to dress this one up, ${fn}. ${rec(p)} and ${dff(p)} across ${plural(pg.games, 'game')} is about ${Math.abs(pg.margin)} points a game going the wrong way.`,
          `${rec(p)}, ${dff(p)}. Some nights the ball simply refuses, ${fn}, and this was ${plural(pg.games, 'game')} of exactly that.`,
        ]));
      } else {
        sub = 'Grind of a night.';
        story.push(`${rec(p)} at ${dff(p)}, ${fn}. Nothing came easy and you kept turning up for the next one anyway.`);
      }

      // Bright spot, but only a true one.
      if (p.maxStreak >= 2) {
        story.push(`For the record, you won ${plural(p.maxStreak, 'game')} back to back in the middle of that, which the differential does its best to hide.`);
      } else if (p.w > 0 && p.beat && p.beat.length) {
        story.push(`You also took a game off ${p.beat[0]}, so the night was not a total loss for your reputation.`);
      } else if (p.w > 0) {
        story.push(`You still got ${plural(p.w, 'win')} on the board, which beats the alternative.`);
      } else {
        story.push(`You played every round you were given and did not once ask to go home. That counts for more than the column suggests.`);
      }
      break;
    }

    default: {
      hi = pick(seed, [`Solid night, ${fn}.`, `Steady, ${fn}.`]);
      sub = 'Quietly reliable.';
      const tail = p.diff >= 0
        ? 'Positive differential, no drama, exactly the kind of night that adds up over a season.'
        : 'The kind of night that does not make the highlight reel and quietly keeps you in the mix anyway.';
      story.push(`${rec(p)} with a ${dff(p)} differential, ${ordinal(p.rank)} of ${p.count}. ${tail}`);
    }
  }

  if (p.partners && p.partners.length) {
    call = { title: 'Partners', body: `You were out there with ${p.partners.join(' and ')}.` };
  } else if (p.beat && p.beat.length) {
    call = { title: 'Statement win', body: `Notched a win over ${p.beat.join(' and ')}. The Society keeps receipts.` };
  }

  if (p.maxStreak >= 2) {
    streak = { emoji: '🔥', text: `Best run of your night: ${p.maxStreak} straight.` };
  } else if (p.seasonPodiums > 0) {
    streak = { emoji: '🏆', text: `Night ${p.nights} on the ladder, ${plural(p.seasonPodiums, 'podium')} on the season.` };
  } else {
    streak = { emoji: '📈', text: `Night ${p.nights} on the ladder, ${plural(p.seasonWins, 'season win')} and counting.` };
  }

  return { hi, sub, story, call, streak };
}

/**
 * Build the full recap draft (Part 1 + Part 2) from the stats brief.
 * @returns {{ recap:{title,dek,html,seasonNote}, players:Object }}
 */
export function buildBasicRecap(brief) {
  const { event, night, recap } = brief;
  const podium = recap.podium || [];
  const winner = podium[0] || null;
  const seed = `${event.id}|${event.date}`;

  const title = winner
    ? `${firstName(winner.name)} ${isPair(winner) ? 'take' : 'takes'} ${event.name}`
    : `${event.name} recap`;
  const dek = `${plural(night.count, 'player')} · ${plural(night.courts, 'court')} · ${plural(night.rounds, 'round')}`;

  const paras = [];

  if (winner) {
    paras.push(`<p><strong>${esc(lastInitial(winner.name))}</strong> won the ${esc(event.name)}, finishing ${winner.w}-${winner.l} with a ${winner.diff >= 0 ? '+' : ''}${winner.diff} point differential.</p>`);
  }

  // Second and third, and the tiebreak when the record alone didn't settle it.
  if (podium.length >= 3) {
    const tiedOnWins = podium[1].w === podium[2].w && podium[1].l === podium[2].l;
    paras.push(tiedOnWins
      ? `<p>${esc(lastInitial(podium[1].name))} and ${esc(lastInitial(podium[2].name))} both finished ${podium[1].w}-${podium[1].l}, so second and third came down to point differential: ${podium[1].diff >= 0 ? '+' : ''}${podium[1].diff} against ${podium[2].diff >= 0 ? '+' : ''}${podium[2].diff}.</p>`
      : `<p>${esc(lastInitial(podium[1].name))} (${podium[1].w}-${podium[1].l}) took second and ${esc(lastInitial(podium[2].name))} (${podium[2].w}-${podium[2].l}) took third.</p>`);
  } else if (podium.length === 2) {
    paras.push(`<p>${esc(lastInitial(podium[1].name))} (${podium[1].w}-${podium[1].l}) was right behind in second.</p>`);
  }

  const bits = [];
  if (recap.biggestMover) {
    bits.push(`${firstName(recap.biggestMover.name)} climbed ${plural(recap.biggestMover.jump, 'spot')} to ${ordinal(recap.biggestMover.to)}`);
  }
  if (recap.closestGame && recap.closestGame.margin <= 2 && recap.closestGame.score) {
    bits.push(`the closest game of the night went ${recap.closestGame.score} in round ${recap.closestGame.round}`);
  }
  if (recap.topGame && recap.topGame.score && (!recap.closestGame || recap.topGame.score !== recap.closestGame.score)) {
    bits.push(`the highest-scoring one hit ${recap.topGame.score}`);
  }
  if (bits.length) paras.push(`<p>Elsewhere: ${bits.join('; ')}.</p>`);

  const att = recap.attendance || {};
  let seasonNote;
  if (att.prevAvg != null && att.tonight > att.prevAvg) {
    seasonNote = `<p>Night ${recap.seasonNightsSoFar} in the books, ${plural(att.tonight, 'player')} out against a recent average of ${att.prevAvg}. Word is getting around. See you on the ladder.</p>`;
  } else if (att.prevAvg != null && att.tonight < att.prevAvg) {
    seasonNote = `<p>Night ${recap.seasonNightsSoFar} in the books with ${plural(att.tonight, 'player')} out, a little under the recent average of ${att.prevAvg}. ${pick(seed, ['Bring somebody next time.', 'The empty spots are yours to fill.'])}</p>`;
  } else if (att.prevAvg != null) {
    seasonNote = `<p>Night ${recap.seasonNightsSoFar} in the books, ${plural(att.tonight, 'player')} out, right on the recent average. See you on the ladder.</p>`;
  } else {
    seasonNote = `<p>Night ${recap.seasonNightsSoFar} on the ladder in the books. See you next time.</p>`;
  }

  const players = {};
  for (const p of night.players) players[p.id] = basicPlayer(p);

  return { recap: { title, dek, html: paras.join(''), seasonNote }, players };
}
