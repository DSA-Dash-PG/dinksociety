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
 * @param {{ to: string, subject: string, html: string, replyTo?: string,
 *           attachments?: Array<{ filename: string, path?: string, content?: string }> }} opts
 *   attachments use Resend's shape: `path` (a hosted URL Resend fetches) or
 *   `content` (base64). We use `path` pointing at broadcast-files-serve.
 */
export async function sendEmail({ to, subject, html, replyTo, attachments }) {
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

  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments;
  }

  const result = await r.emails.send(payload);
  // Resend reports failures in the response body, NOT by throwing. If we don't
  // check this, a rejected send (unverified from-address, rate limit, test-mode,
  // bad recipient) looks exactly like success and callers over-count "sent".
  if (result && result.error) {
    const e = result.error;
    throw new Error(`Resend rejected send to ${Array.isArray(to) ? to.join(',') : to}: ${e.message || e.name || JSON.stringify(e)}`);
  }
  return result;
}

/**
 * Strip a sanitized rich-text body down to readable plain text. Used for
 * inbox previews and as a fallback when no HTML body is stored.
 */
export function htmlToPlain(html) {
  return String(html || '')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The message rich-text allowlist is identical to the waiver one — reuse it so
// admin-authored broadcast markup is rendered safely in emails and portals.
export const messageLooksHtml = waiverLooksHtml;
export const sanitizeMessageHtml = sanitizeWaiverHtml;

// Default email-appearance template. Admin overrides live in circuit-settings
// under `emailTemplate`; renderAdminMessage merges them over these.
export const EMAIL_TEMPLATE_DEFAULTS = {
  accentColor: '#b8ff2c',
  headerText: 'THE DINK SOCIETY',
  buttonLabel: 'Open captain portal',
  footerText: 'The Dink Society · Southern California Pickleball League',
  logoUrl: '', // optional absolute image URL; falls back to headerText wordmark
};

/** Merge admin overrides over the defaults, ignoring blank fields. */
export function resolveEmailTemplate(override) {
  const o = override || {};
  const pick = (k) => (typeof o[k] === 'string' && o[k].trim()) ? o[k].trim() : EMAIL_TEMPLATE_DEFAULTS[k];
  return {
    accentColor: /^#[0-9a-fA-F]{3,8}$/.test((o.accentColor || '').trim()) ? o.accentColor.trim() : EMAIL_TEMPLATE_DEFAULTS.accentColor,
    headerText: pick('headerText'),
    buttonLabel: pick('buttonLabel'),
    footerText: pick('footerText'),
    logoUrl: /^https?:\/\//i.test((o.logoUrl || '').trim()) ? o.logoUrl.trim() : '',
  };
}

/**
 * Escape HTML and convert newlines to <br> for plain-text message bodies.
 */
function escapeBody(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\n/g, '<br>');
}

// ── Rich-text waiver rendering (shared; keep in sync with public/admin.html
//    and public/me.html copies of these two functions) ──────────────────
// Waiver text may be HTML (from the admin rich-text editor) or legacy plain
// text. `waiverLooksHtml` tells them apart; `sanitizeWaiverHtml` strips
// everything outside a tiny allowlist so admin-authored markup is safe to
// inject into the emailed copy.
const WAIVER_ALLOWED = { b: 1, strong: 1, i: 1, em: 1, u: 1, p: 1, br: 1, h2: 1, h3: 1, h4: 1, ul: 1, ol: 1, li: 1, a: 1, div: 1 };

export function waiverLooksHtml(s) {
  return /<(\/?)(b|strong|i|em|u|p|br|h[1-6]|ul|ol|li|a|div)\b/i.test(String(s || ''));
}

