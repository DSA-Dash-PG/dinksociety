// =============================================================
// POST /api/admin-login
//
// Magic-link login for admins. Accepts { email }, checks if the
// email is in the ADMIN_EMAILS env var, generates a one-time
// token, stores it in Netlify Blobs, and emails a sign-in link
// via Resend.
//
// Always returns 200 with a generic message to prevent email
// enumeration — same pattern as captain-login.
// =============================================================

import { getStore } from '@netlify/blobs';
import { sendEmail } from './lib/email.js';
import crypto from 'crypto';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { email } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ ok: true, message: 'If that email is an admin, a link is on its way.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const normalized = email.trim().toLowerCase();

    // Check against ADMIN_EMAILS env var (comma-separated)
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (adminEmails.includes(normalized)) {
      // Generate a one-time token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

      // Store in Netlify Blobs
      const store = getStore('admin-magic-links');
      await store.set(token, JSON.stringify({
        email: normalized,
        expiresAt,
        used: false,
      }));

      // Build the magic link URL
      const siteUrl = process.env.SITE_URL || `https://${process.env.URL || 'localhost:8888'}`;
      const magicLink = `${siteUrl}/.netlify/functions/admin-link?token=${token}`;

      // Send the email — Night-Match design system
      await sendEmail({
        to: normalized,
        subject: 'Your Dink Society admin sign-in link',
        html: `
          <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
            <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">THE DINK SOCIETY</div>
            <h1 style="font-size: 24px; font-weight: 800; text-transform: uppercase; color: #f5f5f5; margin: 0 0 12px;">Admin Sign-In</h1>
            <p style="font-size: 15px; color: #8a8a8a; line-height: 1.6; margin: 0 0 28px;">
              Tap the button below to sign into the admin portal. This link expires in 15 minutes and can only be used once.
            </p>
            <a href="${magicLink}" style="display: inline-block; padding: 14px 32px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
              Sign in to Admin
            </a>
            <p style="font-size: 12px; color: #555; margin-top: 28px; line-height: 1.5;">
              If you didn't request this, you can safely ignore it. The link will expire on its own.
            </p>
            <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
              The Dink Society · Southern California Pickleball League
            </div>
          </div>
        `,
      });
    }

    // Always return success (prevents enumeration)
    return new Response(JSON.stringify({ ok: true, message: 'If that email is an admin, a link is on its way.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('admin-login error:', err);
    return new Response('Server error', { status: 500 });
  }
};
