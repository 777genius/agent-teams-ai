import {
  buildMissingOpenCodeSessionRecordDiagnostic,
  guardCommittedOpenCodeLaneEvidence,
  guardCommittedOpenCodeSecondaryLaneEvidence,
} from '@main/services/team/provisioning/TeamProvisioningLaunchStateReconciliation';
import { describe, expect, it, vi } from 'vitest';

import type { GuardCommittedOpenCodeSecondaryLaneEvidencePorts } from '@main/services/team/provisioning/TeamProvisioningLaunchStateReconciliation';
import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '@main/services/team/runtime/TeamRuntimeAdapter';

function member(
  memberName: string,
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName,
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    sessionId: `session-${memberName}`,
    livenessKind: 'confirmed_bootstrap',
    diagnostics: [],
    ...overrides,
  };
}

function launchResult(members: TeamRuntimeMemberLaunchEvidence[]): TeamRuntimeLaunchResult {
  return {
    runId: 'run-a1',
    teamName: 'lane-team',
    launchPhase: 'active',
    teamLaunchState: 'clean_success',
    members: Object.fromEntries(members.map((entry) => [entry.memberName, entry])),
    warnings: [],
    diagnostics: [],
  };
}

function ports(
  overrides: Partial<GuardCommittedOpenCodeSecondaryLaneEvidencePorts> = {}
): GuardCommittedOpenCodeSecondaryLaneEvidencePorts {
  return {
    commitOpenCodeRuntimeAdapterLaunchSessionEvidence: vi.fn(({ result }) =>
      Promise.resolve(result)
    ),
    inspectOpenCodeRuntimeLaneStorage: vi.fn(() =>
      Promise.resolve({
        // A teammate already committed, so the LANE flag is true. This is the
        // masking the per-member reader exists to defeat.
        hasRuntimeEvidenceOnDisk: true,
        manifestEntryCount: 1,
        manifestUpdatedAt: '2026-08-28T12:20:00.000Z',
        fileNames: ['opencode-sessions.json', 'manifest.json'],
      })
    ),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(() => Promise.resolve()),
    logWarn: vi.fn(),
    ...overrides,
  };
}

