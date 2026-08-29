import { TEAM_STOP_FOR_RELAUNCH } from './constants/ipcChannels';

import type { TeamRelaunchStopOutcome } from '@shared/types';

type InvokeWithResult = (channel: string, ...args: unknown[]) => Promise<unknown>;

function isTeamRelaunchStopOutcome(value: unknown): value is TeamRelaunchStopOutcome {
  if (value == null || typeof value !== 'object' || !('status' in value)) return false;
  const status = value.status;
  if (status === 'stopped') return true;
  if (!('diagnostic' in value) || typeof value.diagnostic !== 'string' || !('reason' in value)) {
    return false;
  }
  if (status === 'not-dispatched') return value.reason === 'validation-rejected';
  return (
    status === 'outcome-unknown' &&
    (value.reason === 'stop-operation-failed' ||
      value.reason === 'transport-failure' ||
      value.reason === 'malformed-response')
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converts every IPC-level rejection into an unknown outcome. An invoke
 * rejection cannot prove whether main received or completed the stop request.
 */
export function createTeamRelaunchStopBridge(invoke: InvokeWithResult) {
  return async (teamName: string): Promise<TeamRelaunchStopOutcome> => {
    try {
      const outcome = await invoke(TEAM_STOP_FOR_RELAUNCH, teamName);
      if (isTeamRelaunchStopOutcome(outcome)) return outcome;
      return {
        status: 'outcome-unknown',
        reason: 'malformed-response',
        diagnostic: 'Relaunch stop IPC returned an unrecognized response; dispatch is unknown.',
      };
    } catch (error) {
      return {
        status: 'outcome-unknown',
        reason: 'transport-failure',
        diagnostic: `Relaunch stop IPC failed without an authoritative response: ${describeError(error)}`,
      };
    }
  };
}
