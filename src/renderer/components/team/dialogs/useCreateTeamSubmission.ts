import { useCallback } from 'react';

import { submitRetainedCreate } from './retainedCreateSubmission';

import type { TeamCreateRequest } from '@shared/types/team';

/** An uncertain Create keeps its application intent across proof renewal and actual unmounts. */
export function useCreateTeamSubmission() {
  return useCallback(
    <T>(raw: TeamCreateRequest, create: (request: TeamCreateRequest) => Promise<T>): Promise<T> =>
      submitRetainedCreate('launch', raw, create),
    []
  );
}
