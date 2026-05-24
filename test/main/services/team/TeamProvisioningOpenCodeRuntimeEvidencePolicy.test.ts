import {
  appendDiagnosticOnce,
  buildOpenCodeSecondaryLaneTimingDiagnostic,
  buildOpenCodeUncommittedBootstrapDiagnostic,
  collectOpenCodeSecondaryLaneFailureDiagnostics,
  collectRuntimeLaunchFailureDiagnostics,
  createUnexpectedMixedSecondaryLaneFailureResult,
  downgradeUncommittedOpenCodeBootstrapEvidence,
  formatOpenCodeLaneTimingMs,
  getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted,
  hasMaterializedOpenCodeRuntimeForBootstrap,
  hasOpenCodeRuntimeEntryHandle,
  hasOpenCodeRuntimeHandle,
  hasOpenCodeRuntimeLivenessMarker,
  hasRecoverableOpenCodeBootstrapDiagnostic,
  isBootstrapMemberEvidenceCurrentForMember,
  isDefinitiveOpenCodePreLaunchFailure,
  isExplicitLegacyOpenCodeBootstrap,
  isMaterializedOpenCodeSessionId,
  isRecoverableOpenCodeBootstrapPendingLaunchResult,
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
  MEMBER_BOOTSTRAP_STALL_MS,
  normalizeIsoTimestamp,
  normalizeRecoverableOpenCodeBootstrapPendingLaunchResult,
  OPENCODE_APP_MANAGED_BOOTSTRAP_PENDING_DIAGNOSTIC,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
  OPENCODE_BOOTSTRAP_PENDING_DIAGNOSTIC,
  promoteCommittedOpenCodeAppManagedBootstrapEvidence,
  resolveOpenCodeBootstrapAcceptedAt,
  selectOpenCodeSecondaryBootstrapStallDiagnostic,
  shouldMarkPersistedOpenCodeBootstrapStalled,
  summarizeRuntimeLaunchResultMembers,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { describe, expect, it } from 'vitest';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { PersistedTeamLaunchMemberState } from '@shared/types';

const acceptedAt = '2026-01-01T00:00:00.000Z';
const stalledAtMs = Date.parse(acceptedAt) + MEMBER_BOOTSTRAP_STALL_MS + 1;

function makePersisted(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    providerId: 'opencode',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    laneId: 'opencode-secondary',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    firstSpawnAcceptedAt: acceptedAt,
    lastEvaluatedAt: acceptedAt,
    ...overrides,
  };
}

function makeEvidence(
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Builder',
    providerId: 'opencode',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    diagnostics: [],
    ...overrides,
  };
}

