import cronstrue from 'cronstrue/i18n';

/**
 * Format an ISO date string as a human-readable "next run" label.
 * Shows relative time for runs within 24h, absolute date otherwise.
 */
export function formatNextRun(isoString?: string, locale?: string): string {
  if (!isoString) return 'N/A';
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const diffMs = date.getTime() - now;

    const relative = new Intl.RelativeTimeFormat(locale ?? 'en', {
      numeric: 'always',
      style: 'short',
    });
    if (diffMs < 0) {
      return relative.format(Math.min(-1, Math.floor(diffMs / 60_000)), 'minute');
    }

    const hours = Math.floor(diffMs / 3600_000);
    const minutes = Math.floor((diffMs % 3600_000) / 60_000);

    if (hours > 24) {
      return date.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    if (hours > 0) {
      const remaining = minutes > 0
        ? ` ${new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(minutes)}`
        : '';
      return `${relative.format(hours, 'hour')}${remaining}`;
    }
    return relative.format(minutes, 'minute');
  } catch {
    return isoString;
  }
}

/**
 * Convert a cron expression to a human-readable description.
 */
export function getCronDescription(expression: string, locale = 'en'): string {
  try {
    return cronstrue.toString(expression, {
      locale: locale.split('-')[0],
      use24HourTimeFormat: true,
    });
  } catch {
    try {
      return cronstrue.toString(expression, { locale: 'en', use24HourTimeFormat: true });
    } catch {
      return expression;
    }
  }
}
