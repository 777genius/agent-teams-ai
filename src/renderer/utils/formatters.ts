/**
 * Formatting utility functions for display values.
 */

// Re-export token formatting from shared module
export { formatTokensCompact } from '@shared/utils/tokenFormatting';

/**
 * Formats a byte count to a human-readable string (e.g. "1.2 MB").
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats an ISO timestamp into a relative time string (e.g. "just now", "5m ago", "2h ago").
 */
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

/**
 * Formats duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats a number in compact notation for UI display.
 * 42 → "42", 1200 → "1.2k", 45300 → "45.3k", 120000 → "120k", 1500000 → "1.5M"
 */
export function formatCompactNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}
