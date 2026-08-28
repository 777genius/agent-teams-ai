import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from 'react';

import type { TeamProviderId } from '@shared/types';

const PROOF_REFRESH_MS = 45_000;

export function useExecutionProofRefresh(input: {
  generation: number | null;
  providerIds: readonly TeamProviderId[];
  clearAuthorization(): void;
  invalidate: Dispatch<SetStateAction<Partial<Record<TeamProviderId, number>>>>;
}): { refreshNow(): void } {
  const latestInput = useRef(input);
  latestInput.current = input;
  const providerSignature = [...new Set(input.providerIds)].sort().join(',');
  const refreshNow = useCallback(() => {
    if (!providerSignature) return;
    latestInput.current.clearAuthorization();
    latestInput.current.invalidate((current) => {
      const next = { ...current };
      for (const providerId of providerSignature.split(',') as TeamProviderId[]) {
        next[providerId] = (next[providerId] ?? 0) + 1;
      }
      return next;
    });
  }, [providerSignature]);
  useEffect(() => {
    if (input.generation === null || !providerSignature) return;
    const timer = window.setTimeout(refreshNow, PROOF_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [input.generation, providerSignature, refreshNow]);
  return { refreshNow };
}
