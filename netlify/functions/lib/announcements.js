// netlify/functions/lib/announcements.js
//
// Surfaces admin BROADCASTS (league announcements) to the player + captain
// portals. Broadcasts are logged by admin-messages.js to the `broadcasts`
// store as broadcast/<id>.json:
//   { id, subject, body, scope:'all'|'division'|'teams', division, teamIds,
//     audience, teamCount, sentBy, sentAt }
//
// "League-wide notice" = scope 'all'. We also surface division- and
// team-targeted broadcasts to the teams they were aimed at, since those are
// equally announcements the recipient should see.

import { getStore } from '@netlify/blobs';

/**
 * Recent announcements relevant to a given team, newest first.
 * @param {{ teamId?:string, division?:string, limit?:number }} opts
 * @returns {Promise<Array<{id,subject,body,scope,sentAt,sentBy}>>}
 */
export async function getRelevantAnnouncements({ teamId = null, division = null, limit = 5 } = {}) {
  try {
    const store = getStore('broadcasts');
    const { blobs } = await store.list({ prefix: 'broadcast/' }).catch(() => ({ blobs: [] }));
    if (!blobs?.length) return [];

    const all = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    const relevant = all.filter(bc => {
      if (bc.scope === 'all' || !bc.scope) return true;
      if (bc.scope === 'division') return !!division && bc.division === division;
      if (bc.scope === 'teams') return !!teamId && Array.isArray(bc.teamIds) && bc.teamIds.includes(teamId);
      return false;
    });

    relevant.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')));

    return relevant.slice(0, limit).map(bc => ({
      id: bc.id,
      subject: bc.subject || null,
      body: bc.body || '',
      scope: bc.scope || 'all',
      sentAt: bc.sentAt || null,
      sentBy: bc.sentBy || null,
    }));
  } catch (e) {
    console.error('getRelevantAnnouncements failed:', e);
    return [];
  }
}
