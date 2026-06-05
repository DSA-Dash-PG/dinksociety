// netlify/functions/lib/team-chat.js
// Shared helpers for the PLAYER team chat — a single group thread shared by
// everyone on one team's roster. This is deliberately separate from the
// admin <-> captain message center (lib/messages.js): different store, different
// read-tracking model.
//
// Stores:
//   team-chat        team/<teamId>/<msgId>.json   → one blob per message
//   team-chat-reads  team/<teamId>/<playerId>.json → { readAt }  (per player)
//
// Read state is PER PLAYER (not per side), because in a group chat each
// teammate has their own "last seen" position. Unread = messages authored by
// *someone else* after this player last read the thread.

import { getStore } from '@netlify/blobs';

export function getTeamChatStore() { return getStore('team-chat'); }
export function getTeamChatReadsStore() { return getStore('team-chat-reads'); }
export function getTeamChatPrefsStore() { return getStore('team-chat-prefs'); }

export function generateId(prefix = 'tcm_') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return every message in a team's chat, oldest → newest.
 * @param {string} teamId
 */
export async function listTeamChat(teamId) {
  if (!teamId) return [];
  const store = getTeamChatStore();
  const { blobs } = await store.list({ prefix: `team/${teamId}/` }).catch(() => ({ blobs: [] }));
  const msgs = await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return msgs.filter(Boolean).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/**
 * Append a message to a team's chat.
 * @param {{ teamId:string, authorId:string, authorName?:string, authorEmail?:string, body:string }} opts
 */
export async function appendTeamChatMessage({ teamId, authorId, authorName, authorEmail, body }) {
  const store = getTeamChatStore();
  const msg = {
    id: generateId(),
    teamId,
    authorId: authorId || null,
    authorName: authorName || 'Player',
    authorEmail: authorEmail || null,
    body: String(body || '').slice(0, 5000),
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(`team/${teamId}/${msg.id}.json`, msg);
  return msg;
}

export async function getPlayerRead(teamId, playerId) {
  if (!teamId || !playerId) return {};
  const store = getTeamChatReadsStore();
  return (await store.get(`team/${teamId}/${playerId}.json`, { type: 'json' }).catch(() => null)) || {};
}

/**
 * Mark the thread read for one player (records "now").
 */
export async function setPlayerRead(teamId, playerId) {
  if (!teamId || !playerId) return {};
  const store = getTeamChatReadsStore();
  const reads = { readAt: new Date().toISOString() };
  await store.setJSON(`team/${teamId}/${playerId}.json`, reads);
  return reads;
}

/**
 * Count messages authored by *other* teammates after this player last read.
 * @param {object[]} messages  result of listTeamChat
 * @param {object}   reads     result of getPlayerRead
 * @param {string}   playerId
 */
export function unreadCountForPlayer(messages, reads, playerId) {
  const since = reads?.readAt ? new Date(reads.readAt).getTime() : 0;
  return messages.filter(m =>
    m.authorId !== playerId && new Date(m.createdAt).getTime() > since
  ).length;
}

// ── Email-notification preference (per player, per team) ──────
// Default is ON: players are notified unless they explicitly opt out.

/**
 * Whether this player wants email when a teammate posts. Defaults to true.
 * @returns {Promise<boolean>}
 */
export async function getNotifyPref(teamId, playerId) {
  if (!teamId || !playerId) return true;
  const store = getTeamChatPrefsStore();
  const pref = await store.get(`team/${teamId}/${playerId}.json`, { type: 'json' }).catch(() => null);
  return pref?.emailNotify !== false; // missing/true → notify; only false opts out
}

/**
 * Save this player's email-notification preference.
 */
export async function setNotifyPref(teamId, playerId, emailNotify) {
  if (!teamId || !playerId) return;
  const store = getTeamChatPrefsStore();
  await store.setJSON(`team/${teamId}/${playerId}.json`, { emailNotify: !!emailNotify });
}
