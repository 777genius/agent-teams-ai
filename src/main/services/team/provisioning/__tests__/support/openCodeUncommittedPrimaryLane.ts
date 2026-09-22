import type { TeamRuntimeLaunchResult } from '../../../runtime';

/**
 * The shape every regression in this area is pinned against: a failed primary
 * lane whose directory held ONLY the prompt delivery ledger - no
 * `opencode-sessions.json`, no `manifest.json`, no
 * `opencode-runtime-receipts.json` - while the lead still reported
 * `confirmed_alive`.
 */
export const UNCOMMITTED_PRIMARY_LANE_STORAGE = {
  laneDirectoryExists: true,
  hasStateOnDisk: true,
  hasRuntimeEvidenceOnDisk: false,
  manifestEntryCount: null,
  manifestUpdatedAt: null,
  fileNames: ['opencode-prompt-delivery-ledger.json'],
} as const;

/** The same lane after the session record and its manifest entry landed. */
export const COMMITTED_PRIMARY_LANE_STORAGE = {
  laneDirectoryExists: true,
  hasStateOnDisk: true,
  hasRuntimeEvidenceOnDisk: true,
  manifestEntryCount: 1,
  manifestUpdatedAt: '2026-08-28T12:28:16.028Z',
  fileNames: [
    'opencode-prompt-delivery-ledger.json',
    'opencode-sessions.json',
    'manifest.json',
    'opencode-runtime-receipts.json',
  ],
} as const;

export function buildUncommittedPrimaryLeadLaunchResult(
  overrides: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      'team-lead': {
        memberName: 'team-lead',
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        // The whole point: no sessionId, no runtimePid, no app-managed candidate.
        diagnostics: [],
      },
    },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

export function buildRetainableOpenCodeLaunchResult(
  memberName: string,
  overrides: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members: {
      [memberName]: {
        memberName,
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        diagnostics: [],
      },
    },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

export function buildFailedOpenCodeLaunchResult(
  memberName: string,
  hardFailureReason: string
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members: {
      [memberName]: {
        memberName,
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason,
        diagnostics: [],
      },
    },
    warnings: [],
    diagnostics: [],
  };
}