export function sanitizeWaiverHtml(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (m, slash, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!WAIVER_ALLOWED[tag]) return '';          // disallowed tag → drop, keep inner text
    if (slash) return '</' + tag + '>';
    if (tag === 'br') return '<br>';
    if (tag === 'a') {
      const hm = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = hm ? (hm[2] || hm[3] || hm[4] || '') : '';
      if (!/^https?:\/\//i.test(href)) return '<a>';   // strip javascript:/relative/etc.
      return '<a href="' + href.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">';
    }
    return '<' + tag + '>';                        // allowed tag, all attributes stripped
  });
  return s;
}

/**
 * Render an admin → captain announcement / message email.
 *
 * Accepts EITHER a rich `bodyHtml` (already sanitized) or a plain `body`.
 * `template` overrides the league email appearance (accent color, header text,
 * button label, footer, logo). `attachments` are rendered as a download list
 * (the files are also attached to the email itself).
 *
 * @param {{ subject?:string, bodyHtml?:string, body?:string, teamName?:string,
 *           portalUrl:string, template?:object,
 *           attachments?:Array<{filename,url,size}> }} opts
 */
export function renderAdminMessage({ subject, bodyHtml, body, teamName, portalUrl, template, attachments }) {
  const t = resolveEmailTemplate(template);
  const accent = t.accentColor;

  const header = t.logoUrl
    ? `<img src="${t.logoUrl}" alt="${escapeBody(t.headerText)}" style="max-height: 40px; margin-bottom: 28px; display: block;">`
    : `<div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">${escapeBody(t.headerText)}</div>`;

  const bodyBlock = (typeof bodyHtml === 'string' && bodyHtml.trim())
    ? `<div style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 24px;">${sanitizeMessageHtml(bodyHtml)}</div>`
    : `<div style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 24px;">${escapeBody(body)}</div>`;

  const atts = Array.isArray(attachments) ? attachments.filter(a => a && a.filename) : [];
  const attBlock = atts.length ? `
      <div style="margin: 0 0 24px; padding: 14px 16px; background: #161616; border-radius: 8px;">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #8a8a8a; margin-bottom: 8px;">Attachments</div>
        ${atts.map(a => `<div style="font-size: 14px; margin: 4px 0;">📎 ${a.url ? `<a href="${a.url}" style="color: ${accent}; text-decoration: none;">${escapeBody(a.filename)}</a>` : escapeBody(a.filename)}${a.size ? ` <span style="color:#666;font-size:12px;">(${fmtSize(a.size)})</span>` : ''}</div>`).join('')}
      </div>` : '';

  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      ${header}
      ${subject ? `<h1 style="font-size: 22px; font-weight: 800; color: #f5f5f5; margin: 0 0 16px;">${escapeBody(subject)}</h1>` : ''}
      ${bodyBlock}
      ${attBlock}
      <a href="${portalUrl}" style="display: inline-block; padding: 14px 32px; background: ${accent}; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        ${escapeBody(t.buttonLabel)}
      </a>
      <p style="font-size: 13px; color: #777; margin-top: 24px; line-height: 1.5;">
        Reply to this message right inside the portal — that's the fastest way to reach the league.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        ${teamName ? `Sent to ${escapeBody(teamName)} · ` : ''}${escapeBody(t.footerText)}
      </div>
    </div>
  `;
}

/** Human-readable file size for attachment lists. */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
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
 * Render the player-availability notification — sent to the captain + co-captains
 * when a player marks themselves out (or back in) for an upcoming match.
 * @param {{ playerName:string, status:'out'|'in', teamName:string, teamEmoji?:string,
 *           opponentName:string, oppEmoji?:string, week:(number|string),
 *           dateLine?:string, reason?:string, portalUrl:string }} opts
 */
export function renderAvailabilityNotify({ playerName, status, teamName, teamEmoji, opponentName, oppEmoji, week, dateLine, reason, portalUrl }) {
  const accent = '#b8ff2c';
  const out = status === 'out';
  const h1 = out ? `${escapeBody(playerName)} is out for Week ${escapeBody(String(week))}`
                 : `${escapeBody(playerName)} is back in for Week ${escapeBody(String(week))}`;
  const lead = out
    ? `<b>${escapeBody(playerName)}</b> just marked themselves <b>unavailable</b> for your upcoming match. They won't show up in your lineup picker for this game.`
    : `<b>${escapeBody(playerName)}</b> is <b>available again</b> for your upcoming match — they're back in your lineup picker.`;

  const matchCard = `
      <div style="background: #161616; border-radius: 8px; padding: 14px 16px; margin: 0 0 18px;">
        <div style="font-size: 14px; font-weight: 700; color: #f5f5f5;">
          ${teamEmoji ? escapeBody(teamEmoji) + ' ' : ''}${escapeBody(teamName)}
          <span style="color:#666;font-weight:700;margin:0 6px;">vs</span>
          ${oppEmoji ? escapeBody(oppEmoji) + ' ' : ''}${escapeBody(opponentName)}
        </div>
        ${dateLine ? `<div style="font-size: 12px; color: #8a8a8a; margin-top: 9px; padding-top: 9px; border-top: 1px solid #2a2a2a;">${escapeBody(dateLine)}</div>` : ''}
      </div>`;

  const reasonBlock = (out && reason)
    ? `<div style="font-size: 14px; color: #cfcfcf; line-height: 1.6; margin: 0 0 18px; padding: 12px 14px; background: #161616; border-left: 3px solid #ff5c47; border-radius: 6px;">
         <span style="color:#8a8a8a;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;display:block;margin-bottom:4px;">Their note</span>${escapeBody(reason)}</div>`
    : '';

  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 28px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 22px; font-weight: 800; color: #f5f5f5; margin: 0 0 14px; line-height: 1.25;">${h1}</h1>
      <p style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 18px;">${lead}</p>
      ${matchCard}
      ${reasonBlock}
      <p style="font-size: 15px; color: #cfcfcf; line-height: 1.65; margin: 0 0 18px;">${out ? 'Set or adjust your lineup so you’re covered:' : 'Review your lineup if you want to use them:'}</p>
      <a href="${portalUrl}" style="display: inline-block; padding: 14px 32px; background: ${accent}; color: #0e0e0e; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 9999px;">
        Set your lineup
      </a>
      <p style="font-size: 13px; color: #777; margin-top: 22px; line-height: 1.5;">
        Heads-up only — you don't have to reply. You can also mark players in or out yourself from the lineup builder.
      </p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        ${teamName ? 'Sent to ' + escapeBody(teamName) + ' · ' : ''}The Dink Society · Southern California Pickleball League
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

/**
 * Render a copy of the liability waiver, emailed to the player for their
 * own records.
 */
export function renderWaiverCopy({ title, text, playerName, signedName, signedAt }) {
  const when = signedAt ? new Date(signedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) : null;
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 24px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 22px; font-weight: 800; color: #f5f5f5; margin: 0 0 6px;">${escapeBody(title || 'Liability Waiver & Release')}</h1>
      <p style="font-size: 13px; color: #8a8a8a; margin: 0 0 20px;">Your copy${playerName ? ', ' + escapeBody(playerName) : ''} — keep this for your records.</p>
      ${signedName ? `<div style="font-size: 13px; color: #b8ff2c; margin: 0 0 18px; padding: 12px 14px; background: #161616; border-radius: 8px;">Signed by <b>${escapeBody(signedName)}</b>${when ? ' · ' + escapeBody(when) : ''}</div>` : ''}
      ${waiverLooksHtml(text)
        ? `<div style="font-size: 14px; color: #cfcfcf; line-height: 1.65; word-break: break-word;">${sanitizeWaiverHtml(text)}</div>`
        : `<div style="font-size: 14px; color: #cfcfcf; line-height: 1.65; white-space: pre-wrap; word-break: break-word;">${escapeBody(text || '')}</div>`}
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        The Dink Society · Southern California Pickleball League
      </div>
    </div>
  `;
}
