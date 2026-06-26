// netlify/functions/lib/ladder-recap.js
// Storage for ladder-night recap drafts. One record per event:
//
//   ladder-recaps  recap/<eventId>.json
//   { eventId, status:'draft'|'sent', generatedAt, generatedBy, model,
//     sentAt?, sentCount?,
//     recap: { title, dek, html, seasonNote, podium, minis },   // Part 2 (shared)
//     players: { <playerId>: { hi, place, sub, story[], call{}, streak{} } }, // Part 1
//     recipients: [{ playerId, name, email }] }
//
// NEVER sent automatically — the admin reviews and hits Send (mirrors The Drop
// and the POTW mailer).

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-recaps';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

export async function getRecap(eventId) {
  return store().get(`recap/${eventId}.json`, { type: 'json' }).catch(() => null);
}

export async function saveRecapDraft(eventId, data) {
  const rec = {
    eventId,
    status: 'draft',
    generatedAt: new Date().toISOString(),
    ...data,
  };
  await store().setJSON(`recap/${eventId}.json`, rec);
  return rec;
}

export async function markRecapSent(eventId, sentCount) {
  const rec = await getRecap(eventId);
  if (!rec) return null;
  rec.status = 'sent';
  rec.sentAt = new Date().toISOString();
  rec.sentCount = sentCount;
  await store().setJSON(`recap/${eventId}.json`, rec);
  return rec;
}

export async function listRecaps() {
  const s = store();
  const { blobs } = await s.list({ prefix: 'recap/' }).catch(() => ({ blobs: [] }));
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
}
