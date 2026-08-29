import { useCallback, useMemo, useRef, useState } from 'react';

import { commitAuthoritativePrepareCandidate } from './commitAuthoritativePrepareCandidate';

import type {
  AuthoritativeModelExecutionProof,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export interface AuthorizedPreparationCandidate {
  requestSignature: string;
  generation: number;
  executionProof: AuthoritativeModelExecutionProof;
}

interface CommitInput {
  requestSignature: string;
  generation: number;
  cwd: string;
  leadProviderId: TeamProviderId;
  providerIds: readonly TeamProviderId[];
  checksByProvider: ReadonlyMap<TeamProviderId, readonly TeamProvisioningModelCheckRequest[]>;
  limitContext?: boolean;
  allowExperimentalLocalModels?: boolean;
  runtimeRosterRevision: string;
  prepareProvisioning: (
    cwd?: string,
    providerId?: TeamProviderId,
    providerIds?: TeamProviderId[],
    selectedModels?: string[],
    limitContext?: boolean,
    modelVerificationMode?: 'compatibility' | 'deep',
    selectedModelChecks?: TeamProvisioningModelCheckRequest[],
    allowExperimentalLocalModels?: boolean,
    runtimeRosterRevision?: string
  ) => Promise<TeamProvisioningPrepareResult>;
  isCurrent(): boolean;
  onFailure(error: unknown): void;
}

export function useAuthoritativePrepareCandidate(): {
  candidate: AuthorizedPreparationCandidate | null;
  clear(): void;
  publish(input: CommitInput): Promise<void>;
  publishOnce(input: CommitInput): void;
} {
  const [candidate, setCandidate] = useState<AuthorizedPreparationCandidate | null>(null);
  const candidateRef = useRef(candidate);
  candidateRef.current = candidate;
  const pendingKeyRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const clear = useCallback(() => {
    revisionRef.current += 1;
    pendingKeyRef.current = null;
    setCandidate(null);
  }, []);
  const publish = useCallback(async (input: CommitInput): Promise<void> => {
    const revision = ++revisionRef.current;
    try {
      const executionProof = await commitAuthoritativePrepareCandidate(input);
      if (revisionRef.current === revision && input.isCurrent()) {
        setCandidate({
          requestSignature: input.requestSignature,
          generation: input.generation,
          executionProof,
        });
      }
    } catch (error) {
      if (revisionRef.current === revision && input.isCurrent()) {
        setCandidate(null);
        input.onFailure(error);
      }
    }
  }, []);
  const publishOnce = useCallback(
    (input: CommitInput): void => {
      const key = `${input.generation}:${input.requestSignature}`;
      const current = candidateRef.current;
      if (
        (current?.requestSignature === input.requestSignature &&
          current.generation === input.generation) ||
        pendingKeyRef.current === key
      ) {
        return;
      }
      pendingKeyRef.current = key;
      setCandidate(null);
      void publish(input).finally(() => {
        if (pendingKeyRef.current === key) pendingKeyRef.current = null;
      });
    },
    [publish]
  );
  return useMemo(
    () => ({ candidate, clear, publish, publishOnce }),
    [candidate, clear, publish, publishOnce]
  );
}
