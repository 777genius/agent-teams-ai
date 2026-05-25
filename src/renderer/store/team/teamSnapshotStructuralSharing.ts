import type { TeamViewSnapshot } from '@shared/types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function structurallySharePlainValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) {
    return previous;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    let changed = previous.length !== next.length;
    const result = next.map((nextItem, index) => {
      const sharedItem = structurallySharePlainValue(previous[index], nextItem);
      if (!Object.is(sharedItem, previous[index])) {
        changed = true;
      }
      return sharedItem;
    });
    return changed ? (result as T) : previous;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousRecord = previous as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    let changed = previousKeys.length !== nextKeys.length;
    const result: Record<string, unknown> = {};

    for (const key of nextKeys) {
      if (!Object.prototype.hasOwnProperty.call(previousRecord, key)) {
        changed = true;
      }
      const sharedValue = structurallySharePlainValue(previousRecord[key], nextRecord[key]);
      if (!Object.is(sharedValue, previousRecord[key])) {
        changed = true;
      }
      result[key] = sharedValue;
    }

    return changed ? (result as T) : previous;
  }

  return next;
}

export function structurallyShareTeamSnapshot(
  previous: TeamViewSnapshot | null | undefined,
  next: TeamViewSnapshot
): TeamViewSnapshot {
  if (!previous) {
    return next;
  }
  return structurallySharePlainValue(previous, next);
}