function makeLaunchResult(
  member: TeamRuntimeMemberLaunchEvidence = makeEvidence(),
  overrides: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'demo',
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    members: { [member.memberName]: member },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeRuntimeEvidencePolicy', () => {
  it('formats timing diagnostics and appends diagnostics without duplicates', () => {
    expect(formatOpenCodeLaneTimingMs(12.6)).toBe('13ms');
    expect(formatOpenCodeLaneTimingMs(-4.4)).toBe('0ms');
    expect(formatOpenCodeLaneTimingMs(Number.NaN)).toBe('n/a');
    expect(appendDiagnosticOnce(['existing'], 'new')).toEqual(['existing', 'new']);
    expect(appendDiagnosticOnce(['existing'], 'existing')).toEqual(['existing']);
    expect(appendDiagnosticOnce(['existing'], null)).toEqual(['existing']);
    expect(
      buildOpenCodeSecondaryLaneTimingDiagnostic({
        member: { name: 'Builder' },
        queuedAtMs: 10,
        launchStartedAtMs: 40,
        launchFinishedAtMs: 145,
      })
    ).toBe(
      'OpenCode secondary lane timing: member=Builder queueWaitMs=30ms launchMs=105ms totalMs=135ms'
    );
    expect(
      buildOpenCodeSecondaryLaneTimingDiagnostic({
        member: { name: 'Builder' },
        queuedAtMs: 10,
        launchStartedAtMs: 40,
      })
    ).toBeNull();
  });

  it('recognizes OpenCode runtime handles without accepting empty or failed sessions', () => {
    expect(hasOpenCodeRuntimeHandle({ runtimePid: 12 })).toBe(true);
    expect(hasOpenCodeRuntimeHandle({ runtimeSessionId: ' session-1 ' })).toBe(true);
    expect(hasOpenCodeRuntimeHandle({ sessionId: 'session-2' })).toBe(true);
    expect(hasOpenCodeRuntimeHandle({ runtimePid: 0, sessionId: '  ' })).toBe(false);
    expect(hasOpenCodeRuntimeHandle({ sessionId: 'failed:session-2' })).toBe(false);
    expect(hasOpenCodeRuntimeHandle({ runtimeSessionId: 'FAILED:session-3' })).toBe(false);
    expect(hasOpenCodeRuntimeEntryHandle({ runtimeSessionId: 'failed:entry-session' })).toBe(false);
    expect(hasOpenCodeRuntimeLivenessMarker({ livenessKind: 'runtime_process_candidate' })).toBe(
      true
    );
    expect(hasOpenCodeRuntimeLivenessMarker({ livenessKind: 'registered_only' })).toBe(false);
  });

  it('collects launch diagnostics and detects definitive pre-launch failures', () => {
    const result = makeLaunchResult(
      makeEvidence({
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'binary missing',
        diagnostics: ['member diagnostic'],
      }),
      { diagnostics: ['result diagnostic'] }
    );
    expect(collectRuntimeLaunchFailureDiagnostics(result, 'Builder')).toEqual([
      'member diagnostic',
      'binary missing',
      'result diagnostic',
    ]);
    expect(collectOpenCodeSecondaryLaneFailureDiagnostics(result, 'Builder', ['prefix'])).toEqual([
      'prefix',
      'member diagnostic',
      'binary missing',
      'result diagnostic',
    ]);
    expect(
      collectOpenCodeSecondaryLaneFailureDiagnostics(makeLaunchResult(), 'Missing', [])
    ).toEqual(['OpenCode bridge reported member launch failure']);
    expect(isDefinitiveOpenCodePreLaunchFailure(result, 'Builder')).toBe(true);
    expect(
      isDefinitiveOpenCodePreLaunchFailure(
        makeLaunchResult(
          makeEvidence({
            launchState: 'failed_to_start',
            hardFailure: true,
            diagnostics: ['outcome must be reconciled before retry'],
          })
        ),
        'Builder'
      )
    ).toBe(false);
    expect(
      isDefinitiveOpenCodePreLaunchFailure(
        makeLaunchResult(
          makeEvidence({
            launchState: 'failed_to_start',
            hardFailure: true,
            sessionId: 'runtime-session',
          })
        ),
        'Builder'
      )
    ).toBe(false);
  });

  it('normalizes recoverable bootstrap-pending launch results', () => {
    const result = makeLaunchResult(
      makeEvidence({
        sessionId: 'runtime-session',
        diagnostics: ['member_briefing not connected'],
      }),
      { diagnostics: ['result diagnostic'] }
    );
    expect(isMaterializedOpenCodeSessionId('runtime-session')).toBe(true);
    expect(isMaterializedOpenCodeSessionId('failed:runtime-session')).toBe(false);
    expect(isMaterializedOpenCodeSessionId('FAILED:runtime-session')).toBe(false);
    expect(hasMaterializedOpenCodeRuntimeForBootstrap(result.members.Builder)).toBe(true);
    expect(isRecoverableOpenCodeBootstrapPendingLaunchResult(result, 'Builder')).toBe(true);

    const normalized = normalizeRecoverableOpenCodeBootstrapPendingLaunchResult(result, 'Builder', [
      'extra diagnostic',
    ]);
    expect(normalized.members.Builder.launchState).toBe('runtime_pending_bootstrap');
    expect(normalized.members.Builder.runtimeAlive).toBe(true);
    expect(normalized.members.Builder.hardFailure).toBe(false);
    expect(normalized.members.Builder.diagnostics).toEqual([
      'member_briefing not connected',
      OPENCODE_BOOTSTRAP_PENDING_DIAGNOSTIC,
      OPENCODE_APP_MANAGED_BOOTSTRAP_PENDING_DIAGNOSTIC,
      'extra diagnostic',
    ]);
    expect(normalized.diagnostics).toContain('result diagnostic');
    expect(normalized.diagnostics).toContain(OPENCODE_BOOTSTRAP_PENDING_DIAGNOSTIC);
    expect(normalized.teamLaunchState).toBe('partial_pending');
    expect(normalizeRecoverableOpenCodeBootstrapPendingLaunchResult(result, 'Missing', [])).toBe(
      result
    );
  });

  it('summarizes launch result members and transforms bootstrap evidence', () => {
    expect(
      summarizeRuntimeLaunchResultMembers({
        Builder: makeEvidence({ launchState: 'confirmed_alive' }),
        Reviewer: makeEvidence({ memberName: 'Reviewer', launchState: 'confirmed_alive' }),
      })
    ).toBe('clean_success');
    expect(
      summarizeRuntimeLaunchResultMembers({
        Builder: makeEvidence({ launchState: 'confirmed_alive' }),
        Reviewer: makeEvidence({
          memberName: 'Reviewer',
          launchState: 'failed_to_start',
          hardFailure: true,
        }),
      })
    ).toBe('partial_failure');
    expect(summarizeRuntimeLaunchResultMembers({})).toBe('partial_pending');

    expect(
      buildOpenCodeUncommittedBootstrapDiagnostic({
        manifestEntryCount: 2,
        manifestUpdatedAt: '2026-01-01T00:00:00.000Z',
        fileNames: ['lane-a.json', 'lane-b.json'],
      })
    ).toEqual([
      'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.',
      'OpenCode lane manifest entries: 2',
      'OpenCode lane manifest updated at: 2026-01-01T00:00:00.000Z',
      'OpenCode lane files: lane-a.json, lane-b.json',
    ]);

    const downgraded = downgradeUncommittedOpenCodeBootstrapEvidence(
      makeEvidence({
        sessionId: 'runtime-session',
        livenessKind: 'confirmed_bootstrap',
        diagnostics: ['existing'],
      }),
      ['new diagnostic']
    );
    expect(downgraded.launchState).toBe('runtime_pending_bootstrap');
    expect(downgraded.livenessKind).toBe('runtime_process_candidate');
    expect(downgraded.diagnostics).toEqual(['existing', 'new diagnostic']);

    const promoted = promoteCommittedOpenCodeAppManagedBootstrapEvidence(
      makeEvidence({ diagnostics: ['existing'] })
    );
    expect(promoted.launchState).toBe('confirmed_alive');
    expect(promoted.bootstrapConfirmed).toBe(true);
    expect(promoted.livenessKind).toBe('confirmed_bootstrap');
    expect(promoted.diagnostics).toEqual([
      'existing',
      'OpenCode app-managed bootstrap evidence committed and read back.',
    ]);
  });

  it('builds unexpected mixed secondary lane failure results', () => {
    const result = createUnexpectedMixedSecondaryLaneFailureResult({
      runId: 'run-1',
      teamName: 'demo',
      memberName: 'Builder',
      message: 'launch failed',
    });
    expect(result.launchPhase).toBe('finished');
    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.members.Builder).toMatchObject({
      providerId: 'opencode',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'launch failed',
      diagnostics: ['launch failed'],
    });
    expect(result.diagnostics).toEqual(['launch failed']);
  });

  it('recognizes runtime entry handles from pid, runtime session, or liveness', () => {
    expect(hasOpenCodeRuntimeEntryHandle({ pid: 7 })).toBe(true);
    expect(hasOpenCodeRuntimeEntryHandle({ runtimePid: 8 })).toBe(true);
    expect(hasOpenCodeRuntimeEntryHandle({ runtimeSessionId: 'runtime-session' })).toBe(true);
    expect(hasOpenCodeRuntimeEntryHandle({ livenessKind: 'permission_blocked' })).toBe(true);
    expect(hasOpenCodeRuntimeEntryHandle({ pid: 0, runtimeSessionId: '  ' })).toBe(false);
  });

  it('keeps recoverable bootstrap diagnostics separate from real failures', () => {
    expect(hasRecoverableOpenCodeBootstrapDiagnostic(['member_briefing not connected'])).toBe(true);
    expect(hasRecoverableOpenCodeBootstrapDiagnostic(['runtime_bootstrap_checkin pending'])).toBe(
      true
    );
    expect(hasRecoverableOpenCodeBootstrapDiagnostic(['provider unavailable: quota exceeded'])).toBe(
      false
    );
    expect(hasRecoverableOpenCodeBootstrapDiagnostic([])).toBe(false);
  });

  it('classifies recoverable persisted OpenCode runtime candidates', () => {
    expect(
      isRecoverablePersistedOpenCodeRuntimeCandidate(makePersisted({ runtimeSessionId: 'rt-1' }))
    ).toBe(true);
    expect(
      isRecoverablePersistedOpenCodeRuntimeCandidate(
        makePersisted({ pendingPermissionRequestIds: ['perm-1'] })
      )
    ).toBe(true);
    expect(
      isRecoverablePersistedOpenCodeRuntimeCandidate(makePersisted({ agentToolAccepted: false }))
    ).toBe(false);
    expect(
      isRecoverablePersistedOpenCodeRuntimeCandidate(makePersisted({ skippedForLaunch: true }))
    ).toBe(false);
    expect(
      isRecoverablePersistedOpenCodeRuntimeCandidate(makePersisted({ laneKind: 'primary' }))
    ).toBe(false);
  });

  it('selects the earliest accepted-at timestamp from first spawn and diagnostics', () => {
    expect(normalizeIsoTimestamp('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizeIsoTimestamp('not a date')).toBeNull();
    expect(
      resolveOpenCodeBootstrapAcceptedAt(
        makePersisted({
          firstSpawnAcceptedAt: '2026-01-01T00:10:00.000Z',
          diagnostics: ['member_session_recorded at 2026-01-01T00:05:00.000Z'],
        })
      )
    ).toBe('2026-01-01T00:05:00.000Z');
    expect(
      resolveOpenCodeBootstrapAcceptedAt(
        makePersisted({ firstSpawnAcceptedAt: 'not a date', diagnostics: ['noise'] })
      )
    ).toBeUndefined();
  });

  it('builds legacy and app-managed bootstrap stall diagnostics', () => {
    expect(isExplicitLegacyOpenCodeBootstrap({ bootstrapMode: 'model_tool_checkin' })).toBe(true);
    expect(isExplicitLegacyOpenCodeBootstrap({ bootstrapMode: 'app_managed_context' })).toBe(false);
    expect(
      selectOpenCodeSecondaryBootstrapStallDiagnostic([
        'OpenCode secondary lane timing: 100ms',
        'member_briefing delivery pending',
      ])
    ).toBe('member_briefing delivery pending; runtime_bootstrap_checkin did not complete after 5 min.');
    expect(getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(makePersisted())).toBe(
      OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC
    );
    expect(
      getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(
        makePersisted({
          bootstrapMode: 'model_tool_checkin',
          diagnostics: ['member_briefing delivery pending'],
        })
      )
    ).toBe('member_briefing delivery pending; runtime_bootstrap_checkin did not complete after 5 min.');
    expect(
      getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(
        makePersisted({
          bootstrapMode: 'model_tool_checkin',
          runtimeDiagnostic: 'runtime_bootstrap_checkin timed out',
        })
      )
    ).toBe('runtime_bootstrap_checkin timed out');
  });

  it('marks persisted bootstrap as stalled only after threshold with recoverable evidence', () => {
    expect(
      shouldMarkPersistedOpenCodeBootstrapStalled(
        makePersisted({ runtimeSessionId: 'runtime-session' }),
        stalledAtMs
      )
    ).toBe(true);
    expect(
      shouldMarkPersistedOpenCodeBootstrapStalled(
        makePersisted({ diagnostics: ['member_briefing not connected'] }),
        stalledAtMs
      )
    ).toBe(true);
    expect(
      shouldMarkPersistedOpenCodeBootstrapStalled(
        makePersisted({ runtimeSessionId: 'runtime-session' }),
        Date.parse(acceptedAt) + MEMBER_BOOTSTRAP_STALL_MS - 1
      )
    ).toBe(false);
    expect(
      shouldMarkPersistedOpenCodeBootstrapStalled(
        makePersisted({ runtimeSessionId: 'runtime-session', hardFailureReason: 'model not found' }),
        stalledAtMs
      )
    ).toBe(false);
    expect(
      shouldMarkPersistedOpenCodeBootstrapStalled(
        makePersisted({
          runtimeSessionId: 'runtime-session',
          pendingPermissionRequestIds: ['perm-1'],
        }),
        stalledAtMs
      )
    ).toBe(false);
  });

  it('recognizes recoverable terminal persisted candidates and runtime evidence', () => {
    expect(
      isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(
        makePersisted({
          launchState: 'failed_to_start',
          hardFailure: true,
          runtimeSessionId: 'runtime-session',
        })
      )
    ).toBe(true);
    expect(
      isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(
        makePersisted({ launchState: 'failed_to_start', hardFailure: true })
      )
    ).toBe(false);

    const evidence: Partial<TeamRuntimeMemberLaunchEvidence> = {
      agentToolAccepted: true,
      livenessKind: 'runtime_process',
    };
    expect(isRecoverableOpenCodeRuntimeEvidence(evidence as TeamRuntimeMemberLaunchEvidence)).toBe(
      true
    );
    expect(isRecoverableOpenCodeRuntimeEvidence({ runtimeAlive: true } as TeamRuntimeMemberLaunchEvidence)).toBe(
      true
    );
    expect(isRecoverableOpenCodeRuntimeEvidence(undefined)).toBe(false);
  });

  it('checks bootstrap evidence recency against the current member spawn boundary', () => {
    const current = {
      firstSpawnAcceptedAt: '2026-01-01T00:01:00.000Z',
      lastEvaluatedAt: '2026-01-01T00:01:10.000Z',
    };
    expect(
      isBootstrapMemberEvidenceCurrentForMember(
        current,
        {
          firstSpawnAcceptedAt: '2026-01-01T00:01:01.000Z',
          lastHeartbeatAt: '2026-01-01T00:01:02.000Z',
          lastEvaluatedAt: '2026-01-01T00:01:03.000Z',
        },
        'acceptance'
      )
    ).toBe(true);
    expect(
      isBootstrapMemberEvidenceCurrentForMember(
        current,
        {
          firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
          lastHeartbeatAt: '2026-01-01T00:00:40.000Z',
          lastEvaluatedAt: '2026-01-01T00:00:50.000Z',
        },
        'confirmation'
      )
    ).toBe(false);
    expect(
      isBootstrapMemberEvidenceCurrentForMember(
        { firstSpawnAcceptedAt: undefined, lastEvaluatedAt: undefined },
        {
          firstSpawnAcceptedAt: 'not-a-date',
          lastHeartbeatAt: undefined,
          lastRuntimeAliveAt: '2026-01-01T00:00:40.000Z',
          lastEvaluatedAt: '2026-01-01T00:00:30.000Z',
        },
        'confirmation'
      )
    ).toBe(true);
  });
});
