import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';

import type { TeamProviderId } from '@shared/types';

const PROOF_REFRESH_MS = 45_000;

export function useExecutionProofRefresh(input: {
  generation: number | null;
  providerIds: readonly TeamProviderId[];
  clearAuthorization(): void;
  invalidate: Dispatch<SetStateAction<Partial<Record<TeamProviderId, number>>>>;
}): void {
  const latestInput = useRef(input);
  latestInput.current = input;
  const providerSignature = [...new Set(input.providerIds)].sort().join(',');
  useEffect(() => {
    if (input.generation === null || !providerSignature) return;
    const timer = window.setTimeout(() => {
      latestInput.current.clearAuthorization();
      latestInput.current.invalidate((current) => {
        const next = { ...current };
        for (const providerId of providerSignature.split(',') as TeamProviderId[]) {
          next[providerId] = (next[providerId] ?? 0) + 1;
        }
        return next;
      });
    }, PROOF_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [input.generation, providerSignature]);
}
