import type { TokenUsageActivityDayViewModel } from './tokenUsageViewModel';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivityCalendarDay {
  id: string;
  usage: TokenUsageActivityDayViewModel | null;
}

export interface ActivityHeatmapYear {
  year: string;
  days: ActivityCalendarDay[];
  cells: Array<ActivityCalendarDay | null>;
  weekCount: number;
}

/** Preserve the incoming UTC extent, including gaps, without inventing usage buckets. */
export function buildActivityHeatmapYears(
  days: readonly TokenUsageActivityDayViewModel[]
): ActivityHeatmapYear[] {
  const byId = new Map(
    days.filter((day) => Number.isFinite(dayTimestamp(day.id))).map((day) => [day.id, day])
  );
  const ids = [...byId.keys()].sort();
  if (ids.length === 0) return [];

  const byYear = new Map<string, ActivityCalendarDay[]>();
  const end = dayTimestamp(ids[ids.length - 1]);
  for (let timestamp = dayTimestamp(ids[0]); timestamp <= end; timestamp += DAY_MS) {
    const id = utcDayId(timestamp);
    const year = id.slice(0, 4);
    const yearDays = byYear.get(year) ?? [];
    yearDays.push({ id, usage: byId.get(id) ?? null });
    byYear.set(year, yearDays);
  }

  return [...byYear.entries()].map(([year, yearDays]) => {
    const mondayOffset = (new Date(dayTimestamp(yearDays[0].id)).getUTCDay() + 6) % 7;
    const cells: Array<ActivityCalendarDay | null> = [
      ...Array<ActivityCalendarDay | null>(mondayOffset).fill(null),
      ...yearDays,
    ];
    const weekCount = Math.ceil(cells.length / 7);
    cells.push(...Array<ActivityCalendarDay | null>(weekCount * 7 - cells.length).fill(null));
    return { year, days: yearDays, cells, weekCount };
  });
}

export function utcDayId(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function buildActivityStreak(
  days: readonly TokenUsageActivityDayViewModel[],
  now = Date.now()
): number {
  const activeDayIds = new Set(days.filter((day) => day.tokenValue > 0).map((day) => day.id));
  let timestamp = dayTimestamp(utcDayId(now));
  if (!activeDayIds.has(utcDayId(timestamp))) timestamp -= DAY_MS;

  let streak = 0;
  for (; ; timestamp -= DAY_MS) {
    if (!activeDayIds.has(utcDayId(timestamp))) return streak;
    streak += 1;
  }
}

function dayTimestamp(id: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return NaN;
  const timestamp = Date.parse(`${id}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && utcDayId(timestamp) === id ? timestamp : NaN;
}
