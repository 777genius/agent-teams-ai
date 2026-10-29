import { useCallback } from 'react';

import { api } from '@renderer/api';

import { submitRetainedCreate } from './retainedCreateSubmission';

import type { TeamCreateConfigRequest } from '@shared/types/team';

/** Closing/unmounting the existing form cannot abandon an uncertain save-only Create. */
export function useCreateConfigSubmission(_open: boolean) {
  return useCallback(
    (raw: TeamCreateConfigRequest) =>
      submitRetainedCreate('config', raw, (request) => api.teams.createConfig(request)),
    []
  );
}
