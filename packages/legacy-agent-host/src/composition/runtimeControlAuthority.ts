import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';

import type { MemberEntry } from './MemberEntry.js';

/** Retain the trusted caller's grant epoch across async control/allocation fences. */
export function captureRuntimeControlAuthority(options: {
  entry: MemberEntry;
  principalId: string;
  assertWriter(): void;
  isSealed(): boolean;
  restore?: boolean;
}): () => void {
  const { entry, principalId } = options;
  const original = structuredClone(entry.binding);
  const revision = entry.team.owner.withLaunchAuthority(principalId, 'read', (value) => value);
  return () => {
    options.assertWriter();
    const current = entry.binding;
    if (options.isSealed() ||
      runtimeDigest(options.restore ? { ...current, generation: original.generation } : current) !== runtimeDigest(original) ||
      !entry.team.owner.withLaunchAuthority(principalId, 'read', (value) => value === revision) ||
      !entry.team.owner.authorizeRuntimeAccess(principalId, current, 'control'))
      throw new RuntimeOwnerError('forbidden');
  };
}
