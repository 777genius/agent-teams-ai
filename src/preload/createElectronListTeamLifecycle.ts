import {
  type CanonicalListTeamLifecycleResult,
  type ListTeamLifecycleRequest,
  parseCanonicalListTeamLifecycleResult,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';

import { TEAM_LIST } from './constants/ipcChannels';

import type { IpcRenderer } from 'electron';

export interface IpcResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

function failure(error: TeamLifecycleReadFailure['error']): CanonicalListTeamLifecycleResult {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error,
    retryable: error.code === 'unavailable',
  };
}

function isIpcEnvelope(value: unknown): value is IpcResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof value.success === 'boolean'
  );
}

/** Creates the validated lifecycle read adapter exposed across the Electron context bridge. */
export function createElectronListTeamLifecycle(
  ipcRenderer: Pick<IpcRenderer, 'invoke'>
): TeamLifecycleReadTransportApi['listTeamLifecycle'] {
  return async (requestValue: ListTeamLifecycleRequest) => {
    const request = parseListTeamLifecycleRequest(requestValue);
    if (!request.ok) return failure(request.error as TeamLifecycleReadFailure['error']);

    try {
      const envelope: unknown = await ipcRenderer.invoke(TEAM_LIST, request.value);
      if (!isIpcEnvelope(envelope) || !envelope.success) {
        return failure({ code: 'unavailable', reason: 'transport_unavailable' });
      }
      const parsed = parseCanonicalListTeamLifecycleResult(envelope.data);
      return parsed.ok ? parsed.value : failure(parsed.error as TeamLifecycleReadFailure['error']);
    } catch {
      return failure({ code: 'unavailable', reason: 'transport_unavailable' });
    }
  };
}
