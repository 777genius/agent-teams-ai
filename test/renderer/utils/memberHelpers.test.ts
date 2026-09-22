import {
  buildMemberLaunchPresentation,
  getLaunchAwarePresenceLabel,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
  getMemberRuntimeAdvisoryTone,
  getSpawnAwareDotClass,
  getSpawnAwarePresenceLabel,
  getSpawnCardClass,
  isOpenCodeRelaunchActionable,
  shouldDisplayMemberCurrentTask,
} from '@renderer/utils/memberHelpers';

import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
} from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  providerId: 'gemini',
  removedAt: undefined,
};

const provisionedButNotAliveSpawn: MemberSpawnStatusEntry = {
  status: 'error',
  launchState: 'failed_to_start',
  updatedAt: '2026-05-25T20:14:02.147Z',
  runtimeAlive: false,
  bootstrapConfirmed: true,
  hardFailure: true,
  hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
  livenessKind: 'confirmed_bootstrap',
};

const processTableUnavailableRuntime: TeamAgentRuntimeEntry = {
  memberName: 'alice',
  alive: false,
  restartable: true,
  providerId: 'anthropic',
  livenessKind: 'confirmed_bootstrap',
  runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
  runtimeDiagnosticSeverity: 'warning',
  updatedAt: '2026-05-25T20:14:05.411Z',
};

