import cronstrue from 'cronstrue/i18n';

/**
 * Format an ISO date string as a human-readable "next run" label.
 * Shows relative time for runs within 24h, absolute date otherwise.
 */
export function formatNextRun(isoString?: string): string {
  if (!isoString) return 'N/A';
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const diffMs = date.getTime() - now;

    if (diffMs < 0) return 'overdue';

    const hours = Math.floor(diffMs / 3600_000);
    const minutes = Math.floor((diffMs % 3600_000) / 60_000);

    if (hours > 24) {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    if (minutes > 0) return `in ${minutes}m`;
    return 'soon';
  } catch {
    return isoString;
  }
}

/**
 * Convert a cron expression to a human-readable description.
 */
export function getCronDescription(expression: string): string {
  try {
    return cronstrue.toString(expression, { locale: 'en', use24HourTimeFormat: true });
  } catch {
    return expression;
  }
}
