import { CapturedHostClient } from '../infrastructure/CapturedHostClient';

import type { SelectedHostProfile } from '../infrastructure/selectedHostProfile';

/** Caller retains the instance before awaiting start so Quit can seal pending startup. */
export function createCapturedHostClient(profile: SelectedHostProfile): CapturedHostClient {
  return new CapturedHostClient(profile);
}
