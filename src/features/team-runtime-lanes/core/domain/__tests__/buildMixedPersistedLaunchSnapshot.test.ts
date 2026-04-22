import { describe, expect, it } from 'vitest';

import { buildMixedPersistedLaunchSnapshot } from '../buildMixedPersistedLaunchSnapshot';

describe('buildMixedPersistedLaunchSnapshot', () => {
  it('records bootstrapExpectedMembers when a secondary lane extends the expected roster', () => {
    const snapshot = buildMixedPersistedLaunchSnapshot({
      teamName: 'mixed-team',
      launchPhase: 'active',
      updatedAt: '2026-04-22T10:00:00.000Z',
      leadDefaults: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedFastMode: 'off',
        resolvedFastMode: false,
        launchIdentity: null,
      },
      primaryMembers: [{ name: 'alice', providerId: 'codex', model: 'gpt-5.4', effort: 'high' }],
      primaryStatuses: {
        alice: {
          launchState: 'confirmed_alive',
          status: 'online',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          livenessSource: 'heartbeat',
          firstSpawnAcceptedAt: '2026-04-22T09:59:00.000Z',
          lastHeartbeatAt: '2026-04-22T09:59:30.000Z',
          updatedAt: '2026-04-22T10:00:00.000Z',
        } as never,
      },
      secondaryMembers: [
        {
          laneId: 'secondary:opencode:bob',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          leadDefaults: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            selectedFastMode: 'off',
            resolvedFastMode: false,
            launchIdentity: null,
          },
          pendingReason: 'Queued for OpenCode secondary lane launch.',
        },
      ],
    });

    expect(snapshot.expectedMembers).toEqual(['alice', 'bob']);
    expect(snapshot.bootstrapExpectedMembers).toEqual(['alice']);
    expect(snapshot.members.alice).toMatchObject({
      laneId: 'primary',
      laneKind: 'primary',
      laneOwnerProviderId: 'codex',
      launchState: 'confirmed_alive',
    });
    expect(snapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
      launchState: 'starting',
    });
    expect(snapshot.summary).toEqual({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(snapshot.teamLaunchState).toBe('partial_pending');
  });

  it('marks the team clean_success once the secondary lane confirms bootstrap', () => {
    const snapshot = buildMixedPersistedLaunchSnapshot({
      teamName: 'mixed-team',
      launchPhase: 'finished',
      updatedAt: '2026-04-22T10:05:00.000Z',
      leadDefaults: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedFastMode: 'off',
        resolvedFastMode: false,
        launchIdentity: null,
      },
      primaryMembers: [{ name: 'alice', providerId: 'codex', model: 'gpt-5.4', effort: 'high' }],
      primaryStatuses: {
        alice: {
          launchState: 'confirmed_alive',
          status: 'online',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          livenessSource: 'heartbeat',
          firstSpawnAcceptedAt: '2026-04-22T10:00:00.000Z',
          lastHeartbeatAt: '2026-04-22T10:01:00.000Z',
          updatedAt: '2026-04-22T10:05:00.000Z',
        } as never,
      },
      secondaryMembers: [
        {
          laneId: 'secondary:opencode:bob',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          leadDefaults: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            selectedFastMode: 'off',
            resolvedFastMode: false,
            launchIdentity: null,
          },
          evidence: {
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            diagnostics: ['spawn accepted', 'late heartbeat received'],
          },
        },
      ],
    });

    expect(snapshot.bootstrapExpectedMembers).toEqual(['alice']);
    expect(snapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(snapshot.summary).toEqual({
      confirmedCount: 2,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(snapshot.teamLaunchState).toBe('clean_success');
  });

  it('keeps a side-lane failure member-scoped instead of flattening it onto primary members', () => {
    const snapshot = buildMixedPersistedLaunchSnapshot({
      teamName: 'mixed-team',
      launchPhase: 'finished',
      updatedAt: '2026-04-22T10:05:00.000Z',
      leadDefaults: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedFastMode: 'off',
        resolvedFastMode: false,
        launchIdentity: null,
      },
      primaryMembers: [{ name: 'alice', providerId: 'codex', model: 'gpt-5.4', effort: 'high' }],
      primaryStatuses: {
        alice: {
          launchState: 'confirmed_alive',
          status: 'online',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          livenessSource: 'heartbeat',
          firstSpawnAcceptedAt: '2026-04-22T10:00:00.000Z',
          lastHeartbeatAt: '2026-04-22T10:01:00.000Z',
          updatedAt: '2026-04-22T10:05:00.000Z',
        } as never,
      },
      secondaryMembers: [
        {
          laneId: 'secondary:opencode:bob',
          member: {
            name: 'bob',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            effort: 'medium',
          },
          leadDefaults: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            selectedFastMode: 'off',
            resolvedFastMode: false,
            launchIdentity: null,
          },
          evidence: {
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'OpenCode side lane failed to attach',
            diagnostics: ['secondary runtime attach failed'],
          },
        },
      ],
    });

    expect(snapshot.members.alice).toMatchObject({
      laneKind: 'primary',
      laneOwnerProviderId: 'codex',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(snapshot.members.bob).toMatchObject({
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'OpenCode side lane failed to attach',
    });
    expect(snapshot.summary).toEqual({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
    });
    expect(snapshot.teamLaunchState).toBe('partial_failure');
  });
});
