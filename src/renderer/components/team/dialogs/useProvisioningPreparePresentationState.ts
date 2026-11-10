import { useEffect, useState } from 'react';

import type { ProvisioningPrepareState } from './provisioningProviderChecks';

const FAILURE_PRESENTATION_DELAY_MS = 200;

export function useProvisioningPreparePresentationState(
  state: ProvisioningPrepareState,
  open: boolean
): ProvisioningPrepareState {
  const [failureVisible, setFailureVisible] = useState(false);

  useEffect(() => {
    if (!open || state !== 'failed') {
      setFailureVisible(false);
      return undefined;
    }

    const timeout = globalThis.setTimeout(
      () => setFailureVisible(true),
      FAILURE_PRESENTATION_DELAY_MS
    );
    return () => globalThis.clearTimeout(timeout);
  }, [open, state]);

  return state === 'failed' && !failureVisible ? 'loading' : state;
}
