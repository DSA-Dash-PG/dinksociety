// netlify/functions/lib/recap-article-store.js
// Storage for the GENERATED full-length recap articles (the long-form
// /ladders/recaps/<eventId> pages). One record per event:
//
//   ladder-recap-articles   article/<eventId>.json
//   { eventId, date, slug, title, html, stats, narrative,
//     generatedBy, model, notes, createdAt, updatedAt }
//
// Deliberately separate from the `ladder-recaps` store (which holds the SHORT
// per-player recap EMAIL drafts, lib/ladder-recap.js). Different lifecycle:
// the email is a draft that waits for admin review and gets sent once; the
// article is a public page that can be regenerated any number of times.
//
// The seven hand-built articles from Jul–Aug 2026 are NOT in here — they are
// static files under public/ladders/recaps/ and Netlify serves those first.
// See lib/recap-articles.js for that map.

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-recap-articles';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

const key = eventId => `article/${eventId}.json`;

/** The stored article record for one event, or null. */
export async function getArticle(eventId) {
  if (!eventId) return null;
  return store().get(key(eventId), { type: 'json' }).catch(() => null);
}

/** Create or replace the article record for one event. */
export async function saveArticle(eventId, rec) {
  const now = new Date().toISOString();
  const existing = await getArticle(eventId);
  const out = {
    ...rec,
    eventId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await store().setJSON(key(eventId), out);
  return out;
}

/** Cheap existence check — avoids pulling a ~50KB html blob in the cron loop. */
export async function hasArticle(eventId) {
  if (!eventId) return false;
  const meta = await store().getMetadata(key(eventId)).catch(() => null);
  if (meta) return true;
  // getMetadata isn't supported on every runtime — fall back to a real read.
  return !!(await getArticle(eventId));
}

/** Every stored article, newest night first. Omits `html` unless withHtml. */
export async function listArticles({ withHtml = false } = {}) {
  const s = store();
  const { blobs } = await s.list({ prefix: 'article/' }).catch(() => ({ blobs: [] }));
  const recs = (await Promise.all(
    blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  recs.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return withHtml ? recs : recs.map(({ html, ...rest }) => rest);
}

export async function deleteArticle(eventId) {
  await store().delete(key(eventId)).catch(() => {});
}
