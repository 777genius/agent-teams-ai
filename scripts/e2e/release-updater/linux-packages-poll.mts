import { assertAutomaticNoUpdate } from './linux-packages-seal.mts';

import type { AutomaticFeedProof } from './linux-packages-seal.mts';
import type { Identity } from './linux-packages-native.mts';

// Main and renderer observations are sequential and can straddle one terminal event.
export function automaticNoUpdatePollResult(
  owner: Identity,
  version: string,
  proof: AutomaticFeedProof
): AutomaticFeedProof | null {
  if (
    proof.events.some((event) => event.type === 'error') ||
    proof.statuses.some((status) => status.type === 'error' || status.error)
  )
    assertAutomaticNoUpdate(owner, version, proof);
  if (
    !proof.events.some(
      (event) => event.type === 'update-not-available' && event.version === version
    ) ||
    !proof.statuses.some((status) => status.type === 'not-available')
  )
    return null;
  assertAutomaticNoUpdate(owner, version, proof);
  return proof;
}
