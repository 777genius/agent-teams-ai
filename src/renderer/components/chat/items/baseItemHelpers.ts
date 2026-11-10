/**
 * Helper functions for BaseItem component.
 * Extracted to a separate file to comply with react-refresh/only-export-components.
 */

import { formatTokens } from '@shared/utils/tokenFormatting';

import type { ItemStatus } from './BaseItem';

// Re-export for backwards compatibility
export { formatTokens };

/**
 * Formats duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '...';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Truncates text to a maximum length with ellipsis.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Get background color for status dot.
 * Returns CSS value (hex for semantic colors, CSS variable for neutral).
 */
export function getStatusDotColor(status: ItemStatus): string {
  const colors: Record<ItemStatus, string> = {
    ok: '#22c55e', // green-500 - semantic success
    error: '#ef4444', // red-500 - semantic error
    pending: '#eab308', // yellow-500 - semantic pending
    orphaned: 'var(--tool-item-muted)', // theme-aware neutral
  };
  return colors[status];
}