describe('memberHelpers spawn-aware presence', () => {
  it('does not display current task labels for offline or terminal launch states', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: false,
      })
    ).toBe(false);

    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'offline',
        spawnLaunchState: 'confirmed_alive',
        spawnRuntimeAlive: false,
      })
    ).toBe(false);

    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnRuntimeAlive: false,
      })
    ).toBe(false);

    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'error',
        spawnLaunchState: 'failed_to_start',
      })
    ).toBe(false);
  });

  it('does not display current task labels for runtime entries without a live agent runtime', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'stale_metadata',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      })
    ).toBe(false);

    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      })
    ).toBe(false);
  });

  it('keeps current task labels for confirmed online members', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnRuntimeAlive: true,
        runtimeEntry: {
          memberName: 'alice',
          alive: true,
          restartable: true,
          providerId: 'gemini',
          livenessKind: 'confirmed_bootstrap',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      })
    ).toBe(true);
  });

  it('treats bootstrap-confirmed provisioned-but-not-alive entries as active for task display', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnEntry: provisionedButNotAliveSpawn,
        runtimeEntry: processTableUnavailableRuntime,
      })
    ).toBe(true);
  });

  it('treats spawn-only bootstrap-confirmed provisioned-but-not-alive entries as active for task display', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnEntry: provisionedButNotAliveSpawn,
      })
    ).toBe(true);
  });

  it('does not show task activity for provisioned-but-not-alive entries with runtime errors', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnEntry: provisionedButNotAliveSpawn,
        runtimeEntry: {
          ...processTableUnavailableRuntime,
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        },
      })
    ).toBe(false);

    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnEntry: {
          ...provisionedButNotAliveSpawn,
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        },
        runtimeEntry: processTableUnavailableRuntime,
      })
    ).toBe(false);
  });

  it('does not show task activity for unsafe provisioned-but-not-alive runtime candidates', () => {
    expect(
      shouldDisplayMemberCurrentTask({
        member: { ...member, currentTaskId: 'task-1' },
        isTeamAlive: true,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnRuntimeAlive: true,
        spawnEntry: {
          ...provisionedButNotAliveSpawn,
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
        },
        runtimeEntry: {
          ...processTableUnavailableRuntime,
          alive: false,
          livenessKind: 'runtime_process_candidate',
          runtimeDiagnostic:
            'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
        },
      })
    ).toBe(false);
  });

  it('shows process-online teammates as online with a green dot', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        false,
        true,
        false,
        undefined
      )
    ).toBe('online');

    expect(
      getSpawnAwareDotClass(
        member,
        'online',
        'runtime_pending_bootstrap',
        true,
        false,
        true,
        false,
        undefined
      )
    ).toContain('bg-emerald-400');
    expect(
      getSpawnAwareDotClass(
        member,
        'online',
        'runtime_pending_bootstrap',
        true,
        false,
        true,
        false,
        undefined
      )
    ).toContain('animate-pulse');
  });

  it('keeps accepted-but-not-yet-online teammates in starting state', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'waiting',
        'starting',
        undefined,
        false,
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');
  });

  it('labels queued OpenCode lanes separately from active startup', () => {
    const openCodeMember: ResolvedTeamMember = { ...member, providerId: 'opencode' };

    expect(
      buildMemberLaunchPresentation({
        member: openCodeMember,
        spawnStatus: 'waiting',
        spawnLaunchState: 'starting',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeAdvisory: undefined,
        isLaunchSettling: true,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'queued',
      launchVisualState: 'queued',
      launchStatusLabel: 'queued',
      dotClass: expect.stringContaining('bg-zinc-400'),
    });
  });

  it('does not label non-OpenCode waiting lanes as queued', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'waiting',
        spawnLaunchState: 'starting',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeAdvisory: undefined,
        isLaunchSettling: true,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'starting',
      launchVisualState: 'waiting',
      launchStatusLabel: 'waiting to start',
    });
  });

  it('marks long-running starting states as stale without making them failed', () => {
    const presentation = buildMemberLaunchPresentation({
      member,
      spawnStatus: 'waiting',
      spawnLaunchState: 'starting',
      spawnLivenessSource: undefined,
      spawnRuntimeAlive: false,
      spawnUpdatedAt: '2026-05-08T12:00:00.000Z',
      runtimeAdvisory: undefined,
      isLaunchSettling: true,
      isTeamAlive: true,
      isTeamProvisioning: false,
      nowMs: Date.parse('2026-05-08T12:03:00.000Z'),
    });

    expect(presentation.presenceLabel).toBe('starting stale');
    expect(presentation.launchVisualState).toBe('starting_stale');
    expect(presentation.launchStatusLabel).toBe('starting stale');
    expect(presentation.dotClass).toContain('bg-amber-400');
    expect(presentation.dotClass).not.toContain('animate-pulse');
    expect(presentation.cardClass).not.toContain('member-waiting-shimmer');
    expect(presentation.spawnBadgeLabel).toBe('starting stale');
  });

  it('keeps OpenCode runtime evidence states more specific than queued', () => {
    const openCodeMember: ResolvedTeamMember = { ...member, providerId: 'opencode' };

    expect(
      buildMemberLaunchPresentation({
        member: openCodeMember,
        spawnStatus: 'waiting',
        spawnLaunchState: 'starting',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: true,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'registered',
      launchVisualState: 'registered_only',
      launchStatusLabel: 'registered',
    });
  });

  it('keeps starting visuals after provisioning already transitioned out of active state', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'spawning',
        'starting',
        undefined,
        false,
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');

    expect(
      getSpawnAwareDotClass(member, 'spawning', 'starting', false, false, true, false, undefined)
    ).toContain('bg-amber-400');

    expect(getSpawnCardClass('spawning', 'starting', false, false)).toContain(
      'member-waiting-shimmer'
    );
  });

  it('shows offline instead of stale starting visuals when the team is offline', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'spawning',
        'starting',
        undefined,
        false,
        false,
        false,
        false,
        undefined
      )
    ).toBe('offline');

    expect(
      getSpawnAwareDotClass(member, 'spawning', 'starting', false, false, false, false, undefined)
    ).toContain('bg-red-400');

    expect(getSpawnCardClass('spawning', 'starting', false, false, false, false)).toBe('');
  });

  it('keeps runtime-pending teammates in starting state while launch is still settling', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toBe('starting');

    expect(
      getSpawnAwareDotClass(
        member,
        'online',
        'runtime_pending_bootstrap',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toContain('bg-zinc-400');

    expect(
      getSpawnCardClass('online', 'runtime_pending_bootstrap', true, true, true, false)
    ).toContain('member-waiting-shimmer');
  });

  it('shows confirmed teammates as ready instead of idle while launch is still settling', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'confirmed_alive',
        'heartbeat',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toBe('ready');
  });

  it('derives runtime-pending and settling visual states from the same launch inputs', () => {
    const runtimePending = buildMemberLaunchPresentation({
      member,
      spawnStatus: 'online',
      spawnLaunchState: 'runtime_pending_bootstrap',
      spawnLivenessSource: 'process',
      spawnRuntimeAlive: true,
      runtimeAdvisory: undefined,
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    const settling = buildMemberLaunchPresentation({
      member,
      spawnStatus: 'online',
      spawnLaunchState: 'confirmed_alive',
      spawnLivenessSource: 'heartbeat',
      spawnRuntimeAlive: true,
      runtimeAdvisory: undefined,
      isLaunchSettling: true,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(runtimePending.launchVisualState).toBe('runtime_pending');
    expect(runtimePending.launchStatusLabel).toBe('waiting for bootstrap');
    expect(settling.launchVisualState).toBe('settling');
    expect(settling.launchStatusLabel).toBe('joining team');
  });

  it('surfaces permission-blocked teammates as awaiting permission instead of generic starting', () => {
    const permissionPending = buildMemberLaunchPresentation({
      member,
      spawnStatus: 'online',
      spawnLaunchState: 'runtime_pending_permission',
      spawnLivenessSource: 'process',
      spawnRuntimeAlive: true,
      runtimeAdvisory: undefined,
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(permissionPending.presenceLabel).toBe('awaiting permission');
    expect(permissionPending.launchVisualState).toBe('permission_pending');
    expect(permissionPending.launchStatusLabel).toBe('awaiting permission');
    expect(permissionPending.dotClass).toContain('bg-amber-400');
    expect(permissionPending.cardClass).toContain('member-waiting-shimmer');
  });

  it('surfaces bootstrap-stalled OpenCode teammates as actionable pending state', () => {
    const bootstrapStalled = buildMemberLaunchPresentation({
      member: { ...member, providerId: 'opencode' },
      spawnStatus: 'waiting',
      spawnLaunchState: 'runtime_pending_bootstrap',
      spawnLivenessSource: undefined,
      spawnRuntimeAlive: true,
      spawnBootstrapStalled: true,
      runtimeAdvisory: undefined,
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(bootstrapStalled.presenceLabel).toBe('bootstrap stalled');
    expect(bootstrapStalled.launchVisualState).toBe('bootstrap_stalled');
    expect(bootstrapStalled.launchStatusLabel).toBe('bootstrap stalled');
    expect(bootstrapStalled.dotClass).toContain('bg-amber-400');
  });

  it('surfaces strict runtime liveness diagnostics as launch labels', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'waiting',
        spawnLaunchState: 'runtime_pending_bootstrap',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          livenessKind: 'shell_only',
          pidSource: 'tmux_pane',
          runtimeDiagnostic: 'tmux pane foreground command is zsh',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'shell only',
      launchVisualState: 'shell_only',
      launchStatusLabel: 'shell only',
    });

    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'online',
        spawnLaunchState: 'runtime_pending_bootstrap',
        spawnLivenessSource: 'process',
        spawnRuntimeAlive: true,
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          livenessKind: 'runtime_process_candidate',
          runtimeDiagnostic: 'OpenCode runtime process detected, but bootstrap is not confirmed',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'bootstrap unconfirmed',
      launchVisualState: 'runtime_candidate',
      launchStatusLabel: 'bootstrap unconfirmed',
      dotClass: expect.stringContaining('bg-amber-400'),
    });

    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnLivenessSource: 'process',
        spawnRuntimeAlive: true,
        spawnBootstrapConfirmed: true,
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'registered',
      launchVisualState: 'registered_only',
      launchStatusLabel: 'registered',
      dotClass: expect.stringContaining('bg-red-400'),
    });

    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'waiting',
        spawnLaunchState: 'confirmed_alive',
        spawnLivenessSource: 'process',
        spawnRuntimeAlive: true,
        spawnBootstrapConfirmed: true,
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'registered',
      launchVisualState: 'registered_only',
      launchStatusLabel: 'registered',
      dotClass: expect.stringContaining('bg-red-400'),
    });
  });

  it('marks confirmed members offline when spawn runtime liveness is false', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'online',
        spawnLaunchState: 'confirmed_alive',
        spawnLivenessSource: 'process',
        spawnRuntimeAlive: false,
        spawnBootstrapConfirmed: true,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'stale runtime',
      launchVisualState: 'stale_runtime',
      launchStatusLabel: 'stale runtime',
      dotClass: expect.stringContaining('bg-red-400'),
    });
  });

  it('marks dead confirmed runtime entries as stale runtime', () => {
    for (const livenessKind of ['runtime_process', 'confirmed_bootstrap'] as const) {
      expect(
        buildMemberLaunchPresentation({
          member,
          spawnStatus: 'online',
          spawnLaunchState: 'confirmed_alive',
          spawnLivenessSource: 'process',
          spawnRuntimeAlive: true,
          spawnBootstrapConfirmed: true,
          runtimeEntry: {
            memberName: 'alice',
            alive: false,
            restartable: true,
            livenessKind,
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeAdvisory: undefined,
          isLaunchSettling: false,
          isTeamAlive: true,
          isTeamProvisioning: false,
        })
      ).toMatchObject({
        presenceLabel: 'stale runtime',
        launchVisualState: 'stale_runtime',
        launchStatusLabel: 'stale runtime',
        dotClass: expect.stringContaining('bg-red-400'),
      });
    }
  });

  it('marks stuck OpenCode launch states as manually relaunchable', () => {
    const openCodeMember: ResolvedTeamMember = { ...member, providerId: 'opencode' };

    expect(
      isOpenCodeRelaunchActionable({
        member: openCodeMember,
        spawnEntry: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          livenessKind: 'registered_only',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'registered_only',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      })
    ).toBe(true);

    expect(
      isOpenCodeRelaunchActionable({
        member: openCodeMember,
        spawnEntry: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          bootstrapConfirmed: false,
          livenessKind: 'runtime_process_candidate',
          firstSpawnAcceptedAt: '2026-04-24T12:00:00.000Z',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeEntry: {
          memberName: 'alice',
          alive: true,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'runtime_process_candidate',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-24T12:06:00.000Z'),
      })
    ).toBe(true);
  });

  it('marks unsafe provisioned-but-not-alive OpenCode entries as relaunchable', () => {
    expect(
      isOpenCodeRelaunchActionable({
        member: { ...member, providerId: 'opencode' },
        spawnEntry: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      })
    ).toBe(true);

    expect(
      isOpenCodeRelaunchActionable({
        member: { ...member, providerId: 'opencode' },
        spawnEntry: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      })
    ).toBe(true);
  });

  it('does not mark fresh OpenCode runtime candidates as relaunchable', () => {
    expect(
      isOpenCodeRelaunchActionable({
        member: { ...member, providerId: 'opencode' },
        spawnEntry: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          bootstrapConfirmed: false,
          livenessKind: 'runtime_process_candidate',
          firstSpawnAcceptedAt: '2026-04-24T12:00:00.000Z',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeEntry: {
          memberName: 'alice',
          alive: true,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'runtime_process_candidate',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-24T12:01:00.000Z'),
      })
    ).toBe(false);
  });

  it('does not mark fresh OpenCode not-found checks as relaunchable', () => {
    expect(
      isOpenCodeRelaunchActionable({
        member: { ...member, providerId: 'opencode' },
        spawnEntry: {
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          livenessKind: 'not_found',
          firstSpawnAcceptedAt: '2026-04-24T12:00:00.000Z',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'not_found',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-24T12:01:00.000Z'),
      })
    ).toBe(false);

    expect(
      isOpenCodeRelaunchActionable({
        member: { ...member, providerId: 'opencode' },
        runtimeEntry: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          providerId: 'opencode',
          livenessKind: 'not_found',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-24T12:01:00.000Z'),
      })
    ).toBe(false);
  });

  it('returns shared launch status labels without changing generic presence labels', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'waiting',
        spawnLaunchState: 'starting',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'starting',
      launchVisualState: 'waiting',
      launchStatusLabel: 'waiting to start',
    });

    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'spawning',
        spawnLaunchState: 'starting',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'starting',
      launchVisualState: 'spawning',
      launchStatusLabel: 'starting',
    });

    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: 'error',
        spawnLaunchState: 'failed_to_start',
        spawnLivenessSource: undefined,
        spawnRuntimeAlive: false,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'spawn failed',
      launchVisualState: 'error',
      launchStatusLabel: 'failed',
    });
  });

  it('does not render bootstrap-confirmed provisioned-but-not-alive entries as failed or stale', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        runtimeEntry: processTableUnavailableRuntime,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'idle',
      launchVisualState: null,
      launchStatusLabel: null,
      spawnBadgeLabel: null,
    });
  });

  it('does not render spawn-only bootstrap-confirmed provisioned-but-not-alive entries as failed or stale', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'idle',
      launchVisualState: null,
      launchStatusLabel: null,
      spawnBadgeLabel: null,
    });
  });

  it('does not leak safe process-table liveness into healed member visuals', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        runtimeEntry: {
          ...processTableUnavailableRuntime,
          livenessKind: 'registered_only',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'idle',
      launchVisualState: null,
      launchStatusLabel: null,
      spawnBadgeLabel: null,
    });
  });

  it('recognizes provisioned-but-not-alive when the reason is only in runtime diagnostics', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnRuntimeDiagnostic: provisionedButNotAliveSpawn.hardFailureReason,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        runtimeEntry: processTableUnavailableRuntime,
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'idle',
      launchVisualState: null,
      launchStatusLabel: null,
      spawnBadgeLabel: null,
    });
  });

  it('keeps runtime errors visible for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        spawnRuntimeDiagnosticSeverity: provisionedButNotAliveSpawn.runtimeDiagnosticSeverity,
        runtimeEntry: {
          ...processTableUnavailableRuntime,
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
        },
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'spawn failed',
      launchVisualState: 'error',
      launchStatusLabel: 'failed',
      spawnBadgeLabel: 'error',
    });
  });

  it('keeps spawn diagnostic errors visible for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: provisionedButNotAliveSpawn.livenessKind,
        spawnRuntimeDiagnosticSeverity: 'error',
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'spawn failed',
      launchVisualState: 'error',
      launchStatusLabel: 'failed',
    });
  });

  it('keeps stopped runtime evidence failed for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    expect(
      buildMemberLaunchPresentation({
        member,
        spawnStatus: provisionedButNotAliveSpawn.status,
        spawnLaunchState: provisionedButNotAliveSpawn.launchState,
        spawnLivenessSource: provisionedButNotAliveSpawn.livenessSource,
        spawnRuntimeAlive: provisionedButNotAliveSpawn.runtimeAlive,
        spawnBootstrapConfirmed: provisionedButNotAliveSpawn.bootstrapConfirmed,
        spawnBootstrapStalled: provisionedButNotAliveSpawn.bootstrapStalled,
        spawnAgentToolAccepted: provisionedButNotAliveSpawn.agentToolAccepted,
        spawnHardFailure: provisionedButNotAliveSpawn.hardFailure,
        spawnHardFailureReason: provisionedButNotAliveSpawn.hardFailureReason,
        spawnError: provisionedButNotAliveSpawn.error,
        spawnLivenessKind: 'not_found',
        spawnRuntimeDiagnosticSeverity: 'warning',
        runtimeAdvisory: undefined,
        isLaunchSettling: false,
        isTeamAlive: true,
        isTeamProvisioning: false,
      })
    ).toMatchObject({
      presenceLabel: 'spawn failed',
      launchVisualState: 'error',
      launchStatusLabel: 'failed',
      spawnBadgeLabel: 'error',
    });
  });

  it('renders unified retry advisory labels for provider retries', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('Gemini quota retry · 45s');

    expect(
      getMemberRuntimeAdvisoryTitle(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'rate_limited',
          message: 'Gemini cli backend error: rate limit 429.',
        },
        'gemini'
      )
    ).toContain('Gemini rate limited the request');
  });

  it('keeps network advisories provider-neutral and appends raw details to the title', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'network_error',
          message: 'Connection timed out while contacting provider.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('Network retry · 45s');

    expect(
      getMemberRuntimeAdvisoryTitle(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'network_error',
          message: 'Connection timed out while contacting provider.',
        },
        'gemini'
      )
    ).toContain('Connection timed out while contacting provider.');
  });

  it('renders local filesystem advisories as disk space errors', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-04-07T09:00:00.000Z',
      reasonCode: 'filesystem_error' as const,
      message: 'Local disk is full (ENOSPC). Free disk space and retry OpenCode delivery.',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('Disk space error');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'opencode')).toContain(
      'Local disk is full or unavailable.'
    );
  });

  it('renders terminal API errors as errors instead of retrying status', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'api_error',
          observedAt: '2026-04-07T09:00:00.000Z',
          reasonCode: 'auth_error',
          statusCode: 500,
          message: 'API Error: 500 {"error":{"message":"auth_unavailable: no auth available"}}',
        },
        'anthropic',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('Anthropic auth error');

    expect(
      getMemberRuntimeAdvisoryTitle(
        {
          kind: 'api_error',
          observedAt: '2026-04-07T09:00:00.000Z',
          reasonCode: 'auth_error',
          statusCode: 500,
          message: 'auth_unavailable: no auth available',
        },
        'anthropic'
      )
    ).toContain('Anthropic authentication error');
  });

  it('renders timed OpenCode quota errors with retry/reset context', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-17T21:44:34.000Z',
      retryUntil: '2026-05-18T00:00:00.502Z',
      retryDelayMs: 8_126_502,
      reasonCode: 'quota_exhausted' as const,
      message:
        'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.502Z',
    };

    expect(
      getMemberRuntimeAdvisoryLabel(advisory, 'opencode', Date.parse('2026-05-17T21:45:00.000Z'))
    ).toBe('OpenCode quota error · retry 2h 15m');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode quota exhausted.');
    expect(title).toContain('Waiting for OpenCode retry or quota reset around 00:00 UTC.');
    expect(title).toContain('Free usage exceeded');
  });

  it('formats raw OpenCode protocol advisory reasons before showing them in titles', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-04-07T09:00:00.000Z',
      reasonCode: 'protocol_proof_missing' as const,
      message: 'visible_reply_still_required',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode proof missing');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('warning');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');

    expect(title).toContain('OpenCode delivery completed without required visible/progress proof.');
    expect(title).toContain('OpenCode responded, but did not create a visible message_send reply.');
    expect(title).not.toContain('visible_reply_still_required');
  });

  it('hides internal OpenCode bootstrap MCP diagnostics from advisory titles', () => {
    const title = getMemberRuntimeAdvisoryTitle(
      {
        kind: 'api_error',
        observedAt: '2026-04-07T09:00:00.000Z',
        reasonCode: 'backend_error',
        message:
          'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
      },
      'opencode'
    );

    expect(title).toContain('OpenCode runtime delivery did not complete.');
    expect(title).not.toContain('runtime_bootstrap_checkin');
  });

  it('formats unknown OpenCode bridge outcome timeouts as delivery advisory text', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-04-07T09:00:00.000Z',
      reasonCode: 'backend_error' as const,
      message: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode delivery error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');

    expect(title).toContain('OpenCode runtime delivery error.');
    expect(title).toContain('OpenCode bridge outcome unknown after timeout, retrying/observing.');
    expect(title).not.toContain('Network or connectivity error');
    expect(title).not.toContain('opencode_prompt_acceptance_unknown_after_bridge_timeout');
  });

  it.each([
    'session_stale',
    'resolved_behavior_changed:old->new',
    '(resolved_behavior_changed:old->new)',
    'OpenCode API error: resolved_behavior_changed:old->new',
    'resolved_behavior_changed:old.hash/1=abc->new.hash/2=def.',
    'resolved_behavior_changed:tool_error->session_error',
    'resolved_behavior_changed:responded_non_visible_tool->pending',
    'resolved_behavior_changed:permission_blocked->pending',
    'resolved_behavior_changed:old->new opencode_app_mcp_transport_changed:a->b',
    'OpenCode session is stale (resolved_behavior_changed:old->new); reading historical messages for log projection only',
    'opencode_app_mcp_transport_changed:old->new',
    'opencode_prompt_delivery_session_refresh_scheduled',
    'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled',
    'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled.',
    'OpenCode session refresh scheduled after resolved behavior changed',
    'opencode_session_refresh_scheduled_after_resolved_behavior_changed',
    'OpenCode API error. opencode_session_stale_observe_scheduled_after_accepted_prompt',
  ])('renders recoverable OpenCode session refresh advisory %s as a warning', (message) => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message,
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode session refresh');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('warning');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toBe('OpenCode session changed; refreshing the session before retry.');
    expect(title).not.toContain('OpenCode API error');
    expect(title).not.toContain(message);
  });

  it('renders legacy OpenCode session refresh advisories without a reason code as warnings', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      message: 'session_stale',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode session refresh');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('warning');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'opencode')).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not hide real OpenCode API errors that merely mention a refresh marker', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'OpenCode API error. resolved_behavior_changed:old->new permission denied',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('permission denied');
  });

  it('does not strip a generic OpenCode API error prefix without a separator', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'OpenCode API errorresolved_behavior_changed:old->new',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'opencode')).toContain(
      'OpenCode API errorresolved_behavior_changed:old->new'
    );
  });

  it('does not format a refresh-prefixed message with extra failure details as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new permission denied',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('resolved_behavior_changed:old->new permission denied');
    expect(title).not.toBe('OpenCode session changed; refreshing the session before retry.');
  });

  it('does not format refresh markers with unknown extra text as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new unexpected detail',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('unexpected detail');
  });

  it('does not format colon-suffixed refresh failure details as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new:permission_denied',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('resolved_behavior_changed:old->new:permission_denied');
    expect(title).not.toBe('OpenCode session changed; refreshing the session before retry.');
  });

  it('does not format semicolon-attached failure details as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new;permission_denied',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('permission_denied');
  });

  it.each([
    'permission_denied',
    'error',
    'failed',
    'failure',
    'aborted',
    'canceled',
    'cancelled',
    'interrupted',
    'enospc',
  ])('does not let refresh pattern consume directly attached failure token _%s', (suffix) => {
    const message = `resolved_behavior_changed:old->new_${suffix}`;
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message,
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain(message);
  });

  it.each([
    'resolved_behavior_changed:old->new/auth_unavailable',
    'resolved_behavior_changed:old->new permission denied',
    'resolved_behavior_changed:old->new permission_blocked',
    'resolved_behavior_changed:old->new login required',
    'resolved_behavior_changed:old->new not logged in',
    'resolved_behavior_changed:old->new missing credentials',
    'resolved_behavior_changed:old->new access denied',
    'resolved_behavior_changed:old->new 401',
    'resolved_behavior_changed:old->new;key limit exceeded',
    'resolved_behavior_changed:old->new-network_timeout',
    'resolved_behavior_changed:old->new interrupted',
    'resolved_behavior_changed:old->new(non_visible_tool_without_task_progress)',
    'opencode_app_mcp_transport_changed:old->new/permission_denied',
    'opencode_app_mcp_transport_changed:old->new;visible_reply_missing_task_refs',
  ])('keeps separator-attached failure detail as an OpenCode API error for %s', (message) => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message,
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain(message);
  });

  it('still formats clean refresh markers after direct suffix checks', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode session refresh');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('warning');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'opencode')).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not format refresh markers with network failures as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new network timeout',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('network timeout');
  });

  it('does not format refresh markers with auth failures as a clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new auth_unavailable',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('auth_unavailable');
  });

  it.each([
    'OpenCode session is stale (resolved_behavior_changed:old->new); Key limit exceeded (total limit)',
    'OpenCode session is stale (resolved_behavior_changed:old->new); 429 too many requests',
    'OpenCode session is stale (resolved_behavior_changed:old->new); Free usage exceeded, subscribe to Go',
  ])(
    'does not format stale refresh text with quota/rate failures as clean refresh: %s',
    (message) => {
      const advisory = {
        kind: 'api_error' as const,
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error' as const,
        message,
      };

      expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
      expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

      const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
      expect(title).toContain('OpenCode API error.');
      expect(title).toContain(message);
    }
  );

  it('does not format stale refresh text with unknown extra text as clean refresh', () => {
    const message =
      'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail';
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message,
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'opencode')).toContain(message);
  });

  it('does not format stale log-projection text with protocol failures as clean session refresh', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message:
        'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_task_refs',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode API error.');
    expect(title).toContain('visible_reply_missing_task_refs');
  });

  it('does not downgrade action-required OpenCode errors with refresh-looking messages', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'quota_exhausted' as const,
      message: 'resolved_behavior_changed:old->new',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode quota error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'opencode')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');
    expect(title).toContain('OpenCode quota exhausted.');
  });

  it('does not downgrade non-OpenCode backend errors that reuse OpenCode refresh-looking text', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-05-18T08:31:46.075Z',
      reasonCode: 'backend_error' as const,
      message: 'resolved_behavior_changed:old->new',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'anthropic')).toBe('Anthropic API error');
    expect(getMemberRuntimeAdvisoryTone(advisory, 'anthropic')).toBe('error');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'anthropic');
    expect(title).toContain('Anthropic API error.');
    expect(title).toContain('resolved_behavior_changed:old->new');
    expect(title).not.toContain('OpenCode session changed');
  });

  it('formats non-visible tool progress advisory reasons before showing them in titles', () => {
    const title = getMemberRuntimeAdvisoryTitle(
      {
        kind: 'api_error',
        observedAt: '2026-04-07T09:00:00.000Z',
        reasonCode: 'protocol_proof_missing',
        message: 'non_visible_tool_without_task_progress',
      },
      'opencode'
    );

    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'api_error',
          observedAt: '2026-04-07T09:00:00.000Z',
          reasonCode: 'protocol_proof_missing',
          message: 'non_visible_tool_without_task_progress',
        },
        'opencode'
      )
    ).toBe('OpenCode proof missing');
    expect(
      getMemberRuntimeAdvisoryTone({
        kind: 'api_error',
        observedAt: '2026-04-07T09:00:00.000Z',
        reasonCode: 'protocol_proof_missing',
        message: 'non_visible_tool_without_task_progress',
      })
    ).toBe('warning');
    expect(title).toContain(
      'OpenCode used tools, but did not create a visible reply or task progress proof.'
    );
    expect(title).not.toContain('non_visible_tool_without_task_progress');
  });

  it('formats missing taskRefs advisory reasons before showing them in titles', () => {
    const title = getMemberRuntimeAdvisoryTitle(
      {
        kind: 'api_error',
        observedAt: '2026-04-07T09:00:00.000Z',
        reasonCode: 'protocol_proof_missing',
        message: 'visible_reply_missing_task_refs',
      },
      'opencode'
    );

    expect(title).toContain('OpenCode created a reply without the required taskRefs metadata.');
    expect(title).not.toContain('visible_reply_missing_task_refs');
  });

  it('renders Codex native timeout separately from network errors', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-04-07T09:00:00.000Z',
      reasonCode: 'codex_native_timeout' as const,
      message: 'Codex native exec timed out after 120000ms.',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'codex')).toBe('Codex native timeout');
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'codex')).toContain(
      'Codex native mailbox turn timed out'
    );
    expect(getMemberRuntimeAdvisoryTitle(advisory, 'codex')).toContain(
      'Codex native exec timed out after 120000ms.'
    );
  });

  it('marks launch presentation as an error when the runtime has a terminal API error', () => {
    const presentation = buildMemberLaunchPresentation({
      member: { ...member, providerId: 'anthropic' },
      spawnStatus: 'online',
      spawnLaunchState: 'runtime_pending_bootstrap',
      spawnLivenessSource: 'process',
      spawnRuntimeAlive: true,
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-04-07T09:00:00.000Z',
        reasonCode: 'auth_error',
        statusCode: 500,
        message: 'auth_unavailable: no auth available',
      },
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(presentation.presenceLabel).toBe('Anthropic auth error');
    expect(presentation.runtimeAdvisoryTone).toBe('error');
    expect(presentation.dotClass).toContain('bg-red-400');
  });

  it('keeps recoverable OpenCode session refresh presentation out of the terminal error state', () => {
    const presentation = buildMemberLaunchPresentation({
      member: { ...member, providerId: 'opencode' },
      spawnStatus: 'online',
      spawnLaunchState: 'confirmed_alive',
      spawnLivenessSource: 'process',
      spawnRuntimeAlive: true,
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'opencode_app_mcp_transport_changed:old->new',
      },
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(presentation.presenceLabel).toBe('OpenCode session refresh');
    expect(presentation.runtimeAdvisoryLabel).toBe('OpenCode session refresh');
    expect(presentation.runtimeAdvisoryTone).toBe('warning');
    expect(presentation.dotClass).not.toContain('bg-red-400');
  });

  it('keeps recovered OpenCode App MCP connectivity advisory out of the terminal presentation', () => {
    const presentation = buildMemberLaunchPresentation({
      member: { ...member, providerId: 'opencode' },
      spawnStatus: 'online',
      spawnLaunchState: 'confirmed_alive',
      spawnLivenessSource: 'heartbeat',
      spawnRuntimeAlive: true,
      spawnBootstrapConfirmed: true,
      spawnAgentToolAccepted: true,
      spawnHardFailure: false,
      spawnLivenessKind: 'runtime_process',
      runtimeEntry: {
        memberName: 'alice',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        livenessKind: 'runtime_process',
        updatedAt: '2026-05-18T17:21:24.498Z',
      },
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T17:20:36.681Z',
        reasonCode: 'network_error',
        message:
          'OpenCode app MCP was not connected before message delivery (status=attach_failed, connected=null). OpenCode app MCP readiness check failed: Unable to connect.',
      },
      isLaunchSettling: false,
      isTeamAlive: true,
      isTeamProvisioning: false,
    });

    expect(presentation.presenceLabel).not.toContain('OpenCode API error');
    expect(presentation.runtimeAdvisoryLabel).toBeNull();
    expect(presentation.runtimeAdvisoryTone).toBeNull();
    expect(presentation.dotClass).not.toContain('bg-red-400');
  });

  it('falls back to the existing generic retry wording when no structured reason is present', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('retrying now · 45s');
  });

  it('surfaces retry advisory text instead of plain online while bootstrap contact is still pending', () => {
    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toContain('Gemini quota retry');

    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        false,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');
  });

  it('keeps retry advisory visible after contact when the teammate is otherwise just idle or ready', () => {
    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'confirmed_alive',
        'heartbeat',
        true,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toContain('Gemini quota retry');
  });
});
