import type { GlobalTask } from '@shared/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const exactDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function getRelativeTimeFormatter(
  locale: string | undefined,
  numeric: Intl.RelativeTimeFormatNumeric
): Intl.RelativeTimeFormat {
  const key = `${locale ?? ''}:${numeric}`;
  const cached = relativeTimeFormatters.get(key);
  if (cached) return cached;

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric, style: 'short' });
  relativeTimeFormatters.set(key, formatter);
  return formatter;
}

export function formatTaskUpdatedRelativeTime(
  updated: Date,
  locale: string | undefined,
  nowMs: number
): string {
  const elapsedMs = Math.max(0, nowMs - updated.getTime());
  const formatter = getRelativeTimeFormatter(locale, elapsedMs < MINUTE_MS ? 'auto' : 'always');

  if (elapsedMs < MINUTE_MS) return formatter.format(0, 'second');
  if (elapsedMs < HOUR_MS) return formatter.format(-Math.floor(elapsedMs / MINUTE_MS), 'minute');
  if (elapsedMs < DAY_MS) return formatter.format(-Math.floor(elapsedMs / HOUR_MS), 'hour');
  return formatter.format(-Math.floor(elapsedMs / DAY_MS), 'day');
}

export function formatExactTaskDateTime(date: Date, locale: string | undefined): string {
  const key = locale ?? '';
  let formatter = exactDateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
    exactDateTimeFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

export function getMeaningfulTaskUpdatedAt(
  task: Pick<GlobalTask, 'createdAt' | 'updatedAt'>
): Date | null {
  if (!task.updatedAt) return null;
  const updated = new Date(task.updatedAt);
  if (Number.isNaN(updated.getTime())) return null;

  if (task.createdAt) {
    const created = new Date(task.createdAt);
    if (
      !Number.isNaN(created.getTime()) &&
      Math.abs(updated.getTime() - created.getTime()) < MINUTE_MS
    ) {
      return null;
    }
  }

  return updated;
}
