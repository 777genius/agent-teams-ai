import { createHash } from 'node:crypto';

/** Exact trusted role/team/workspace instructions installed through the provider's native config. */
export function initialContextDigest(instructions: string): string {
  return createHash('sha256').update(instructions, 'utf8').digest('hex');
}
