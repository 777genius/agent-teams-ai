import { normalizeOptionalTeamProviderId } from './teamProvider';

import type { TeamProviderId } from '@shared/types';

export class TeamRuntimeSelectionError extends Error {
  readonly name = 'TeamLaunchValidationError';
  constructor(
    readonly code: 'RUNTIME_SELECTION_REQUIRED' | 'RUNTIME_SELECTION_UNSUPPORTED',
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export function normalizeRuntimeSelectionVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value === 1) return 1;
  throw new TeamRuntimeSelectionError(
    'RUNTIME_SELECTION_UNSUPPORTED',
    'Unsupported runtimeSelectionVersion'
  );
}

export function resolveTeamRuntimeSelection(input: {
  runtimeSelectionVersion?: unknown;
  providerId?: unknown;
}): { status: 'selected'; providerId: TeamProviderId } | { status: 'unresolved' } {
  const version = normalizeRuntimeSelectionVersion(input.runtimeSelectionVersion);
  const providerId = normalizeOptionalTeamProviderId(input.providerId);
  if (providerId) return { status: 'selected', providerId };
  return version === 1 ? { status: 'unresolved' } : { status: 'selected', providerId: 'anthropic' };
}

export function requireTeamRuntimeSelection(
  input: Parameters<typeof resolveTeamRuntimeSelection>[0]
): TeamProviderId {
  const selection = resolveTeamRuntimeSelection(input);
  if (selection.status === 'unresolved') {
    throw new TeamRuntimeSelectionError(
      'RUNTIME_SELECTION_REQUIRED',
      'Choose a team provider before launching'
    );
  }
  return selection.providerId;
}
