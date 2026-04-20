import type { CodexRateLimitSnapshotDto } from '../contracts';

export function normalizeCodexResetTimestamp(resetAt: number | null | undefined): number | null {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) {
    return null;
  }

  return resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt;
}

export function formatCodexWindowDuration(
  windowDurationMins: number | null | undefined
): string | null {
  if (
    typeof windowDurationMins !== 'number' ||
    !Number.isFinite(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return null;
  }

  if (windowDurationMins % 10_080 === 0) {
    return `${windowDurationMins / 10_080}w`;
  }

  if (windowDurationMins % 1_440 === 0) {
    return `${windowDurationMins / 1_440}d`;
  }

  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }

  return `${windowDurationMins}m`;
}

export function formatCodexWindowDurationLong(
  windowDurationMins: number | null | undefined
): string | null {
  if (
    typeof windowDurationMins !== 'number' ||
    !Number.isFinite(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return null;
  }

  if (windowDurationMins % 10_080 === 0) {
    const weeks = windowDurationMins / 10_080;
    return weeks === 1 ? '7-day' : `${weeks}-week`;
  }

  if (windowDurationMins % 1_440 === 0) {
    const days = windowDurationMins / 1_440;
    return days === 1 ? '1-day' : `${days}-day`;
  }

  if (windowDurationMins % 60 === 0) {
    const hours = windowDurationMins / 60;
    return hours === 1 ? '1-hour' : `${hours}-hour`;
  }

  return `${windowDurationMins}-minute`;
}

export function formatCodexUsageWindowLabel(
  title: 'Primary used' | 'Secondary used' | 'Weekly used',
  windowDurationMins: number | null | undefined
): string {
  const duration = formatCodexWindowDuration(windowDurationMins);
  return duration ? `${title} (${duration})` : title;
}

export function formatCodexResetWindowLabel(
  title: 'Primary reset' | 'Secondary reset' | 'Weekly reset',
  windowDurationMins: number | null | undefined
): string {
  const duration = formatCodexWindowDuration(windowDurationMins);
  return duration ? `${title} (${duration})` : title;
}

export function formatCodexUsagePercent(usedPercent: number | null | undefined): string {
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent)
    ? `${usedPercent}%`
    : 'Unknown';
}

export function formatCodexRemainingPercent(usedPercent: number | null | undefined): string | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    return null;
  }

  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  return `${remaining}%`;
}

export function formatCodexUsageExplanation(
  usedPercent: number | null | undefined,
  windowDurationMins: number | null | undefined
): string {
  const windowLabel = formatCodexWindowDurationLong(windowDurationMins);
  const remaining = formatCodexRemainingPercent(usedPercent);

  if (windowLabel && remaining) {
    return `${formatCodexUsagePercent(usedPercent)} used - about ${remaining} left in the current ${windowLabel} window.`;
  }

  if (windowLabel) {
    return `Shows used quota in the current ${windowLabel} window, not remaining quota.`;
  }

  return 'Shows used quota, not remaining quota.';
}

export function formatCodexCreditsValue(credits: CodexRateLimitSnapshotDto['credits']): string {
  if (!credits) {
    return 'Unknown';
  }

  if (credits.unlimited) {
    return 'Unlimited';
  }

  if (!credits.hasCredits) {
    return 'Not available';
  }

  return credits.balance ?? 'Unknown';
}
