// Expiration detection for stale internship listings

export type ExpirationReason = 'over-6-months' | 'posted-last-year' | 'no-date' | 'fresh';

export interface ExpirationStatus {
  isExpired: boolean;
  reason: ExpirationReason;
  expiresAt: number; // epoch ms of calculated expiration
  warningThreshold: boolean; // true if close to expiration but not expired yet
}

export function detectExpiration(
  dateMs: number,
  currentDateMs: number = Date.now()
): ExpirationStatus {
  // No date information
  if (dateMs === 0) {
    return {
      isExpired: false,
      reason: 'no-date',
      expiresAt: 0,
      warningThreshold: false,
    };
  }

  const ageMs = currentDateMs - dateMs;
  const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;

  // Get year of posting and current year
  const postDate = new Date(dateMs);
  const currentDate = new Date(currentDateMs);
  const postYear = postDate.getFullYear();
  const currentYear = currentDate.getFullYear();

  // Check if posted in a previous year
  if (postYear < currentYear) {
    const expiresAt = new Date(postYear + 1, postDate.getMonth(), postDate.getDate());
    return {
      isExpired: true,
      reason: 'posted-last-year',
      expiresAt: expiresAt.getTime(),
      warningThreshold: false,
    };
  }

  // Check if over 6 months old (typical internship window closes ~5 months after posting)
  if (ageMs > sixMonthsMs) {
    const expiresAt = dateMs + sixMonthsMs;
    return {
      isExpired: true,
      reason: 'over-6-months',
      expiresAt,
      warningThreshold: false,
    };
  }

  // Check if approaching 6 months (warning threshold at 5.5 months)
  const fiveAndHalfMonthsMs = 5.5 * 30 * 24 * 60 * 60 * 1000;
  const warningThreshold = ageMs > fiveAndHalfMonthsMs;

  return {
    isExpired: false,
    reason: 'fresh',
    expiresAt: dateMs + sixMonthsMs,
    warningThreshold,
  };
}

export function getExpirationBadge(reason: ExpirationReason): string {
  switch (reason) {
    case 'posted-last-year':
      return '📅 Last Year';
    case 'over-6-months':
      return '⏰ Over 6mo';
    case 'no-date':
      return '❓ Unknown Date';
    case 'fresh':
    default:
      return '';
  }
}

export function isExpiredOrOld(
  dateMs: number,
  includeWarning: boolean = false,
  currentDateMs: number = Date.now()
): boolean {
  const status = detectExpiration(dateMs, currentDateMs);
  return includeWarning ? status.isExpired || status.warningThreshold : status.isExpired;
}
