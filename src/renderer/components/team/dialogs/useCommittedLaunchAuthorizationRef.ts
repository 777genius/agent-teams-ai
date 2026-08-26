import { useLayoutEffect, useMemo, useRef } from 'react';

import type { ProvisioningLaunchAuthorizationInput } from './provisioningLaunchAuthorization';

export function useCommittedLaunchAuthorizationRef(
  authorization: ProvisioningLaunchAuthorizationInput
): React.RefObject<ProvisioningLaunchAuthorizationInput> {
  const authorizationRef = useRef(authorization);
  useLayoutEffect(() => {
    authorizationRef.current = authorization;
  }, [authorization]);
  return authorizationRef;
}

export function useMemoizedCommittedLaunchAuthorization(
  input: ProvisioningLaunchAuthorizationInput
): readonly [
  ProvisioningLaunchAuthorizationInput,
  React.RefObject<ProvisioningLaunchAuthorizationInput>,
] {
  const authorization = useMemo(
    () => ({
      prepareState: input.prepareState,
      providerStatusesAuthoritative: input.providerStatusesAuthoritative,
      preparedRequestSignature: input.preparedRequestSignature,
      currentRequestSignature: input.currentRequestSignature,
      preparedGeneration: input.preparedGeneration,
      currentGeneration: input.currentGeneration,
      providerProofExpiresAtMs: input.providerProofExpiresAtMs,
      executionProof: input.executionProof ?? null,
    }),
    [
      input.currentGeneration,
      input.currentRequestSignature,
      input.executionProof,
      input.preparedGeneration,
      input.preparedRequestSignature,
      input.prepareState,
      input.providerProofExpiresAtMs,
      input.providerStatusesAuthoritative,
    ]
  );
  return [authorization, useCommittedLaunchAuthorizationRef(authorization)] as const;
}
