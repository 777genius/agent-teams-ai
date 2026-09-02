import { describe, expect, it, vi } from 'vitest';

import {
  classifyOpenCodePrimaryLeadBootstrap,
  collectOpenCodeAggregateLaneDiagnostics,
  resolveOpenCodeAggregateLaunchStateForLeadBootstrap,
  resolveOpenCodeAggregatePrimaryLeadBootstrap,
  summarizeOpenCodeAggregateLaunchPromotion,
} from '../TeamProvisioningOpenCodeAggregateLaunchPromotion';
import { buildOpenCodeAggregateFinalProgress } from '../TeamProvisioningOpenCodeAggregateRunModel';

import {
  buildFailedOpenCodeLaunchResult,
  buildRetainableOpenCodeLaunchResult,
  buildUncommittedPrimaryLeadLaunchResult,
} from './support/openCodeUncommittedPrimaryLane';

import type { TeamRuntimeLaunchResult } from '../../runtime';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { TeamProvisioningProgress } from '@shared/types';

const launching: TeamProvisioningProgress = {
  runId: 'run-a1',
  teamName: 'lane-team',
  state: 'spawning',
  message: 'Starting OpenCode member runtime lanes',
  startedAt: '2026-08-28T12:18:00.000Z',
  updatedAt: '2026-08-28T12:18:00.000Z',
};

function lane(
  result: TeamRuntimeLaunchResult | null,
  diagnostics: string[] = []
): MixedSecondaryRuntimeLaneState {
  return { result, diagnostics } as unknown as MixedSecondaryRuntimeLaneState;
}

describe('the lead veto is not a blanket fail', () => {
  // NEGATIVE CONTROL, and the first assertion in this file on purpose: the veto
  // only ever fires on the LEAD. A confirmed lead beside two failed side lanes
  // must still be a partial success, exactly as it was before this change.
  it('keeps a confirmed lead with two failed side lanes a partial success', () => {
    const promotion = summarizeOpenCodeAggregateLaunchPromotion({
      launchState: 'partial_failure',
      leadBootstrap: 'confirmed',
      leadName: 'team-lead',
      primaryResult: buildRetainableOpenCodeLaunchResult('team-lead'),
      lanes: [
        lane(buildFailedOpenCodeLaunchResult('Ada', 'runtime binary unreachable')),
        lane(buildFailedOpenCodeLaunchResult('Ben', 'runtime binary unreachable')),
      ],
    });

    expect(promotion.failed).toBe(true);
    expect(promotion.partialTeamCanContinue).toBe(true);
    expect(promotion.terminalFailure).toBe(false);
  });

  it('does not change the final progress of a healthy launch', () => {
    const progress = buildOpenCodeAggregateFinalProgress({
      launching,
      launchState: 'clean_success',
      leadBootstrap: 'confirmed',
      laneDiagnostics: [],
      updatedAt: '2026-08-28T12:20:00.000Z',
    });

    expect(progress).toMatchObject({
      state: 'ready',
      message: 'OpenCode member lanes are ready',
      messageSeverity: undefined,
      configReady: true,
    });
  });
});

