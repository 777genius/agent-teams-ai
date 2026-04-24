import {
  buildMemberLaunchPresentation,
  getLaunchAwarePresenceLabel,
  getSpawnAwareDotClass,
  getSpawnAwarePresenceLabel,
  getSpawnCardClass,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
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
