import { CapturedHostClient } from '../infrastructure/CapturedHostClient';

import type { SelectedHostProfile } from '../infrastructure/selectedHostProfile';
import type { HostCustodyOwner } from '@agent-teams/legacy-agent-host/owned-process';

/** Caller retains the instance before awaiting start so Quit can seal pending startup. */
export function createCapturedHostClient(
  profile: SelectedHostProfile,
  nativeOwner?: HostCustodyOwner
): CapturedHostClient {
  return new CapturedHostClient(profile, nativeOwner);
}
