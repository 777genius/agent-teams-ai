import { normalizePathForComparison } from '@shared/utils/platformPath';
import { posix } from 'path';

/** Group lexical path aliases before deciding whether a file was newly created. */
export function taskChangeFileIdentity(filePath: string): string {
  const slashes = filePath.replace(/\\/g, '/');
  const collapsed = posix.normalize(slashes);
  // posix.normalize collapses a UNC prefix; retain it for Windows identity.
  const normalized =
    slashes.startsWith('//') && !collapsed.startsWith('//') ? `/${collapsed}` : collapsed;
  return normalizePathForComparison(normalized);
}