describe('the promotion gate reads per member, not per lane', () => {
  it('downgrades a lead a committed teammate was masking', async () => {
    const upsert = vi.fn(() => Promise.resolve());

    const guarded = await guardCommittedOpenCodeLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'primary',
        memberNames: ['team-lead', 'Ada'],
        result: launchResult([member('team-lead'), member('Ada')]),
      },
      ports({
        upsertOpenCodeRuntimeLaneIndexEntry: upsert,
        hasCommittedOpenCodeLaneMemberSessionEvidence: ({ memberName }) =>
          Promise.resolve(memberName !== 'team-lead'),
      })
    );

    expect(guarded.members['team-lead']?.launchState).toBe('runtime_pending_bootstrap');
    expect(guarded.members['team-lead']?.bootstrapConfirmed).toBe(false);
    // Ada committed and is left exactly as she was.
    expect(guarded.members.Ada?.launchState).toBe('confirmed_alive');
    expect(guarded.members.Ada?.diagnostics).toEqual([]);
    expect(guarded.teamLaunchState).toBe('partial_pending');
    expect(guarded.diagnostics).toContain(buildMissingOpenCodeSessionRecordDiagnostic('team-lead'));
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('names only the member it is about in that member evidence', async () => {
    const guarded = await guardCommittedOpenCodeLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'primary',
        memberNames: ['team-lead', 'Ada'],
        result: launchResult([member('team-lead'), member('Ada')]),
      },
      ports({ hasCommittedOpenCodeLaneMemberSessionEvidence: () => Promise.resolve(false) })
    );

    expect(guarded.members['team-lead']?.diagnostics).toContain(
      buildMissingOpenCodeSessionRecordDiagnostic('team-lead')
    );
    expect(guarded.members['team-lead']?.diagnostics).not.toContain(
      buildMissingOpenCodeSessionRecordDiagnostic('Ada')
    );
    expect(guarded.members.Ada?.diagnostics).toContain(
      buildMissingOpenCodeSessionRecordDiagnostic('Ada')
    );
    expect(guarded.members.Ada?.diagnostics).not.toContain(
      buildMissingOpenCodeSessionRecordDiagnostic('team-lead')
    );
  });

  // NEGATIVE CONTROL: absence of evidence is not evidence of absence. A reader
  // that throws cannot disprove anything and must never downgrade a member.
  it('leaves every member alone when the per-member read throws', async () => {
    const result = launchResult([member('team-lead'), member('Ada')]);

    const guarded = await guardCommittedOpenCodeLaneEvidence(
      { teamName: 'lane-team', laneId: 'primary', memberNames: ['team-lead', 'Ada'], result },
      ports({
        hasCommittedOpenCodeLaneMemberSessionEvidence: () => Promise.reject(new Error('EBUSY')),
      })
    );

    expect(guarded.members['team-lead']?.launchState).toBe('confirmed_alive');
    expect(guarded.members.Ada?.launchState).toBe('confirmed_alive');
    expect(guarded.teamLaunchState).toBe('clean_success');
  });

  // NEGATIVE CONTROL: with no per-member reader wired the gate falls back to
  // the lane flag, which is exactly what it did before this change.
  it('falls back to the lane flag when no per-member reader is wired', async () => {
    const withEvidence = await guardCommittedOpenCodeLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'primary',
        memberNames: ['team-lead'],
        result: launchResult([member('team-lead')]),
      },
      ports()
    );
    expect(withEvidence.members['team-lead']?.launchState).toBe('confirmed_alive');

    const withoutEvidence = await guardCommittedOpenCodeLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'primary',
        memberNames: ['team-lead'],
        result: launchResult([member('team-lead')]),
      },
      ports({
        inspectOpenCodeRuntimeLaneStorage: vi.fn(() =>
          Promise.resolve({
            hasRuntimeEvidenceOnDisk: false,
            manifestEntryCount: 0,
            manifestUpdatedAt: null,
            fileNames: [],
          })
        ),
      })
    );
    expect(withoutEvidence.members['team-lead']?.launchState).toBe('runtime_pending_bootstrap');
  });

  // NEGATIVE CONTROL: a member that never claimed confirmation is not this
  // gate's business, and the gate must not even commit for it.
  it('does nothing at all when no named member claims confirmation', async () => {
    const commit = vi.fn(({ result }: { result: TeamRuntimeLaunchResult }) =>
      Promise.resolve(result)
    );
    const result = launchResult([
      member('team-lead', {
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        livenessKind: undefined,
        sessionId: undefined,
      }),
    ]);

    const guarded = await guardCommittedOpenCodeLaneEvidence(
      { teamName: 'lane-team', laneId: 'primary', memberNames: ['team-lead'], result },
      ports({
        commitOpenCodeRuntimeAdapterLaunchSessionEvidence: commit,
        hasCommittedOpenCodeLaneMemberSessionEvidence: () => Promise.resolve(false),
      })
    );

    expect(guarded).toBe(result);
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores members that are not named in the guard call', async () => {
    const guarded = await guardCommittedOpenCodeLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'primary',
        memberNames: ['Ada'],
        result: launchResult([member('team-lead'), member('Ada')]),
      },
      ports({
        hasCommittedOpenCodeLaneMemberSessionEvidence: ({ memberName }) =>
          Promise.resolve(memberName !== 'team-lead'),
      })
    );

    expect(guarded.members['team-lead']?.launchState).toBe('confirmed_alive');
    expect(guarded.members.Ada?.launchState).toBe('confirmed_alive');
  });
});

describe('the secondary-lane guard keeps its single-member contract', () => {
  it('delegates to the lane guard with exactly one member name', async () => {
    const laneStorage = vi.fn(() =>
      Promise.resolve({
        hasRuntimeEvidenceOnDisk: false,
        manifestEntryCount: 0,
        manifestUpdatedAt: null,
        fileNames: [],
      })
    );

    const guarded = await guardCommittedOpenCodeSecondaryLaneEvidence(
      {
        teamName: 'lane-team',
        laneId: 'secondary:opencode:ada',
        memberName: 'Ada',
        result: launchResult([member('Ada')]),
      },
      ports({ inspectOpenCodeRuntimeLaneStorage: laneStorage })
    );

    expect(guarded.members.Ada?.launchState).toBe('runtime_pending_bootstrap');
    expect(laneStorage).toHaveBeenCalledWith({
      teamName: 'lane-team',
      laneId: 'secondary:opencode:ada',
    });
  });

  it('returns the result untouched when the lane holds no entry for the member', async () => {
    const result = launchResult([member('Ada')]);

    expect(
      await guardCommittedOpenCodeSecondaryLaneEvidence(
        {
          teamName: 'lane-team',
          laneId: 'secondary:opencode:ben',
          memberName: 'Ben',
          result,
        },
        ports()
      )
    ).toBe(result);
  });
});
