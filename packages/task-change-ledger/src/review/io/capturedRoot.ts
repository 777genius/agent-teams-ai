import { isAbsolute } from 'node:path';

/** Composition supplies a captured namespace; never resolve a relative root against process cwd. */
export function assertReviewStorageRoot(root: string): void {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))
    throw new Error('Review storage requires an explicit absolute teams root');
}
