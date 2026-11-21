import { api } from '@renderer/api';

import type {
  RetainedLegacyLaunchApi,
  RetainedLegacyLaunchResult,
  RetainedLegacyLaunchValueMap,
} from '../contracts/retainedLegacyLaunch';

export type RetainedLegacyTransport = NonNullable<RetainedLegacyLaunchApi['retainedLegacyLaunch']>;
export class RetainedLegacyLaunchError extends Error {
  constructor(
    readonly outcome: 'not-dispatched' | 'unknown',
    message: string
  ) {
    super(message);
  }
}
export function captureRetainedLegacyTransport(): RetainedLegacyTransport {
  const owner = api.agentBackend as RetainedLegacyLaunchApi | undefined;
  const invoke = owner?.retainedLegacyLaunch;
  if (!invoke)
    throw new RetainedLegacyLaunchError(
      'not-dispatched',
      'Original runtime is unavailable. Close and reopen Launch.'
    );
  return (request) => invoke.call(owner, request);
}
export function retainedLegacyValue<K extends keyof RetainedLegacyLaunchValueMap>(
  result: RetainedLegacyLaunchResult,
  action: K
): RetainedLegacyLaunchValueMap[K] {
  if (!result.ok)
    throw new RetainedLegacyLaunchError(
      result.outcome,
      result.outcome === 'unknown'
        ? 'The previous request may have completed. Close Launch and check the team before trying again.'
        : result.reason === 'busy'
          ? 'The original runtime is still checking. Wait for it to finish and try again.'
          : 'The original team or runtime changed. Close and reopen Launch.'
    );
  if (result.action !== action)
    throw new RetainedLegacyLaunchError(
      'unknown',
      'Original runtime response could not be verified. Close Launch.'
    );
  return result.value as RetainedLegacyLaunchValueMap[K];
}
