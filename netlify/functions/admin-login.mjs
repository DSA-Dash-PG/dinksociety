// =============================================================
// POST /api/admin-login
// Accepts { email }, checks ADMIN_EMAILS, generates a magic-link
// token, stores it in Netlify Blobs, and sends the link via Resend.
// Always returns 200 to prevent email enumeration.
// =============================================================

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const SITE_URL = process.env.SITE_URL || 'https://dinksociety.netlify.app';
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { email } = await req.json();
    const normalised = (email || '').trim().toLowerCase();

    // Generic success — even if the email isn't an admin
    const okResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (!normalised || !ADMIN_EMAILS.includes(normalised)) {
      return okResponse();
    }

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    const store = getStore('admin-tokens');
    await store.setJSON(token, {
      email: normalised,
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    // Build magic link
    const link = `${SITE_URL}/.netlify/functions/admin-auth?token=${token}`;

    // Send via Resend
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const EMAIL_FROM = process.env.EMAIL_FROM || 'The Dink Society <noreply@dinksociety.com>';

    if (!RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set — cannot send admin magic link');
      return okResponse();
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [normalised],
        subject: 'Your Dink Society admin sign-in link',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
            <p style="color: #0D3B40; font-size: 14px; margin: 0 0 24px;">
              Hey — someone (hopefully you) requested an admin sign-in link for The Dink Society.
            </p>
            <a href="${link}" style="display: inline-block; background: #0D3B40; color: #E8B542; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
              Sign in to Admin
            </a>
            <p style="color: #666; font-size: 13px; margin: 24px 0 0;">
              This link expires in 15 minutes and can only be used once.<br/>
              If you didn't request this, just ignore it.
            </p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend error:', errText);
    }

    return okResponse();
  } catch (err) {
    console.error('admin-login error:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
