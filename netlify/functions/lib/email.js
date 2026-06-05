// netlify/functions/lib/email.js
// Shared email helpers — uses Resend for transactional email.

import { Resend } from 'resend';

let resend;

function getResend() {
  if (!resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY not set');
    resend = new Resend(key);
  }
  return resend;
}

/**
 * Send a transactional email via Resend.
 * @param {{ to: string, subject: string, html: string, replyTo?: string }} opts
 */
export async function sendEmail({ to, subject, html, replyTo }) {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    console.warn('EMAIL_FROM missing — skipping email send');
    return null;
  }

  const r = getResend();
  const payload = {
    from,
    to,
    subject,
    html,
  };

  if (replyTo || process.env.EMAIL_REPLY_TO) {
    payload.reply_to = replyTo || process.env.EMAIL_REPLY_TO;
  }

  if (process.env.EMAIL_ADMIN_BCC) {
    payload.bcc = process.env.EMAIL_ADMIN_BCC;
  }

  const result = await r.emails.send(payload);
  return result;
}

/**
 * Escape HTML and convert newlines to <br> for plain-text message bodies.
 */
function escapeBody(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\n/g, '<br>');
}

/**
 * Render an admin → captain announcement / message email.
 * @param {{ subject?: string, body: string, teamName: string, portalUrl: string }} opts
 */
export function renderAdminMessage({ subject, body, teamName, portalUrl }) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">THE DINK SOCIETY</div>
      ${subject ? `<h1 style="font-size: 22px; font-weight: 800; color: #f5f5f5; margin: 0 0 16px;">${escapeBody(subject)}</h1>` : ''}
      <div style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 24px;">${escapeBody(body)}</div>
      <a href="${portalUrl}" style="display: inline-block; padding: 14px 32px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Open captain portal
      </a>
      <p style="font-size: 13px; color: #777; margin-top: 24px; line-height: 1.5;">
        Reply to this message right inside the portal — that's the fastest way to reach the league.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        Sent to ${escapeBody(teamName)} · The Dink Society · Southern California Pickleball League
      </div>
    </div>
  `;
}

/**
 * Render a captain → admin notification email (admin gets pinged when a
 * captain sends a message in the portal).
 */
export function renderCaptainMessageNotify({ teamName, captainName, body, adminUrl }) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 24px;">THE DINK SOCIETY · ADMIN</div>
      <h1 style="font-size: 20px; font-weight: 800; color: #f5f5f5; margin: 0 0 6px;">New message from ${escapeBody(teamName)}</h1>
      <p style="font-size: 13px; color: #8a8a8a; margin: 0 0 20px;">${escapeBody(captainName || 'Captain')}</p>
      <div style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 24px; padding: 16px; background: #161616; border-radius: 8px;">${escapeBody(body)}</div>
      <a href="${adminUrl}" style="display: inline-block; padding: 12px 28px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Reply in admin portal
      </a>
    </div>
  `;
}

/**
 * Render a team-chat notification email. Sent to a teammate when another
 * player posts in their team's group chat.
 * @param {{ teamName:string, authorName:string, body:string, portalUrl:string }} opts
 */
export function renderTeamChatNotify({ teamName, authorName, body, portalUrl }) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 24px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 20px; font-weight: 800; color: #f5f5f5; margin: 0 0 6px;">New message in ${escapeBody(teamName)} chat</h1>
      <p style="font-size: 13px; color: #8a8a8a; margin: 0 0 20px;">${escapeBody(authorName || 'A teammate')}</p>
      <div style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 24px; padding: 16px; background: #161616; border-radius: 8px;">${escapeBody(body)}</div>
      <a href="${portalUrl}" style="display: inline-block; padding: 12px 28px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Open team chat
      </a>
      <p style="font-size: 13px; color: #777; margin-top: 24px; line-height: 1.5;">
        Only your teammates can see this conversation. Reply in your player portal.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        Sent to ${escapeBody(teamName)} · The Dink Society · Southern California Pickleball League
      </div>
    </div>
  `;
}

/**
 * Render the PLAYER magic-link sign-in email.
 * @param {string} magicUrl - The full magic link URL
 * @param {string} playerName - The player's name
 * @returns {string} HTML email body
 */
export function renderPlayerMagicLink(magicUrl, playerName) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 24px; font-weight: 800; text-transform: uppercase; color: #f5f5f5; margin: 0 0 12px;">Player Sign-In</h1>
      <p style="font-size: 15px; color: #8a8a8a; line-height: 1.6; margin: 0 0 8px;">
        Tap below to open your player portal${playerName ? ' — see your schedule, stats, and the leaderboard:' : ':'}
      </p>
      ${playerName ? `<p style="font-size: 18px; font-weight: 700; color: #b8ff2c; margin: 0 0 28px;">${playerName}</p>` : '<div style="height:16px"></div>'}
      <a href="${magicUrl}" style="display: inline-block; padding: 14px 32px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Open my portal
      </a>
      <p style="font-size: 13px; color: #555; margin-top: 28px; line-height: 1.5;">
        This link expires in 15 minutes and can only be used once. If you didn't request it, you can safely ignore this email.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        The Dink Society · Southern California Pickleball League
      </div>
    </div>
  `;
}

/**
 * Render the captain magic-link sign-in email — Night-Match design system.
 * @param {string} magicUrl - The full magic link URL
 * @param {string} teamName - The captain's team name
 * @returns {string} HTML email body
 */
export function renderCaptainMagicLink(magicUrl, teamName) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 24px; font-weight: 800; text-transform: uppercase; color: #f5f5f5; margin: 0 0 12px;">Captain Sign-In</h1>
      <p style="font-size: 15px; color: #8a8a8a; line-height: 1.6; margin: 0 0 8px;">
        Tap the button below to access the captain portal for:
      </p>
      <p style="font-size: 18px; font-weight: 700; color: #b8ff2c; margin: 0 0 28px;">${teamName}</p>
      <a href="${magicUrl}" style="display: inline-block; padding: 14px 32px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Sign in as Captain
      </a>
      <p style="font-size: 13px; color: #555; margin-top: 28px; line-height: 1.5;">
        This link expires in 15 minutes and can only be used once. If you didn't request it, you can safely ignore this email.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        The Dink Society · Southern California Pickleball League
      </div>
    </div>
  `;
}
