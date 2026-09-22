import { describe, expect, it, vi } from 'vitest';

import { commitOpenCodeRuntimeAdapterLaunchSessionEvidence } from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type { TeamRuntimeLaunchResult, TeamRuntimeMemberLaunchEvidence } from '../../runtime';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';

function bootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
  return {
    teamsBasePath: '/safe-test/teams',
    readFileUtf8: vi.fn(),
    mkdirRecursive: vi.fn(),
    readCommittedBootstrapSessionEvidence: vi.fn(),
    getCurrentAgentTeamsMcpHttpTransportEvidence: vi.fn(() => null),
    isFileLockTimeoutError: vi.fn(() => false),
    warn: vi.fn(),
  };
}

function member(
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'team-lead',
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    diagnostics: [],
    ...overrides,
  };
}

function launchResult(
  members: Record<string, TeamRuntimeMemberLaunchEvidence>
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'finished',
    teamLaunchState: 'clean_success',
    members,
    warnings: [],
    diagnostics: [],
  };
}

interface UncommittableSessionCommitPorts {
  createOpenCodeRuntimeBootstrapEvidencePorts: () => OpenCodeRuntimeBootstrapEvidencePorts;
  nowIso: () => string;
  logDiagnostic?: (message: string) => void;
}

function ports(logDiagnostic?: (message: string) => void): UncommittableSessionCommitPorts {
  return {
    createOpenCodeRuntimeBootstrapEvidencePorts: () => bootstrapEvidencePorts(),
    nowIso: () => '2026-08-28T12:20:00.000Z',
    ...(logDiagnostic ? { logDiagnostic } : {}),
  };
}

describe('a primary-lane member whose session cannot be committed says so', () => {
  it('reports and annotates a confirmed lead with no runtime session id', async () => {
    const reports: string[] = [];
    const result = launchResult({ 'team-lead': member() });

    const committed = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'primary', result },
      ports((message) => reports.push(message))
    );

    expect(reports).toEqual([
      '[lane-team] opencode_bootstrap_session_not_committed:team-lead:missing_runtime_session_id ' +
        '(lane=primary)',
    ]);
    expect(committed.diagnostics).toContain(
      'opencode_bootstrap_session_not_committed:team-lead:missing_runtime_session_id'
    );
    expect(committed.members['team-lead']?.diagnostics).toContain(
      'opencode_bootstrap_session_not_committed:team-lead:missing_runtime_session_id'
    );
  });

  // NEGATIVE CONTROL: reporting never promotes. The annotation is member-level
  // only; re-summarizing here would let it UPGRADE a partial_failure launch.
  it('leaves the aggregate launch state exactly as it found it', async () => {
    const result = {
      ...launchResult({ 'team-lead': member() }),
      teamLaunchState: 'partial_failure' as const,
      launchPhase: 'active' as const,
    };

    const committed = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'primary', result },
      ports()
    );

    expect(committed.teamLaunchState).toBe('partial_failure');
    expect(committed.launchPhase).toBe('active');
    expect(committed.members['team-lead']?.launchState).toBe('confirmed_alive');
  });

  // NEGATIVE CONTROL: a secondary member that is confirmed before its session id
  // lands is an ordinary launch race, not an incident. Reporting it would add a
  // line on every healthy launch.
  it('says nothing for the same shape on a secondary lane', async () => {
    const reports: string[] = [];
    const result = launchResult({ Ada: member({ memberName: 'Ada' }) });

    const committed = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'secondary:opencode:ada', result },
      ports((message) => reports.push(message))
    );

    expect(reports).toEqual([]);
    expect(committed).toBe(result);
  });

  // NEGATIVE CONTROL: an unconfirmed member with no candidate is not this
  // report's shape either - it never claimed anything to be held to.
  it('says nothing for a primary member that never claimed confirmation', async () => {
    const reports: string[] = [];
    const result = launchResult({
      'team-lead': member({
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
      }),
    });

    const committed = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'primary', result },
      ports((message) => reports.push(message))
    );

    expect(reports).toEqual([]);
    expect(committed).toBe(result);
  });

  // NEGATIVE CONTROL: with no sink wired the returned result is identical, so
  // the report is observation and nothing else.
  it('returns the same result with and without a report sink', async () => {
    const withSink = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'primary', result: launchResult({ 'team-lead': member() }) },
      ports(() => undefined)
    );
    const withoutSink = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      { teamName: 'lane-team', laneId: 'primary', result: launchResult({ 'team-lead': member() }) },
      ports()
    );

    expect(withoutSink).toEqual(withSink);
  });
});
