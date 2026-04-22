// netlify/functions/lib/email.js
// Shared Resend email library for The Dink Society.
// Used by: stripe-webhook.js (registration confirmations)
// Future: schedule announcements, match reminders, etc.
//
// Required env vars:
//   RESEND_API_KEY      — re_... from https://resend.com/api-keys
//   EMAIL_FROM          — e.g. "The Dink Society <hello@justdinkit.com>"
//                         The domain must be verified in Resend.
//   EMAIL_REPLY_TO      — optional, e.g. "richard@justdinkit.com"

import { Resend } from 'resend';

const BRAND = {
  teal: '#0D3B40',
  black: '#000000',
  gold: '#E8B542',
  cream: '#F5EBD4',
};

/**
 * Send an email via Resend.
 * @param {Object} opts
 * @param {string|string[]} opts.to       Single or array of recipients
 * @param {string}          opts.subject  Subject line
 * @param {string}          opts.html     HTML body
 * @param {string}          [opts.text]   Plain-text fallback (auto-generated if omitted)
 * @param {string[]}        [opts.bcc]    BCC addresses (e.g. admin)
 */
export async function sendEmail({ to, subject, html, text, bcc }) {
  const apiKey = Netlify.env.get('RESEND_API_KEY');
  const from = Netlify.env.get('EMAIL_FROM');
  const replyTo = Netlify.env.get('EMAIL_REPLY_TO');

  if (!apiKey) {
    console.warn('RESEND_API_KEY missing — skipping email send');
    return { skipped: true, reason: 'no_api_key' };
  }
  if (!from) {
    console.warn('EMAIL_FROM missing — skipping email send');
    return { skipped: true, reason: 'no_from' };
  }

  const resend = new Resend(apiKey);

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || htmlToText(html),
  };
  if (replyTo) payload.reply_to = replyTo;
  if (bcc && bcc.length) payload.bcc = bcc;

  try {
    const result = await resend.emails.send(payload);
    return { ok: true, id: result?.data?.id, result };
  } catch (err) {
    console.error('Resend send failed:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Build the confirmation email HTML for a confirmed registration.
 * @param {Object} reg Registration object with { circuit, divisionLabel, path, team, agent, id, amountPaid }
 */
export function renderRegistrationConfirmation(reg) {
  const isTeam = reg.path === 'team';
  const name = isTeam ? reg.team.players[0].name : reg.agent.name;
  const price = formatCents(reg.amountPaid || (isTeam ? 45000 : 7500));

  const rosterRows = isTeam
    ? reg.team.players.map((p, i) => `
        <tr>
          <td style="padding: 6px 0; color: ${BRAND.teal}; opacity: 0.6; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase;">
            Player ${i + 1}${i === 0 ? ' · Captain' : ''}
          </td>
          <td style="padding: 6px 0; text-align: right; color: ${BRAND.teal}; font-size: 14px;">
            ${esc(p.name)}
          </td>
        </tr>
      `).join('')
    : '';

  const detailRows = [
    ['Circuit', `Circuit ${reg.circuit} · May 2026`],
    ['Division', reg.divisionLabel || reg.division],
    ['Membership', isTeam ? `Team · ${esc(reg.team.name)}` : 'Free agent'],
    ['Amount paid', price],
    ['Reference', (reg.id || '').toUpperCase()],
  ].map(([k, v]) => `
    <tr>
      <td style="padding: 8px 0; color: ${BRAND.teal}; opacity: 0.65; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid rgba(13, 59, 64, 0.08);">${k}</td>
      <td style="padding: 8px 0; text-align: right; color: ${BRAND.teal}; font-size: 14px; font-weight: 500; border-bottom: 1px solid rgba(13, 59, 64, 0.08);">${v}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You're in &middot; The Dink Society</title>
</head>
<body style="margin:0; padding:0; background:${BRAND.cream}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.cream}; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, ${BRAND.teal} 0%, ${BRAND.black} 100%); border-radius: 12px 12px 0 0; padding: 40px 32px; color: ${BRAND.cream}; text-align: left;">
              <div style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 18px; color: ${BRAND.gold}; margin-bottom: 32px;">
                The Dink Society
              </div>
              <div style="font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: ${BRAND.gold}; margin-bottom: 14px; font-weight: 500;">
                Circuit ${reg.circuit} &middot; May 2026
              </div>
              <h1 style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 40px; line-height: 1.1; font-weight: 500; margin: 0; color: ${BRAND.cream};">
                You're in, ${esc(firstName(name))}.
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background: #ffffff; padding: 36px 32px; color: ${BRAND.teal};">

              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.65; color: ${BRAND.teal};">
                Your spot in Circuit ${reg.circuit} is secured. Here's the receipt &mdash; keep this email handy until the schedule drops.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
                ${detailRows}
              </table>

              ${isTeam ? `
                <div style="font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: ${BRAND.teal}; opacity: 0.6; margin: 28px 0 12px; font-weight: 500;">Roster</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: rgba(13, 59, 64, 0.03); border-radius: 8px; padding: 16px 20px;">
                  ${rosterRows}
                </table>
              ` : ''}

              <div style="margin: 32px 0 0; padding: 20px; background: ${BRAND.teal}; border-radius: 8px; color: ${BRAND.cream};">
                <div style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 18px; color: ${BRAND.gold}; margin-bottom: 8px;">
                  What's next
                </div>
                <ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.7; color: ${BRAND.cream};">
                  ${isTeam
                    ? '<li>Players 2-4 will receive onboarding emails at the addresses on the roster.</li>'
                    : '<li>Captains will draft free agents before Circuit I begins.</li>'}
                  <li>The schedule drops before the Circuit starts &mdash; watch your inbox.</li>
                  <li>Questions? Reply to this email.</li>
                </ul>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: ${BRAND.cream}; border-radius: 0 0 12px 12px; padding: 24px 32px; text-align: center; font-size: 12px; color: ${BRAND.teal};">
              <div style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 14px; color: ${BRAND.teal}; margin-bottom: 8px;">
                The Dink Society
              </div>
              <div style="opacity: 0.7;">Southern California</div>
              <div style="margin-top: 10px;">
                <a href="https://instagram.com/dinksociety.pb" style="color: ${BRAND.teal}; text-decoration: none; font-weight: 500;">@dinksociety.pb</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Extract first name for greeting (handles "First Last" or "First") */
function firstName(full) {
  if (!full) return 'friend';
  return full.trim().split(/\s+/)[0];
}

/** Basic HTML escape for user-supplied values */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Format cents as USD string */
function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');
}

/** Crude HTML → text fallback for email clients that block HTML */
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Build a magic-link email for captains signing into the portal.
 * @param {string} magicUrl Full URL the captain clicks to sign in
 * @param {string} teamName The team they're signing in as
 */
export function renderCaptainMagicLink(magicUrl, teamName) {
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
            Captain sign-in
          </div>
          <h1 style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 36px; line-height: 1.1; font-weight: 500; margin: 0; color: ${BRAND.cream};">
            One-tap to ${esc(teamName)}.
          </h1>
        </td></tr>

        <tr><td style="background: #ffffff; padding: 32px; color: ${BRAND.teal}; text-align: left;">
          <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.65;">
            Tap the button below to sign in to the captain portal. This link is good for the next 15 minutes and can only be used once.
          </p>

          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0;">
            <tr><td align="center">
              <a href="${magicUrl}" style="display: inline-block; background: ${BRAND.gold}; color: ${BRAND.teal}; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 500; text-decoration: none;">
                Sign in to captain portal
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
            <strong style="font-weight: 500;">Didn't request this?</strong> Someone typed your email into the captain sign-in page. You can ignore this email &mdash; no action needed.
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
