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
    const hasLengthChange = previous.length !== next.length;
    let result: unknown[] | null = hasLengthChange ? new Array(next.length) : null;

    for (let index = 0; index < next.length; index += 1) {
      const previousItem = previous[index];
      const sharedItem = structurallySharePlainValue(previousItem, next[index]);

      if (result) {
        result[index] = sharedItem;
      } else if (!Object.is(sharedItem, previousItem)) {
        result = new Array(next.length);
        for (let copyIndex = 0; copyIndex < index; copyIndex += 1) {
          result[copyIndex] = previous[copyIndex];
        }
        result[index] = sharedItem;
      }
    }

    return result ? (result as T) : previous;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousRecord = previous as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    const hasKeyCountChange = previousKeys.length !== nextKeys.length;
    let result: Record<string, unknown> | null = hasKeyCountChange ? {} : null;

    for (let index = 0; index < nextKeys.length; index += 1) {
      const key = nextKeys[index];
      const hasPreviousKey = Object.prototype.hasOwnProperty.call(previousRecord, key);
      const sharedValue = structurallySharePlainValue(previousRecord[key], nextRecord[key]);
      if (result) {
        result[key] = sharedValue;
      } else if (!hasPreviousKey || !Object.is(sharedValue, previousRecord[key])) {
        result = {};
        for (let copyIndex = 0; copyIndex < index; copyIndex += 1) {
          const previousKey = nextKeys[copyIndex];
          result[previousKey] = previousRecord[previousKey];
        }
        result[key] = sharedValue;
      }
    }

    return result ? (result as T) : previous;
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
