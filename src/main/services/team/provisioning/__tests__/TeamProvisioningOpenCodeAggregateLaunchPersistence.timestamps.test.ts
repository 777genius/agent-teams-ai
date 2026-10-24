import { afterEach, describe, expect, it, vi } from 'vitest';

import { snapshotToMemberSpawnStatuses } from '../../TeamLaunchStateEvaluator';
import { applyExpiredLaunchGraceToPersistedStatuses } from '../TeamProvisioningMemberSpawnStatusPolicy';
import { persistOpenCodeRuntimeAdapterLaunchResult } from '../TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type { TeamRuntimeLaunchInput, TeamRuntimeLaunchResult } from '../../runtime';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const acceptedAt = '2026-10-10T00:00:00.000Z';

function launchInput(): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    laneId: 'primary',
    teamName: 'TEST-timestamps',
    cwd: '/TEST-project',
    prompt: 'launch',
    providerId: 'opencode',
    skipPermissions: true,
    expectedMembers: [{ name: 'Builder', providerId: 'opencode', cwd: '/TEST-project' }],
    previousLaunchState: null,
  };
}

function pendingResult(): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'TEST-timestamps',
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    warnings: [],
    diagnostics: [],
    members: {
      Builder: {
        memberName: 'Builder',
        providerId: 'opencode',
        sessionId: 'session-1',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        diagnostics: [],
      },
    },
  };
}

async function persist(
  previousLaunchState: PersistedTeamLaunchSnapshot | null,
  result = pendingResult(),
  input = launchInput()
): Promise<PersistedTeamLaunchSnapshot> {
  const persisted = await persistOpenCodeRuntimeAdapterLaunchResult(
    result,
    { ...input, previousLaunchState },
    {
      // Unconfirmed sessions must never invoke the bootstrap evidence store.
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        ({
          teamsBasePath: '/TEST-teams',
          readFileUtf8: vi.fn(),
          mkdirRecursive: vi.fn(),
          readCommittedBootstrapSessionEvidence: vi.fn(),
          getCurrentAgentTeamsMcpHttpTransportEvidence: vi.fn(() => null),
          isFileLockTimeoutError: vi.fn(() => false),
          warn: vi.fn(),
        }) satisfies OpenCodeRuntimeBootstrapEvidencePorts,
      nowIso: () => new Date().toISOString(),
      writeLaunchStateSnapshot: async (_teamName, snapshot) => snapshot,
    }
  );
  return persisted.snapshot;
}

afterEach(() => vi.useRealTimers());

describe('OpenCode primary launch acceptance timestamps', () => {
  it('expires dead, unbootstrapped sessions after 120s despite 2.5s status refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(acceptedAt);
    let snapshot = await persist(null);
    for (let poll = 1; poll <= 48; poll += 1) {
      vi.setSystemTime(Date.parse(acceptedAt) + poll * 2_500);
      snapshot = await persist(snapshot);
      const statuses = snapshotToMemberSpawnStatuses(snapshot);
      applyExpiredLaunchGraceToPersistedStatuses(statuses, Date.now());
      expect(statuses.Builder.hardFailure, `poll ${poll}`).toBe(poll === 48);
      if (poll === 48) {
        expect(statuses.Builder).toMatchObject({
          status: 'error',
          launchState: 'failed_to_start',
        });
      }
    }
    expect(snapshot.members.Builder.firstSpawnAcceptedAt).toBe(acceptedAt);
    expect(snapshot.members.Builder.lastEvaluatedAt).toBe('2026-10-10T00:02:00.000Z');
  });

  it.each(['launch state', 'request ids', 'both'])(
    'starts a fresh grace window after late approval (%s)',
    async (permissionMarker) => {
      vi.useFakeTimers();
      vi.setSystemTime(acceptedAt);
      let snapshot = await persist(null);
      const blocked = pendingResult();
      if (permissionMarker !== 'request ids') {
        blocked.members.Builder.launchState = 'runtime_pending_permission';
      }
      if (permissionMarker !== 'launch state') {
        blocked.members.Builder.pendingPermissionRequestIds = ['permission-1'];
      }
      for (let poll = 1; poll <= 40; poll += 1) {
        vi.setSystemTime(Date.parse(acceptedAt) + poll * 5_000);
        snapshot = await persist(snapshot, blocked);
        const statuses = snapshotToMemberSpawnStatuses(snapshot);
        applyExpiredLaunchGraceToPersistedStatuses(statuses, Date.now());
        expect(statuses.Builder.hardFailure).toBe(false);
      }
      const approvedAtMs = Date.parse(acceptedAt) + 205_000;
      vi.setSystemTime(approvedAtMs);
      snapshot = await persist(snapshot);
      const approvedStatuses = snapshotToMemberSpawnStatuses(snapshot);
      applyExpiredLaunchGraceToPersistedStatuses(approvedStatuses, Date.now());
      expect(approvedStatuses.Builder.hardFailure).toBe(false);
      expect(snapshot.members.Builder.firstSpawnAcceptedAt).toBe(
        new Date(approvedAtMs).toISOString()
      );
      for (let poll = 1; poll <= 48; poll += 1) {
        vi.setSystemTime(approvedAtMs + poll * 2_500);
        snapshot = await persist(snapshot);
        const statuses = snapshotToMemberSpawnStatuses(snapshot);
        applyExpiredLaunchGraceToPersistedStatuses(statuses, Date.now());
        expect(statuses.Builder.hardFailure, `post-approval poll ${poll}`).toBe(poll === 48);
      }
    }
  );

  it.each([
    [
      'run',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.runtimeRunId = 'older-run';
      },
    ],
    [
      'session',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.runtimeSessionId = 'older-session';
      },
    ],
    [
      'member',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.name = 'Other';
      },
    ],
    [
      'lane',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.laneId = 'secondary-lane';
      },
    ],
    [
      'lane kind',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.laneKind = 'secondary';
      },
    ],
    [
      'provider',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.providerId = 'anthropic';
      },
    ],
    [
      'team',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.teamName = 'Other-team';
      },
    ],
    [
      'invalid timestamp',
      (snapshot: PersistedTeamLaunchSnapshot) => {
        snapshot.members.Builder.firstSpawnAcceptedAt = 'invalid';
      },
    ],
  ])(
    'starts fresh when the previous %s does not identify this incarnation',
    async (_label, change) => {
      vi.useFakeTimers();
      vi.setSystemTime(acceptedAt);
      const previous = await persist(null);
      change(previous);
      vi.setSystemTime('2026-10-10T00:02:00.000Z');
      const snapshot = await persist(previous);
      expect(snapshot.members.Builder.firstSpawnAcceptedAt).toBe(new Date().toISOString());
      const statuses = snapshotToMemberSpawnStatuses(snapshot);
      applyExpiredLaunchGraceToPersistedStatuses(statuses, Date.now());
      expect(statuses.Builder.hardFailure).toBe(false);
    }
  );

  it('updates latest runtime observations while retaining the original acceptance time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(acceptedAt);
    const previous = await persist(null);
    vi.setSystemTime('2026-10-10T00:01:00.000Z');
    const result = pendingResult();
    result.members.Builder.runtimeAlive = true;
    const snapshot = await persist(previous, result);
    expect(snapshot.members.Builder).toMatchObject({
      firstSpawnAcceptedAt: acceptedAt,
      runtimeLastSeenAt: '2026-10-10T00:01:00.000Z',
      lastRuntimeAliveAt: '2026-10-10T00:01:00.000Z',
      lastEvaluatedAt: '2026-10-10T00:01:00.000Z',
    });
  });
});