describe('classifyOpenCodePrimaryLeadBootstrap', () => {
  it('confirms when the lead claims bootstrap and the commit is not disproven', () => {
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: buildUncommittedPrimaryLeadLaunchResult(),
      })
    ).toBe('confirmed');
  });

  // NEGATIVE CONTROL: absence of evidence is not evidence of absence. A reader
  // that answers `null` (not wired, or the read failed) must never delay or
  // downgrade a launch whose lane already claims confirmation.
  it('confirms when the committed-session read answers null', () => {
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: buildUncommittedPrimaryLeadLaunchResult(),
        committedSessionEvidence: null,
      })
    ).toBe('confirmed');
  });

  it('is pending when the lane holds a runtime handle but no committed session', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult();
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      runtimePid: 4321,
    };
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: result,
        committedSessionEvidence: false,
      })
    ).toBe('pending');
  });

  it('fails when the disk read disproves the claim and nothing materialized', () => {
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: buildUncommittedPrimaryLeadLaunchResult(),
        committedSessionEvidence: false,
      })
    ).toBe('failed');
  });

  it('does not veto when the primary lane returned no entry for the lead at all', () => {
    // An absent entry means the result never went through expected-member
    // normalization; a genuinely failed lead arrives as `failed_to_start`.
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: buildRetainableOpenCodeLaunchResult('Ada'),
      })
    ).toBe('confirmed');
  });

  // The bridge parks the lead on a permission prompt before any session exists:
  // no pid, no session id, `hardFailure: false`. Classifying that as `failed`
  // forces `partial_failure`, and `partialTeamCanContinue` is false for a failed
  // lead - so the healthy side lanes would be torn down while the user is still
  // looking at the permission dialog.
  const permissionBlockedEvidence = {
    launchState: 'runtime_pending_permission' as const,
    bootstrapConfirmed: false,
    runtimeAlive: false,
    livenessKind: 'permission_blocked' as const,
    pendingPermissionRequestIds: ['perm-1'],
  };

  it('defers a permission-blocked lead instead of vetoing the launch', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult();
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      ...permissionBlockedEvidence,
    };
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: result,
        committedSessionEvidence: false,
      })
    ).toBe('pending');
  });

  it('defers on a pending permission request even without the liveness marker', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult();
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      launchState: 'starting',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-1'],
    };
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: result,
        committedSessionEvidence: false,
      })
    ).toBe('pending');
  });

  it('still fails a permission-blocked lead the lane reported as a hard failure', () => {
    const result = buildUncommittedPrimaryLeadLaunchResult();
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      ...permissionBlockedEvidence,
      launchState: 'failed_to_start',
      hardFailure: true,
    };
    expect(
      classifyOpenCodePrimaryLeadBootstrap({
        leadName: 'team-lead',
        primaryResult: result,
        committedSessionEvidence: false,
      })
    ).toBe('failed');
  });

  it('fails when the lead itself is reported as failed_to_start', () => {
    const result = buildRetainableOpenCodeLaunchResult('team-lead');
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'OpenCode model verification completed without assistant output',
    };
    expect(
      classifyOpenCodePrimaryLeadBootstrap({ leadName: 'team-lead', primaryResult: result })
    ).toBe('failed');
  });

  it('has nothing to veto when the primary lane holds no lead', () => {
    expect(classifyOpenCodePrimaryLeadBootstrap({ leadName: null, primaryResult: null })).toBe(
      'confirmed'
    );
  });
});

describe('summarizeOpenCodeAggregateLaunchPromotion', () => {
  it('makes the lead a veto, not a vote', () => {
    // Two healthy side lanes used to be enough to declare the team continuable.
    const promotion = summarizeOpenCodeAggregateLaunchPromotion({
      launchState: 'clean_success',
      leadBootstrap: 'failed',
      leadName: 'team-lead',
      primaryResult: buildUncommittedPrimaryLeadLaunchResult(),
      lanes: [
        lane(buildRetainableOpenCodeLaunchResult('Ada')),
        lane(buildRetainableOpenCodeLaunchResult('Ben')),
      ],
    });

    expect(promotion.failed).toBe(true);
    expect(promotion.partialTeamCanContinue).toBe(false);
    expect(promotion.terminalFailure).toBe(true);
    expect(promotion.terminalFailureError).toBe(
      'OpenCode team lead "team-lead" has no committed runtime session on the primary lane'
    );
  });

  it('prepends the lead reason without swallowing the underlying diagnostic', () => {
    const promotion = summarizeOpenCodeAggregateLaunchPromotion({
      launchState: 'partial_failure',
      leadBootstrap: 'failed',
      leadName: 'team-lead',
      primaryResult: buildFailedOpenCodeLaunchResult('team-lead', 'shared runtime never answered'),
      lanes: [],
    });

    expect(promotion.terminalFailureError).toBe(
      'OpenCode team lead "team-lead" has no committed runtime session on the primary lane: ' +
        'shared runtime never answered'
    );
  });

  it('carries the primary lane diagnostics into the aggregate tail', () => {
    const promotion = summarizeOpenCodeAggregateLaunchPromotion({
      launchState: 'clean_success',
      leadBootstrap: 'confirmed',
      leadName: 'team-lead',
      primaryResult: buildRetainableOpenCodeLaunchResult('team-lead', {
        diagnostics: ['primary lane took 4210 ms'],
      }),
      lanes: [lane(buildRetainableOpenCodeLaunchResult('Ada'), ['Ada lane took 980 ms'])],
    });

    expect(promotion.laneDiagnostics).toEqual([
      'primary: primary lane took 4210 ms',
      'Ada lane took 980 ms',
    ]);
  });
});

describe('collectOpenCodeAggregateLaneDiagnostics', () => {
  it('returns nothing for a launch that produced no diagnostics at all', () => {
    expect(collectOpenCodeAggregateLaneDiagnostics({ primaryResult: null, lanes: [] })).toEqual([]);
  });
});

