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
 *
 * `audiences` gates by WHO the broadcast was for (its `audience` field):
 *   - players see ONLY broadcasts addressed to players → pass ['players']
 *   - captains see everything → omit `audiences` (no audience filter)
 * Legacy broadcasts with no `audience` default to 'captains', so they never
 * leak to players. The `scope` field (all/division/teams) still controls WHICH
 * teams a broadcast reaches, independently of audience.
 *
 * @param {{ teamId?:string, division?:string, limit?:number, audiences?:string[] }} opts
 * @returns {Promise<Array<{id,subject,body,scope,audience,sentAt,sentBy}>>}
 */
export async function getRelevantAnnouncements({ teamId = null, division = null, limit = 5, audiences = null } = {}) {
  try {
    const store = getStore('broadcasts');
    const { blobs } = await store.list({ prefix: 'broadcast/' }).catch(() => ({ blobs: [] }));
    if (!blobs?.length) return [];

    const all = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    const audSet = audiences ? new Set(audiences) : null;
    const relevant = all.filter(bc => {
      // Audience gate (who the message was for).
      if (audSet && !audSet.has(bc.audience || 'captains')) return false;
      // Scope gate (which teams it reached).
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
      audience: bc.audience || 'captains',
      sentAt: bc.sentAt || null,
      sentBy: bc.sentBy || null,
    }));
  } catch (e) {
    console.error('getRelevantAnnouncements failed:', e);
    return [];
  }
}
