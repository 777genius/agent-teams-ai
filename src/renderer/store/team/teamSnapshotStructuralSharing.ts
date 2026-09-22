import type { TeamViewSnapshot } from '@shared/types';

function arePlainObjectPair(previous: object, next: object): boolean {
  const previousPrototype = Object.getPrototypeOf(previous);
  if (previousPrototype !== Object.prototype && previousPrototype !== null) {
    return false;
  }
  const nextPrototype = Object.getPrototypeOf(next);
  return nextPrototype === Object.prototype || nextPrototype === null;
}

export function structurallySharePlainValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) {
    return previous;
  }

  if (
    previous == null ||
    next == null ||
    typeof previous !== 'object' ||
    typeof next !== 'object'
  ) {
    return next;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    const hasLengthChange = previous.length !== next.length;
    let result: unknown[] | null = hasLengthChange ? new Array(next.length) : null;

    for (let index = 0; index < next.length; index += 1) {
      const previousItem = previous[index];
      const nextItem = next[index];
      const sharedItem = Object.is(previousItem, nextItem)
        ? previousItem
        : structurallySharePlainValue(previousItem, nextItem);

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

  if (arePlainObjectPair(previous, next)) {
    const previousRecord = previous as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    const hasKeyCountChange = previousKeys.length !== nextKeys.length;
    let result: Record<string, unknown> | null = hasKeyCountChange ? {} : null;

    for (let index = 0; index < nextKeys.length; index += 1) {
      const key = nextKeys[index];
      const hasPreviousKey = Object.prototype.hasOwnProperty.call(previousRecord, key);
      const previousValue = previousRecord[key];
      const nextValue = nextRecord[key];
      const sharedValue =
        hasPreviousKey && Object.is(previousValue, nextValue)
          ? previousValue
          : structurallySharePlainValue(previousValue, nextValue);
      if (result) {
        result[key] = sharedValue;
      } else if (!hasPreviousKey || !Object.is(sharedValue, previousValue)) {
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