describe('resolveOpenCodeAggregateLaunchStateForLeadBootstrap', () => {
  it('forces partial_failure for a failed lead', () => {
    expect(resolveOpenCodeAggregateLaunchStateForLeadBootstrap('clean_success', 'failed')).toBe(
      'partial_failure'
    );
  });

  it('forces partial_pending for a pending lead so the run stays active', () => {
    expect(resolveOpenCodeAggregateLaunchStateForLeadBootstrap('clean_success', 'pending')).toBe(
      'partial_pending'
    );
  });

  it('leaves a confirmed lead alone', () => {
    expect(resolveOpenCodeAggregateLaunchStateForLeadBootstrap('clean_success', 'confirmed')).toBe(
      'clean_success'
    );
  });

  it('never upgrades an already partial_failure launch', () => {
    expect(
      resolveOpenCodeAggregateLaunchStateForLeadBootstrap('partial_failure', 'confirmed')
    ).toBe('partial_failure');
  });
});

describe('buildOpenCodeAggregateFinalProgress lead states', () => {
  it('never reports "running with unavailable members" while the lead is unconfirmed', () => {
    const progress = buildOpenCodeAggregateFinalProgress({
      launching,
      launchState: 'partial_failure',
      leadBootstrap: 'failed',
      laneDiagnostics: [],
      updatedAt: '2026-08-28T12:20:00.000Z',
      partialTeamCanContinue: false,
      terminalFailureError: 'lead reason',
    });

    expect(progress.state).toBe('failed');
    expect(progress.configReady).toBe(false);
    expect(progress.message).toBe('OpenCode lead bootstrap failed; the team has no usable lead');
    expect(progress.messageSeverity).toBe('error');
  });

  it('warns while the lead is still waiting for its bootstrap evidence', () => {
    const progress = buildOpenCodeAggregateFinalProgress({
      launching,
      launchState: 'partial_pending',
      leadBootstrap: 'pending',
      laneDiagnostics: [],
      updatedAt: '2026-08-28T12:20:00.000Z',
    });

    expect(progress.state).toBe('ready');
    expect(progress.configReady).toBe(true);
    expect(progress.message).toBe('OpenCode lead is waiting for its runtime bootstrap evidence');
    expect(progress.messageSeverity).toBe('warning');
  });

  it('keeps the pre-existing wording for a launch that carries no lead state', () => {
    const progress = buildOpenCodeAggregateFinalProgress({
      launching,
      launchState: 'partial_failure',
      laneDiagnostics: [],
      updatedAt: '2026-08-28T12:20:00.000Z',
      partialTeamCanContinue: true,
    });

    expect(progress.message).toBe('OpenCode team is running with unavailable members');
    expect(progress.messageSeverity).toBe('warning');
    expect(progress.configReady).toBe(true);
  });
});

describe('resolveOpenCodeAggregatePrimaryLeadBootstrap', () => {
  const params = {
    teamName: 'lane-team',
    runId: 'run-a1',
    effectiveMembers: [{ name: 'team-lead' }, { name: 'Ada' }],
    primaryResult: buildUncommittedPrimaryLeadLaunchResult(),
  };

  it('reads the lead session record for the primary lane only', async () => {
    const read = vi.fn(async () => false);

    const outcome = await resolveOpenCodeAggregatePrimaryLeadBootstrap(params, {
      hasCommittedOpenCodePrimaryLeadSessionEvidence: read,
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      teamName: 'lane-team',
      runId: 'run-a1',
      laneId: 'primary',
      memberName: 'team-lead',
    });
    expect(outcome).toEqual({ state: 'failed', leadName: 'team-lead' });
  });

  // NEGATIVE CONTROL: a throwing read cannot disprove anything, so it must leave
  // a healthy launch alone rather than turning an I/O hiccup into a dead team.
  it('treats a failing disk read as "cannot disprove", never as failure', async () => {
    const outcome = await resolveOpenCodeAggregatePrimaryLeadBootstrap(params, {
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => {
        throw new Error('EBUSY');
      },
    });

    expect(outcome.state).toBe('confirmed');
  });

  // NEGATIVE CONTROL: no reader wired at all is the same "cannot disprove".
  it('confirms when no committed-session reader is wired', async () => {
    expect((await resolveOpenCodeAggregatePrimaryLeadBootstrap(params, {})).state).toBe(
      'confirmed'
    );
  });

  it('never reads for a launch with no lead member', async () => {
    const read = vi.fn(async () => false);

    const outcome = await resolveOpenCodeAggregatePrimaryLeadBootstrap(
      { ...params, effectiveMembers: [{ name: 'Ada' }] },
      { hasCommittedOpenCodePrimaryLeadSessionEvidence: read }
    );

    expect(read).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: 'confirmed', leadName: null });
  });
});
