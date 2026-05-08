import {
  buildMemberLaunchPresentation,
  getLaunchAwarePresenceLabel,
  getSpawnAwareDotClass,
  getSpawnAwarePresenceLabel,
  getSpawnCardClass,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
  getMemberRuntimeAdvisoryTone,
  isOpenCodeRelaunchActionable,
  shouldDisplayMemberCurrentTask,
} from '@renderer/utils/memberHelpers';

import type { ResolvedTeamMember } from '@shared/types';

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
      presenceLabel: 'online',
      launchVisualState: null,
      launchStatusLabel: null,
      dotClass: expect.stringContaining('bg-emerald-400'),
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
      presenceLabel: 'online',
      launchVisualState: null,
      launchStatusLabel: null,
      dotClass: expect.stringContaining('bg-emerald-400'),
    });
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

  it('formats raw OpenCode protocol advisory reasons before showing them in titles', () => {
    const advisory = {
      kind: 'api_error' as const,
      observedAt: '2026-04-07T09:00:00.000Z',
      reasonCode: 'protocol_proof_missing' as const,
      message: 'visible_reply_still_required',
    };

    expect(getMemberRuntimeAdvisoryLabel(advisory, 'opencode')).toBe('OpenCode proof missing');
    expect(getMemberRuntimeAdvisoryTone(advisory)).toBe('warning');

    const title = getMemberRuntimeAdvisoryTitle(advisory, 'opencode');

    expect(title).toContain(
      'OpenCode delivery completed without required visible/progress proof.'
    );
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
