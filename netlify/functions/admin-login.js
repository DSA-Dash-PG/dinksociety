// netlify/functions/admin-login.js
// Accepts an email, creates a magic-link token, emails the admin a
// one-tap sign-in URL. ALWAYS returns 200 with a generic success message
// regardless of whether the email is an admin — prevents enumeration.

import { createMagicToken } from './lib/admin-auth.js';
import { sendEmail } from './lib/email.js';

const BRAND = {
  teal: '#0D3B40',
  black: '#000000',
  gold: '#E8B542',
  cream: '#F5EBD4',
};

const GENERIC_RESPONSE = {
  ok: true,
  message: "If that email is registered as an admin, we just sent a sign-in link. Check your inbox.",
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { email } = await req.json();
    const normalized = (email || '').toString().trim().toLowerCase();

    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return json({ error: 'Valid email required' }, 400);
    }

    const adminEmails = (Netlify.env.get('ADMIN_EMAILS') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    // Always succeed externally. Only send the email if it's a real admin.
    if (!adminEmails.includes(normalized)) {
      await new Promise(r => setTimeout(r, 300));
      return json(GENERIC_RESPONSE);
    }

    const token = await createMagicToken(normalized);
    const siteUrl = (Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app').replace(/\/+$/, '');
    const magicUrl = `${siteUrl}/.netlify/functions/admin-link?token=${token}`;

    await sendEmail({
      to: normalized,
      subject: 'Sign in to Admin — The Dink Society',
      html: renderAdminMagicLink(magicUrl),
    });

    return json(GENERIC_RESPONSE);
  } catch (err) {
    console.error('admin-login error:', err);
    return json(GENERIC_RESPONSE);
  }
};

function renderAdminMagicLink(magicUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in &middot; The Dink Society</title>
</head>
<body style="margin:0; padding:0; background:${BRAND.cream}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.cream}; padding: 32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="max-width: 520px; width: 100%;">

        <tr><td style="background: linear-gradient(135deg, ${BRAND.teal} 0%, ${BRAND.black} 100%); border-radius: 12px 12px 0 0; padding: 36px 32px; color: ${BRAND.cream}; text-align: left;">
          <div style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 18px; color: ${BRAND.gold}; margin-bottom: 24px;">
            The Dink Society
          </div>
          <div style="font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: ${BRAND.gold}; margin-bottom: 12px; font-weight: 500;">
            Admin sign-in
          </div>
          <h1 style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 36px; line-height: 1.1; font-weight: 500; margin: 0; color: ${BRAND.cream};">
            One-tap to Admin.
          </h1>
        </td></tr>

        <tr><td style="background: #ffffff; padding: 32px; color: ${BRAND.teal}; text-align: left;">
          <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.65;">
            Tap the button below to sign in to the admin portal. This link is good for the next 15 minutes and can only be used once.
          </p>

          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0;">
            <tr><td align="center">
              <a href="${magicUrl}" style="display: inline-block; background: ${BRAND.gold}; color: ${BRAND.teal}; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 500; text-decoration: none;">
                Sign in to admin portal
              </a>
            </td></tr>
          </table>

          <p style="margin: 0 0 12px; font-size: 13px; line-height: 1.65; color: ${BRAND.teal}; opacity: 0.75;">
            If the button doesn't work, copy and paste this link:
          </p>
          <p style="margin: 0 0 20px; font-size: 12px; line-height: 1.5; word-break: break-all; color: ${BRAND.teal}; opacity: 0.6;">
            ${magicUrl}
          </p>

          <div style="margin: 28px 0 0; padding: 16px 20px; background: rgba(13, 59, 64, 0.04); border-radius: 8px; font-size: 13px; line-height: 1.6; color: ${BRAND.teal};">
            <strong style="font-weight: 500;">Didn't request this?</strong> Someone typed your email into the admin sign-in page. You can ignore this email &mdash; no action needed.
          </div>
        </td></tr>

        <tr><td style="background: ${BRAND.cream}; border-radius: 0 0 12px 12px; padding: 20px 32px; text-align: center; font-size: 12px; color: ${BRAND.teal};">
          <div style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 14px; color: ${BRAND.teal}; margin-bottom: 6px;">
            The Dink Society
          </div>
          <div style="opacity: 0.7;">
            <a href="https://instagram.com/dinksociety.pb" style="color: ${BRAND.teal}; text-decoration: none; font-weight: 500;">@dinksociety.pb</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/admin-login' };
