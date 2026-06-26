// netlify/functions/lib/ladder-recap-basic.js
//
// A NO-API recap writer. Takes the same STATS BRIEF the Claude generator uses
// (buildRecapBrief) and templates a clean, warm two-part recap straight from the
// numbers — so a recap can always go out even without Anthropic API access.
// Output matches the Claude shape: { recap:{title,dek,html,seasonNote}, players }.
//
// Style rules kept in line with the league voice: address players by first name,
// first name + last initial on first mention in the article, uplifting, and NO
// em dashes anywhere (recast instead).

const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'Player';
function lastInitial(n) {
  const parts = String(n || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || 'Player');
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
const rec = p => `${p.w}-${p.l}`;
const dff = p => `${p.diff >= 0 ? '+' : ''}${p.diff}`;
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Templated Part 1 note for one player, chosen by their pre-computed angle. */
function basicPlayer(p, count) {
  const fn = firstName(p.name);
  let hi, sub, story = [], call = null, streak = null;

  switch (p.angle) {
    case 'won':
      hi = `Wire to wire, ${fn}.`; sub = `1st of ${count}`;
      story.push(`You won the night, ${fn}. ${rec(p)} with a ${dff(p)} differential is the kind of line that ends with your name on top.`);
      break;
    case 'first_podium':
      hi = `Podium debut, ${fn}.`; sub = `${ordinal(p.rank)} of ${count}`;
      story.push(`Your first time on the podium, ${fn}, and you earned every bit of it at ${rec(p)}.`);
      break;
    case 'podium':
      hi = `On the podium, ${fn}.`; sub = `${ordinal(p.rank)} of ${count}`;
      story.push(`${ordinal(p.rank)} place at ${rec(p)}. Sharp all night and right in the title mix.`);
      break;
    case 'big_climb':
    case 'climb':
      hi = `Climbing, ${fn}.`; sub = `#${p.rank} of ${count}`;
      story.push(`You moved up ${p.delta} spot${p.delta === 1 ? '' : 's'} to #${p.rank} tonight, ${fn}. ${rec(p)}, ${dff(p)}, and trending the right way.`);
      break;
    case 'best_finish':
      hi = `New high, ${fn}.`; sub = `#${p.rank} of ${count}`;
      story.push(`That is your best finish yet, ${fn}. #${p.rank} at ${rec(p)} and still climbing.`);
      break;
    case 'streak':
      hi = `On a heater, ${fn}.`; sub = `#${p.rank} of ${count}`;
      story.push(`You stacked a ${p.maxStreak}-game win streak tonight. ${rec(p)} with a ${dff(p)} differential.`);
      break;
    case 'tough':
      hi = `Battled all night, ${fn}.`; sub = `#${p.rank} of ${count}`;
      story.push(`The record (${rec(p)}) does not show how close it was. A ${dff(p)} differential says the games were tight and you were in every one.`);
      break;
    default:
      hi = `Solid night, ${fn}.`; sub = `#${p.rank} of ${count}`;
      story.push(`${rec(p)} with a ${dff(p)} differential. Quietly reliable, exactly the kind of night that adds up over a season.`);
  }

  if (p.partners && p.partners.length) {
    call = { title: 'Partners', body: `You teamed up with ${p.partners.join(' and ')} out there.` };
  } else if (p.beat && p.beat.length) {
    call = { title: 'Statement win', body: `Notched a win over ${p.beat.join(' and ')}.` };
  }

  if (p.maxStreak >= 2) streak = { emoji: '🔥', text: `Best run of your night: ${p.maxStreak} straight.` };
  else streak = { emoji: '🎾', text: `Night ${p.nights} on the ladder, ${p.seasonWins} season win${p.seasonWins === 1 ? '' : 's'} and counting.` };

  return { hi, sub, story, call, streak };
}

/**
 * Build a full recap draft (Part 1 + Part 2) from the stats brief, no AI.
 * @returns {{ recap:{title,dek,html,seasonNote}, players:Object }}
 */
export function buildBasicRecap(brief) {
  const { event, night, recap } = brief;
  const podium = recap.podium || [];
  const winner = podium[0] || null;

  const title = winner ? `${firstName(winner.name)} takes ${event.name}` : `${event.name} recap`;
  const dek = `${night.count} player${night.count === 1 ? '' : 's'} · ${night.courts} court${night.courts === 1 ? '' : 's'} · ${night.rounds} round${night.rounds === 1 ? '' : 's'}`;

  const paras = [];
  if (winner) {
    paras.push(`<p><strong>${esc(lastInitial(winner.name))}</strong> ran the ladder at ${esc(event.name)}, finishing ${winner.w}-${winner.l} with a ${winner.diff >= 0 ? '+' : ''}${winner.diff} point differential to take the top spot.</p>`);
  }
  if (podium.length >= 3) {
    paras.push(`<p>${esc(lastInitial(podium[1].name))} (${podium[1].w}-${podium[1].l}) and ${esc(lastInitial(podium[2].name))} (${podium[2].w}-${podium[2].l}) rounded out the podium.</p>`);
  } else if (podium.length === 2) {
    paras.push(`<p>${esc(lastInitial(podium[1].name))} (${podium[1].w}-${podium[1].l}) was right behind in second.</p>`);
  }

  const bits = [];
  if (recap.biggestMover) bits.push(`${firstName(recap.biggestMover.name)} climbed from #${recap.biggestMover.from} to #${recap.biggestMover.to}`);
  if (recap.topGame && recap.topGame.score) bits.push(`the highest-scoring game of the night hit ${recap.topGame.score} on Court ${recap.topGame.court}`);
  if (recap.mvpFemale) bits.push(`${firstName(recap.mvpFemale.name)} led the way at ${recap.mvpFemale.w}-${recap.mvpFemale.l}`);
  if (bits.length) paras.push(`<p>Around the courts: ${bits.join('; ')}.</p>`);

  const att = recap.attendance || {};
  let seasonNote;
  if (att.prevAvg != null) {
    const dir = att.tonight > att.prevAvg ? 'up from a recent average of' : att.tonight < att.prevAvg ? 'down from a recent average of' : 'right at the recent average of';
    seasonNote = `<p>That is night ${recap.seasonNightsSoFar} in the books, with ${att.tonight} player${att.tonight === 1 ? '' : 's'} out, ${dir} ${att.prevAvg}. See you on the ladder.</p>`;
  } else {
    seasonNote = `<p>That is night ${recap.seasonNightsSoFar} on the ladder in the books. See you next time.</p>`;
  }

  const players = {};
  for (const p of night.players) players[p.id] = basicPlayer(p, night.count);

  return { recap: { title, dek, html: paras.join(''), seasonNote }, players };
}
