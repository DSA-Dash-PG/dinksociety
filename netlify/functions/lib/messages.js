// netlify/functions/lib/messages.js
// Shared helpers for the admin <-> captain message center.
//
// Stores:
//   messages       team/<teamId>/<msgId>.json  → one blob per message
//   message-reads  team/<teamId>.json          → { captainReadAt, adminReadAt }
//
// A "thread" is the conversation between one team's captain(s) and the league
// admin. Broadcasts append an admin message to many teams' threads at once.

import { getStore } from '@netlify/blobs';

export function getMessagesStore() { return getStore('messages'); }
export function getReadsStore() { return getStore('message-reads'); }

export function generateId(prefix = 'msg_') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return all messages for a team's thread, oldest → newest.
 */
export async function listThread(teamId) {
  if (!teamId) return [];
  const store = getMessagesStore();
  const { blobs } = await store.list({ prefix: `team/${teamId}/` }).catch(() => ({ blobs: [] }));
  const msgs = await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return msgs.filter(Boolean).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/**
 * Append a message to a team's thread.
 * @param {{ teamId, from:'admin'|'captain', authorName?, authorEmail?, body, broadcastId?:string|null }} opts
 */
export async function appendMessage({ teamId, from, authorName, authorEmail, body, broadcastId = null }) {
  const store = getMessagesStore();
  const msg = {
    id: generateId(),
    teamId,
    from,
    authorName: authorName || (from === 'admin' ? 'League Admin' : 'Captain'),
    authorEmail: authorEmail || null,
    body: String(body || '').slice(0, 5000),
    broadcastId,
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(`team/${teamId}/${msg.id}.json`, msg);
  return msg;
}

export async function getReads(teamId) {
  const store = getReadsStore();
  return (await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null)) || {};
}

/**
 * Mark a thread read for one side ('admin' or 'captain').
 */
export async function setRead(teamId, side) {
  const store = getReadsStore();
  const reads = await getReads(teamId);
  const field = side === 'admin' ? 'adminReadAt' : 'captainReadAt';
  reads[field] = new Date().toISOString();
  await store.setJSON(`team/${teamId}.json`, reads);
  return reads;
}

/**
 * Count messages from the *other* side that arrived after this side last read.
 * For the captain, unread = admin messages after captainReadAt.
 * For the admin,   unread = captain messages after adminReadAt.
 */
export function unreadCount(messages, reads, side) {
  const field = side === 'admin' ? 'adminReadAt' : 'captainReadAt';
  const otherFrom = side === 'admin' ? 'captain' : 'admin';
  const since = reads?.[field] ? new Date(reads[field]).getTime() : 0;
  return messages.filter(m => m.from === otherFrom && new Date(m.createdAt).getTime() > since).length;
}
