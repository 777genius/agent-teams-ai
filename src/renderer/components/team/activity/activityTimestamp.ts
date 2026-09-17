import { encodeCacheParts, getCachedString } from './activityRenderCache';

const activityTimestampCache = new Map<string, string>();

function getLocalDayCacheKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatActivityTimestamp(timestamp: string): string {
  const now = new Date();
  return getCachedString(
    activityTimestampCache,
    encodeCacheParts([timestamp, getLocalDayCacheKey(now)]),
    () => {
      const parsed = Date.parse(timestamp);
      if (Number.isNaN(parsed)) return timestamp;

      const date = new Date(parsed);
      const isToday =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

      return isToday
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString();
    }
  );
}
