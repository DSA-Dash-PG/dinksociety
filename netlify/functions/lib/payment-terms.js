// netlify/functions/lib/payment-terms.js
// Shared registration payment terms: deposit amount, balance-due date, and the
// Venmo handle teams can pay the deposit to. Used by register-checkout (what we
// charge / ask for), public-seasons (what the registration page shows) and the
// admin confirm flow (what to record when a Venmo deposit lands).

import { getStore } from '@netlify/blobs';

// Deposit that holds a team's spot; the balance is due one week before the
// season starts. Admin → Seasons can override both per season.
export const DEFAULT_DEPOSIT = 250;

// Fallback fees, used only when a division has no price set. The live
// numbers are the division's teamPrice / agentPrice in Admin → Seasons.
export const DEFAULT_TEAM_FEE = 700;
export const DEFAULT_AGENT_FEE = 125;

// Card (Stripe) checkout is OFF unless CARD_PAYMENTS_ENABLED is set to "true"
// in the Netlify environment. Venmo is the live payment path; flipping the env
// var brings the card tile back on the registration page with no code change.
export const CARD_PAYMENTS_ENABLED =
  String(process.env.CARD_PAYMENTS_ENABLED || '').toLowerCase() === 'true';

// Venmo handle for deposits. Override with the VENMO_HANDLE env var if it changes.
export const VENMO_HANDLE = String(process.env.VENMO_HANDLE || 'dink-society').replace(/^@/, '');

// Universal link — opens the Venmo app on phones, the profile on desktop.
export function venmoProfileUrl(handle = VENMO_HANDLE) {
  return `https://venmo.com/u/${encodeURIComponent(String(handle).replace(/^@/, ''))}`;
}

// YYYY-MM-DD one week before the given YYYY-MM-DD start date.
export function defaultBalanceDueDate(startDate) {
  if (!startDate) return null;
  const d = new Date(String(startDate).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

export function fmtDueDate(ymd) {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00');
  return isNaN(d.getTime())
    ? String(ymd)
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Resolve { depositAmount, balanceDueDate } for a season.
 * Season blob is authoritative; circuit-settings is the legacy fallback.
 * A missing balance-due date defaults to one week before the season start.
 * depositAmount of 0 means "pay in full at registration".
 */
export async function resolveDepositTerms(season) {
  let depositAmount = DEFAULT_DEPOSIT;
  let balanceDueDate = null;
  let startDate = season?.startDate || null;

  if (season && season.depositAmount != null) {
    depositAmount = Number(season.depositAmount);
    balanceDueDate = season.balanceDueDate || null;
  } else {
    try {
      const configStore = getStore({ name: 'config', consistency: 'strong' });
      const cfgRaw = await configStore.get('circuit-settings');
      if (cfgRaw) {
        const cfg = JSON.parse(cfgRaw);
        if (cfg.depositAmount != null) depositAmount = Number(cfg.depositAmount);
        if (cfg.balanceDueDate) balanceDueDate = cfg.balanceDueDate;
        if (!startDate && cfg.startDate) startDate = cfg.startDate;
      }
    } catch (e) {
      console.warn('Could not load circuit-settings for deposit; using defaults:', e.message);
    }
  }

  if (!Number.isFinite(depositAmount) || depositAmount < 0) depositAmount = DEFAULT_DEPOSIT;
  if (!balanceDueDate) balanceDueDate = defaultBalanceDueDate(startDate);
  return { depositAmount, balanceDueDate };
}
