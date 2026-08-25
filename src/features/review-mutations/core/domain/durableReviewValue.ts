function normalizeDurableReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDurableReviewValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalizeDurableReviewValue(entry)])
  );
}

function areNormalizedValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      const leftHasEntry = Object.prototype.hasOwnProperty.call(left, index);
      const rightHasEntry = Object.prototype.hasOwnProperty.call(right, index);
      if (
        leftHasEntry !== rightHasEntry ||
        (leftHasEntry && !areNormalizedValuesEqual(left[index], right[index]))
      ) {
        return false;
      }
    }
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightRecord).length) return false;
  return leftEntries.every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areNormalizedValuesEqual(value, rightRecord[key])
  );
}

/**
 * Compares JSON-durable review values while treating omitted and undefined
 * object properties identically. Array order remains significant.
 */
export function isDurableReviewEqual(left: unknown, right: unknown): boolean {
  return areNormalizedValuesEqual(
    normalizeDurableReviewValue(left),
    normalizeDurableReviewValue(right)
  );
}
