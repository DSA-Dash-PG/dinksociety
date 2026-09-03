// netlify/functions/public-settings.js
//
// The public half of the league's settings record. Every public page pulls this
// once (js/partials.js → window.DS_SETTINGS) to fill the venue, the fees, the
// season length and the planned week dates.
//
// It exists because admin-settings used to answer GET with no auth, which meant
// the whole record — waiver text, email templates, balance-due dates, the admin
// who last saved it — was readable by anyone who opened the site. The fields
// below are the ones the public site actually renders. ADD NOTHING ELSE HERE
// without deciding it is fine for the world to read; anything left out simply
// does not reach the page.

import { getStore } from '@netlify/blobs';
import { normalizeWeekDates } from './lib/week-dates.js';

const PUBLIC_DEFAULTS = {
  circuitName:   'Season 1',
  startDate:     '2026-06-08',
  weeks:         8,
  matchTime:     '7:00–9:00 PM',
  teamFee:       '$700',
  agentFee:      '$75',
  depositAmount: 250,
  defaultVenue:  '',
  divisions:     ['3.0–3.5 Mixed'],
  teamsPerDiv:   6,
  venues:        [],
  weekDates:     {},
};

// Venues are shown on the schedule and match cards, so name/address/courts are
// public — but only those three, never whatever else ends up on the record.
function publicVenue(v) {
  return {
    id:      String(v?.id ?? ''),
    name:    String(v?.name ?? ''),
    address: String(v?.address ?? ''),
    courts:  String(v?.courts ?? ''),
  };
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  let s = { ...PUBLIC_DEFAULTS };
  try {
    const store = getStore({ name: 'config', consistency: 'strong' });
    const raw = await store.get('circuit-settings');
    if (raw) s = { ...PUBLIC_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    console.error('public-settings read error:', e);
    // Fall through with defaults — the site renders, it just shows the seeds.
  }

  const body = {
    circuitName:   s.circuitName,
    startDate:     s.startDate,
    weeks:         s.weeks,
    matchTime:     s.matchTime,
    teamFee:       s.teamFee,
    agentFee:      s.agentFee,
    depositAmount: s.depositAmount,
    defaultVenue:  s.defaultVenue,
    divisions:     Array.isArray(s.divisions) ? s.divisions : PUBLIC_DEFAULTS.divisions,
    teamsPerDiv:   s.teamsPerDiv,
    venues:        Array.isArray(s.venues) ? s.venues.map(publicVenue) : [],
    weekDates:     normalizeWeekDates(s.weekDates, s.circuitName),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Settings change a few times a season; a short cache keeps every page
      // view from hitting Blobs while staying fresh enough for an admin edit.
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
};

export const config = { path: '/.netlify/functions/public-settings' };
