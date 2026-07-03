import type { TokenUsageSnapshotRequest } from '../../contracts';

export type TokenUsageDateRangePresetId =
  | 'all-time'
  | 'today'
  | 'this-week'
  | 'this-month'
  | 'this-quarter'
  | 'this-year'
  | 'last-week'
  | 'last-month'
  | 'last-7-days'
  | 'last-30-days'
  | 'custom';

export interface TokenUsageDateRangePreset {
  id: TokenUsageDateRangePresetId;
  label: string;
  default?: boolean;
}

export interface TokenUsageDateRangeValue {
  presetId: TokenUsageDateRangePresetId;
  label: string;
  detail: string;
  from?: string;
  to?: string;
  fromDateKey?: string;
  toDateKey?: string;
}

export const TOKEN_USAGE_DATE_RANGE_PRESETS: TokenUsageDateRangePreset[] = [
  { id: 'all-time', label: 'All time', default: true },
  { id: 'today', label: 'Today' },
  { id: 'this-week', label: 'This week' },
  { id: 'this-month', label: 'This month' },
  { id: 'this-quarter', label: 'This quarter' },
  { id: 'this-year', label: 'This year' },
  { id: 'last-week', label: 'Last week' },
  { id: 'last-month', label: 'Last month' },
  { id: 'last-7-days', label: 'Last 7 days' },
  { id: 'last-30-days', label: 'Last 30 days' },
];

export function createDefaultTokenUsageDateRange(now = new Date()): TokenUsageDateRangeValue {
  return createPresetTokenUsageDateRange('all-time', now);
}

export function createPresetTokenUsageDateRange(
  presetId: TokenUsageDateRangePresetId,
  now = new Date()
): TokenUsageDateRangeValue {
  if (presetId === 'all-time') {
    return {
      presetId,
      label: 'All time',
      detail: 'All collected app usage',
    };
  }

  const today = startOfLocalDay(now);
  let from = today;
  let to = endOfLocalDay(today);
  const label = TOKEN_USAGE_DATE_RANGE_PRESETS.find((preset) => preset.id === presetId)?.label;

  if (presetId === 'this-week') {
    from = startOfLocalWeek(today);
    to = endOfLocalDay(addLocalDays(from, 6));
  } else if (presetId === 'this-month') {
    from = startOfLocalMonth(today);
    to = endOfLocalMonth(today);
  } else if (presetId === 'this-quarter') {
    from = startOfLocalQuarter(today);
    to = endOfLocalQuarter(today);
  } else if (presetId === 'this-year') {
    from = new Date(today.getFullYear(), 0, 1);
    to = endOfLocalDay(new Date(today.getFullYear(), 11, 31));
  } else if (presetId === 'last-week') {
    to = endOfLocalDay(addLocalDays(startOfLocalWeek(today), -1));
    from = startOfLocalWeek(to);
  } else if (presetId === 'last-month') {
    const previousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    from = startOfLocalMonth(previousMonth);
    to = endOfLocalMonth(previousMonth);
  } else if (presetId === 'last-7-days') {
    from = startOfLocalDay(addLocalDays(today, -6));
  } else if (presetId === 'last-30-days') {
    from = startOfLocalDay(addLocalDays(today, -29));
  }

  return buildDateRangeValue({
    presetId,
    label: label ?? 'Custom',
    from,
    to,
  });
}

export function createCustomTokenUsageDateRange(
  fromDateKey: string,
  toDateKey: string
): TokenUsageDateRangeValue {
  const [fromKey, toKey] =
    fromDateKey <= toDateKey ? [fromDateKey, toDateKey] : [toDateKey, fromDateKey];
  return buildDateRangeValue({
    presetId: 'custom',
    label: 'Custom range',
    from: parseLocalDateKey(fromKey),
    to: endOfLocalDay(parseLocalDateKey(toKey)),
  });
}

export function tokenUsageSnapshotRequestForDateRange(
  range: TokenUsageDateRangeValue
): TokenUsageSnapshotRequest | undefined {
  if (!range.from || !range.to) return undefined;
  return {
    from: range.from,
    to: range.to,
  };
}

export function dateRangeVisibleMonth(range: TokenUsageDateRangeValue, now = new Date()): Date {
  return startOfLocalMonth(range.fromDateKey ? parseLocalDateKey(range.fromDateKey) : now);
}

export function tokenUsageDateRangeToCalendarRange(
  range: TokenUsageDateRangeValue
): { from: Date | undefined; to?: Date } | undefined {
  if (!range.fromDateKey && !range.toDateKey) return undefined;
  return {
    from: range.fromDateKey ? parseLocalDateKey(range.fromDateKey) : undefined,
    to: range.toDateKey ? parseLocalDateKey(range.toDateKey) : undefined,
  };
}

export function tokenUsageDateKeyFromDate(date: Date): string {
  return localDateKey(date);
}

function buildDateRangeValue(input: {
  presetId: TokenUsageDateRangePresetId;
  label: string;
  from: Date;
  to: Date;
}): TokenUsageDateRangeValue {
  const from = startOfLocalDay(input.from);
  const to = endOfLocalDay(input.to);
  const fromDateKey = localDateKey(from);
  const toDateKey = localDateKey(to);
  return {
    presetId: input.presetId,
    label: input.label,
    detail: formatDateRangeDetail(from, to),
    from: from.toISOString(),
    to: to.toISOString(),
    fromDateKey,
    toDateKey,
  };
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfLocalWeek(date: Date): Date {
  const mondayOffset = (date.getDay() + 6) % 7;
  return startOfLocalDay(addLocalDays(date, -mondayOffset));
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfLocalMonth(date: Date): Date {
  return endOfLocalDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

function startOfLocalQuarter(date: Date): Date {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
}

function endOfLocalQuarter(date: Date): Date {
  const start = startOfLocalQuarter(date);
  return endOfLocalDay(new Date(start.getFullYear(), start.getMonth() + 3, 0));
}

function localDateKey(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseLocalDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function formatDateRangeDetail(from: Date, to: Date): string {
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  if (localDateKey(from) === localDateKey(to)) return format.format(from);
  return `${format.format(from)} - ${format.format(to)}`;
}
