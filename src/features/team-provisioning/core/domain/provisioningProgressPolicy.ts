import type { TeamProvisioningProgress } from '@shared/types';

type TeamProvisioningProgressState = TeamProvisioningProgress['state'];

const ACTIVE_PROVISIONING_STATES: ReadonlySet<TeamProvisioningProgressState> = new Set([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

const TERMINAL_PROVISIONING_STATES: ReadonlySet<TeamProvisioningProgressState> = new Set([
  'ready',
  'failed',
  'disconnected',
  'cancelled',
]);

export function isActiveProvisioningState(state: TeamProvisioningProgressState): boolean {
  return ACTIVE_PROVISIONING_STATES.has(state);
}

export function isTerminalProvisioningState(state: TeamProvisioningProgressState): boolean {
  return TERMINAL_PROVISIONING_STATES.has(state);
}

export function shouldIgnoreProvisioningProgressRegression(
  currentState: TeamProvisioningProgressState,
  nextState: TeamProvisioningProgressState
): boolean {
  if (currentState === 'ready') {
    return nextState !== 'ready' && nextState !== 'disconnected';
  }
  if (
    currentState === 'failed' ||
    currentState === 'cancelled' ||
    currentState === 'disconnected'
  ) {
    return nextState !== currentState;
  }
  return false;
}
