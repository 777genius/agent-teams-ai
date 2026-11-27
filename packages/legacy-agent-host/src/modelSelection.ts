import { z } from 'zod';

const componentLimit = 256;

/** App model choices may qualify two native IDs; native profiles retain their own ID limits. */
export const modelSelectionSchema = z.string().min(1).max(2 * componentLimit + 1).refine(value => {
  if (/[\x00-\x1f\x7f]/u.test(value)) return false;
  if (value.length <= componentLimit) return true;
  const separator = value.indexOf('/');
  // The first slash separates the provider; later slashes belong to the native model ID.
  return separator > 0 && separator <= componentLimit &&
    value.length - separator - 1 > 0 && value.length - separator - 1 <= componentLimit;
});
