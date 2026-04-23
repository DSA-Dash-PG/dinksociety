// netlify/functions/lib/admin-auth.js
// Magic-link auth for admins. No Supabase dependency.
// Mirrors the captain-auth.js pattern exactly.

import { getStore } from '@netlify/blobs';

const COOKIE_NAME = 'ds_admin_session';
const SESSION_DAYS = 7;
const TOKEN_MINUTES = 15;

// ===== Cookie helpers =====

export function getSessionToken(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildSessionCookie(sessionId) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ].join('; ');
}

export function buildClearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ===== Session lifecycle =====

export async function createSession(email) {
  const sessionId = randomId(20);
  const store = getStore('admin-sessions');
  await store.setJSON(`session/${sessionId}.json`, {
    id: sessionId,
    email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  return sessionId;
}

export async function deleteSession(sessionId) {
  if (!sessionId) return;
  const store = getStore('admin-sessions');
  await store.delete(`session/${sessionId}.json`).catch(() => null);
}

// ===== Magic-link tokens =====

export async function createMagicToken(email) {
  const token = randomId(24);
  const store = getStore('admin-tokens');
  await store.setJSON(`token/${token}.json`, {
    token,
    email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_MINUTES * 60 * 1000).toISOString(),
  });
  return token;
}

export async function consumeMagicToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const store = getStore('admin-tokens');
  const record = await store.get(`token/${token}.json`, { type: 'json' }).catch(() => null);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  // One-time use — delete immediately
  await store.delete(`token/${token}.json`).catch(() => null);
  return { email: record.email };
}

// ===== Auth guard =====

function getAdminEmails() {
  return (Netlify.env.get('ADMIN_EMAILS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export async function requireAdmin(req) {
  const sessionId = getSessionToken(req);
  if (!sessionId) return null;

  const store = getStore('admin-sessions');
  const session = await store.get(`session/${sessionId}.json`, { type: 'json' }).catch(() => null);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await store.delete(`session/${sessionId}.json`).catch(() => null);
    return null;
  }

  // Double-check the email is still in the admin list
  const adminEmails = getAdminEmails();
  if (!adminEmails.includes(session.email)) return null;

  return { id: sessionId, email: session.email };
}

// ===== Standard responses =====

export function unauthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ===== Utilities =====

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
