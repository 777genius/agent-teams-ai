import {
  buildMemberLaunchDiagnosticsPayload,
  buildTeamMemberLaunchDiagnosticsPayloads,
  formatMemberLaunchDiagnosticsPayload,
  getMemberLaunchDiagnosticsErrorMessage,
  hasMemberLaunchDiagnosticsDetails,
  hasMemberLaunchDiagnosticsError,
} from '@renderer/utils/memberLaunchDiagnostics';
import { describe, expect, it } from 'vitest';

describe('member launch diagnostics', () => {
  it('builds a bounded copy payload from spawn and runtime evidence', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'demo-team',
      runId: 'run-42',
      memberName: 'bob',
      spawnEntry: {
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        agentToolAccepted: true,
        livenessKind: 'shell_only',
        livenessSource: 'process',
        runtimeDiagnostic: 'tmux pane foreground command is zsh',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-04-24T12:00:00.000Z',
      },
      runtimeEntry: {
        memberName: 'bob',
        alive: false,
        restartable: true,
        pid: 26676,
        pidSource: 'tmux_pane',
        paneId: '%42',
        panePid: 26676,
        paneCurrentCommand: 'zsh',
        processCommand: 'node runtime --token super-secret --team-name demo-team',
        diagnostics: ['tmux pane foreground command is zsh', 'no runtime child found'],
        updatedAt: '2026-04-24T12:00:01.000Z',
      },
    });

    expect(payload).toMatchObject({
      teamName: 'demo-team',
      runId: 'run-42',
      memberName: 'bob',
      launchState: 'runtime_pending_bootstrap',
      spawnStatus: 'waiting',
      livenessKind: 'shell_only',
      pid: 26676,
      pidSource: 'tmux_pane',
      paneCurrentCommand: 'zsh',
      runtimeDiagnostic: 'tmux pane foreground command is zsh',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(payload.processCommand).toContain('--token [redacted]');
    expect(payload.processCommand).not.toContain('super-secret');
    expect(payload.diagnostics).toEqual([
      'tmux pane foreground command is zsh',
      'no runtime child found',
    ]);
    expect(hasMemberLaunchDiagnosticsDetails(payload)).toBe(true);
    expect(formatMemberLaunchDiagnosticsPayload(payload)).toContain('"livenessKind": "shell_only"');
  });

  it('includes the exact normalized member card error in copy diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'jack',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason:
          'Latest assistant message msg_123 failed with APIError - OpenCode quota exhausted. Visit https://openrouter.ai/settings/keys',
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-08T12:00:00.000Z',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode quota exhausted. Visit https://openrouter.ai/settings/keys'
    );
    expect(payload.diagnostics?.[0]).toBe(
      'OpenCode quota exhausted. Visit https://openrouter.ai/settings/keys'
    );
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBe(
      'OpenCode quota exhausted. Visit https://openrouter.ai/settings/keys'
    );
    expect(formatMemberLaunchDiagnosticsPayload(payload)).toContain('"memberCardError"');
  });

  it('does not surface post-stop stale runtime warnings as confirmed member card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'forge-labs-11',
      runId: 'e90c7699-54d7-449e-8a4a-6a3276396926',
      memberName: 'tom',
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: false,
        livenessKind: 'confirmed_bootstrap',
        updatedAt: '2026-05-24T12:04:48.900Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'stale_metadata',
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-24T12:04:48.900Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
    expect(payload.runtimeDiagnostic).toBe('persisted runtime pid is not alive');
  });

  it('does not surface bootstrap-confirmed provisioned-but-not-alive entries as card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:03.317Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'confirmed_alive',
      spawnStatus: 'online',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(payload.memberCardError).toBeUndefined();
    expect(payload.probableCause).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('does not surface spawn-only safe bootstrap-confirmed provisioned-but-not-alive entries as card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'confirmed_alive',
      spawnStatus: 'online',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('keeps runtime errors visible for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'Runtime process crashed',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-25T20:14:03.317Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'failed_to_start',
      spawnStatus: 'error',
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: true,
      memberCardError: 'Runtime process crashed',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
    });
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBe('Runtime process crashed');
  });

  it('keeps spawn errors visible when runtime evidence is only warning severity', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'Runtime process crashed',
        runtimeDiagnosticSeverity: 'error',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:03.317Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'failed_to_start',
      spawnStatus: 'error',
      runtimeAlive: false,
      hardFailure: true,
      memberCardError: 'Runtime process crashed',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
    });
    expect(payload.diagnostics).toContain('Runtime process crashed');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps spawn diagnostics for bootstrap-confirmed provisioned-but-not-alive entries without runtime evidence', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic: 'Runtime process crashed',
        runtimeDiagnosticSeverity: 'error',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'failed_to_start',
      spawnStatus: 'error',
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: true,
      memberCardError: 'Runtime process crashed',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
    });
    expect(payload.diagnostics).toContain('Runtime process crashed');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('does not heal stopped liveness evidence for bootstrap-confirmed provisioned-but-not-alive entries', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'not_found',
        runtimeDiagnostic: 'Runtime is no longer registered',
        runtimeDiagnosticSeverity: 'warning',
        firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
        lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'failed_to_start',
      spawnStatus: 'error',
      runtimeAlive: false,
      hardFailure: true,
      runtimeDiagnostic: 'Runtime is no longer registered',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('keeps unsafe spawn diagnostics over benign runtime warnings for provisioned-but-not-alive entries', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'not_found',
        runtimeDiagnostic: 'Runtime is no longer registered',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:03.317Z',
      },
    });

    expect(payload).toMatchObject({
      launchState: 'failed_to_start',
      spawnStatus: 'error',
      runtimeAlive: false,
      hardFailure: true,
      runtimeDiagnostic: 'Runtime is no longer registered',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(payload.diagnostics).toContain('Runtime is no longer registered');
  });

  it('prefers stopped runtime liveness over stale spawn liveness in copy diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'bb64da3b-ed5e-4bae-813d-70e26418f9e5',
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: true,
        hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
        livenessKind: 'confirmed_bootstrap',
        runtimeDiagnostic:
          'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:02.147Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        alive: false,
        restartable: true,
        livenessKind: 'not_found',
        runtimeDiagnostic: 'Runtime is no longer registered',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-25T20:14:03.317Z',
      },
    });

    expect(payload).toMatchObject({
      livenessKind: 'not_found',
      runtimeAlive: false,
      runtimeDiagnostic: 'Runtime is no longer registered',
    });
  });

  it('prefers newer healed snapshots over unsafe live provisioned-but-not-alive diagnostics', () => {
    const [payload] = buildTeamMemberLaunchDiagnosticsPayloads({
      teamName: 'signal-ops',
      runId: 'run-42',
      members: [{ name: 'tom', providerId: 'anthropic' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberSpawnSnapshot: {
        updatedAt: '2026-05-25T20:14:10.000Z',
        statuses: {
          tom: {
            status: 'online',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            livenessKind: 'confirmed_bootstrap',
            updatedAt: '2026-05-25T20:14:10.000Z',
          },
        },
      },
    });

    expect(payload).toMatchObject({
      memberName: 'tom',
      launchState: 'confirmed_alive',
      spawnStatus: 'online',
      runtimeAlive: true,
      hardFailure: false,
    });
  });

  it('includes runtime advisory evidence in copy diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'alice',
      runtimeAdvisoryLabel: 'OpenCode delivery error',
      runtimeAdvisoryTitle: 'OpenCode accepted the prompt, but no assistant turn was recorded.',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-17T22:11:38.239Z',
        reasonCode: 'backend_error',
        message: 'OpenCode accepted the prompt, but no assistant turn was recorded.',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode accepted the prompt, but no assistant turn was recorded.'
    );
    expect(payload.runtimeAdvisoryKind).toBe('api_error');
    expect(payload.runtimeAdvisoryReasonCode).toBe('backend_error');
    expect(payload.diagnostics).toContain(
      'OpenCode accepted the prompt, but no assistant turn was recorded.'
    );
    expect(hasMemberLaunchDiagnosticsDetails(payload)).toBe(true);
  });

  it('does not turn healthy info liveness diagnostics into member card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'atlas-hq-5',
      runId: '5a9ee2e5-a8cb-4559-b624-0dbf13ee4d11',
      memberName: 'atlas',
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        agentToolAccepted: true,
        livenessKind: 'runtime_process',
        livenessSource: 'heartbeat',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'atlas',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        diagnostics: [
          'OpenCode runtime process detected after bootstrap confirmation',
          'matched OpenCode runtime pid and process identity',
          'bootstrap confirmed',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.runtimeDiagnostic).toBe(
      'OpenCode runtime process detected after bootstrap confirmation'
    );
    expect(payload.runtimeDiagnosticSeverity).toBe('info');
    expect(payload.diagnostics).toContain(
      'OpenCode runtime process detected after bootstrap confirmation'
    );
  });

  it('does not turn info runtime diagnostics into member card errors even on terminal launch state', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'atlas',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'atlas',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.runtimeDiagnosticSeverity).toBe('info');
  });

  it('prefers advisory errors over healthy info liveness diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'atlas',
      runtimeAdvisoryLabel: 'OpenCode delivery error',
      runtimeAdvisoryTitle:
        'OpenCode runtime delivery error. OpenCode accepted the prompt, but no assistant turn was recorded.',
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'OpenCode accepted the prompt, but no assistant turn was recorded.',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode runtime delivery error. OpenCode accepted the prompt, but no assistant turn was recorded.'
    );
    expect(payload.memberCardError).not.toBe(
      'OpenCode runtime process detected after bootstrap confirmation'
    );
  });

  it('does not surface recovered OpenCode App MCP connectivity advisory as card error', () => {
    const appMcpMessage =
      'OpenCode app MCP was not connected before message delivery (status=attach_failed, connected=null). OpenCode app MCP readiness check failed: Unable to connect. Is the computer able to access the url?';
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'bob',
      member: { name: 'bob', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode API error',
      runtimeAdvisoryTitle: `Network or connectivity error. ${appMcpMessage}`,
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        agentToolAccepted: true,
        hardFailure: false,
        livenessKind: 'runtime_process',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T17:15:34.482Z',
      },
      runtimeEntry: {
        memberName: 'bob',
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
        message: appMcpMessage,
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(payload.runtimeAdvisoryReasonCode).toBe('network_error');
    expect(payload.diagnostics).toContain(appMcpMessage);
  });

  it('keeps OpenCode App MCP connectivity advisory as error when health is not clean', () => {
    const appMcpMessage =
      'OpenCode app MCP was not connected before message delivery (status=attach_failed, connected=null). OpenCode app MCP readiness check failed: Unable to connect.';

    for (const spawnEntry of [
      {
        status: 'online' as const,
        launchState: 'confirmed_alive' as const,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        agentToolAccepted: true,
        hardFailure: true,
        updatedAt: '2026-05-18T17:15:34.482Z',
      },
      {
        status: 'error' as const,
        launchState: 'failed_to_start' as const,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        agentToolAccepted: true,
        hardFailure: false,
        updatedAt: '2026-05-18T17:15:34.482Z',
      },
    ]) {
      const payload = buildMemberLaunchDiagnosticsPayload({
        memberName: 'bob',
        member: { name: 'bob', providerId: 'opencode' },
        runtimeAdvisoryLabel: 'OpenCode API error',
        runtimeAdvisoryTitle: `Network or connectivity error. ${appMcpMessage}`,
        spawnEntry,
        runtimeAdvisory: {
          kind: 'api_error',
          observedAt: '2026-05-18T17:20:36.681Z',
          reasonCode: 'network_error',
          message: appMcpMessage,
        },
      });

      expect(payload.memberCardError).toBe(`Network or connectivity error. ${appMcpMessage}`);
      expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
    }
  });

  it.each([
    [
      'quota_exhausted' as const,
      'OpenCode quota exhausted.',
      'Free usage exceeded, subscribe to Go',
    ],
    ['auth_error' as const, 'OpenCode authentication issue.', 'authentication_failed'],
    ['rate_limited' as const, 'OpenCode rate limited the request.', '429 rate limited'],
  ])(
    'keeps OpenCode %s advisory as card error on healthy members',
    (reasonCode, title, message) => {
      const payload = buildMemberLaunchDiagnosticsPayload({
        memberName: 'bob',
        member: { name: 'bob', providerId: 'opencode' },
        runtimeAdvisoryLabel: 'OpenCode API error',
        runtimeAdvisoryTitle: title,
        spawnEntry: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          agentToolAccepted: true,
          hardFailure: false,
          livenessKind: 'runtime_process',
          updatedAt: '2026-05-18T17:15:34.482Z',
        },
        runtimeAdvisory: {
          kind: 'api_error',
          observedAt: '2026-05-18T17:20:36.681Z',
          reasonCode,
          message,
        },
      });

      expect(payload.memberCardError).toBe(title);
      expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
    }
  );

  it('does not suppress non-OpenCode App MCP connectivity advisory', () => {
    const appMcpMessage =
      'OpenCode app MCP was not connected before message delivery (status=attach_failed, connected=null). OpenCode app MCP readiness check failed: Unable to connect.';
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'claude',
      member: { name: 'claude', providerId: 'anthropic' },
      runtimeAdvisoryLabel: 'Anthropic API error',
      runtimeAdvisoryTitle: `Network or connectivity error. ${appMcpMessage}`,
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        agentToolAccepted: true,
        hardFailure: false,
        livenessKind: 'runtime_process',
        updatedAt: '2026-05-18T17:15:34.482Z',
      },
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T17:20:36.681Z',
        reasonCode: 'network_error',
        message: appMcpMessage,
      },
    });

    expect(payload.memberCardError).toBe(`Network or connectivity error. ${appMcpMessage}`);
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('does not surface recoverable OpenCode session refresh advisory as card error', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode session refresh',
      runtimeAdvisoryTitle: 'OpenCode session changed; refreshing the session before retry.',
      spawnEntry: {
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
        runtimeDiagnosticSeverity: 'info',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'OpenCode session changed; refreshing the session before retry.',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.diagnostics).toContain(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not surface recoverable OpenCode transport refresh advisory as card error', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode session refresh',
      runtimeAdvisoryTitle: 'OpenCode session changed; refreshing the session before retry.',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'opencode_app_mcp_transport_changed:old->new',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
  });

  it('does not surface legacy OpenCode refresh scheduled advisory as card error', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode session refresh',
      runtimeAdvisoryTitle: 'OpenCode session changed; refreshing the session before retry.',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled.',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('suppresses generic OpenCode advisory card errors when clean refresh evidence is present', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode API error',
      runtimeAdvisoryTitle: 'OpenCode API error',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'OpenCode API error',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('treats member card errors from runtime advisory as diagnostics errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode API error',
      runtimeAdvisoryTitle: 'OpenCode API error',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message:
          'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled permission denied',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBe('OpenCode API error');
  });

  it('does not treat OpenCode response-state names inside refresh markers as card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:permission_blocked->pending',
        hardFailureReason: 'OpenCode API error',
        runtimeDiagnostic: 'resolved_behavior_changed:responded_non_visible_tool->pending',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        runtimeDiagnostic: 'resolved_behavior_changed:responded_non_visible_tool->pending',
        runtimeDiagnosticSeverity: 'error',
        diagnostics: ['resolved_behavior_changed:tool_error->session_error'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('does not treat multiple clean OpenCode refresh markers in one diagnostic as card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error:
          'OpenCode API error. resolved_behavior_changed:old->new opencode_app_mcp_transport_changed:a->b',
        runtimeDiagnostic:
          'resolved_behavior_changed:old->new opencode_app_mcp_transport_changed:a->b',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('does not surface recoverable OpenCode refresh text from stale spawn errors as card error', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new',
        hardFailureReason: 'OpenCode API error',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        runtimeDiagnostic: 'opencode_session_refresh_scheduled_after_resolved_behavior_changed',
        runtimeDiagnosticSeverity: 'error',
        diagnostics: ['resolved_behavior_changed:old->new'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.diagnostics).toContain('resolved_behavior_changed:old->new');
    expect(payload.diagnosticHints).toBeUndefined();
    expect(payload.probableCause).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('treats parenthesized clean OpenCode refresh markers as recoverable UI diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. (resolved_behavior_changed:old->new)',
        hardFailureReason: 'OpenCode API error:',
        runtimeDiagnostic: '(opencode_app_mcp_transport_changed:old->new)',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('keeps malformed generic OpenCode API error prefixes as card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API errorresolved_behavior_changed:old->new',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API errorresolved_behavior_changed:old->new');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('suppresses card error when all stale spawn failure fields are recoverable refresh diagnostics', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new',
        hardFailureReason: 'opencode_session_refresh_scheduled_after_resolved_behavior_changed',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.diagnostics).toContain('OpenCode API error. resolved_behavior_changed:old->new');
    expect(payload.diagnosticHints).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('uses runtime diagnostics as refresh evidence without turning them into card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: [
          'resolved_behavior_changed:old->new',
          'matched OpenCode runtime pid and process identity',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(payload.diagnostics).toContain('resolved_behavior_changed:old->new');
    expect(payload.memberCardError).not.toBe('matched OpenCode runtime pid and process identity');
  });

  it('uses suppressed spawn runtime diagnostics as refresh evidence for generic OpenCode API errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('does not suppress stale markers when separate evidence contains real failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'session_stale',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['permission denied'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('session_stale');
    expect(payload.diagnostics).toContain('permission denied');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('uses stale OpenCode log-projection diagnostics as refresh evidence without card errors', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); reading historical messages for log projection only',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
    expect(getMemberLaunchDiagnosticsErrorMessage(payload)).toBeUndefined();
  });

  it('keeps card error when stale refresh diagnostics include unknown extra text', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps card error when OpenCode API error includes non-refresh failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new permission denied',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode API error. resolved_behavior_changed:old->new permission denied'
    );
    expect(payload.diagnosticHints).toContain(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  });

  it('keeps card error when OpenCode API error includes unknown refresh details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new unexpected detail',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode API error. resolved_behavior_changed:old->new unexpected detail'
    );
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps card error when refresh marker has colon-suffixed failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new:permission_denied',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode API error. resolved_behavior_changed:old->new:permission_denied'
    );
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
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
  ])(
    'keeps card error when refresh marker directly consumes failure-looking suffix _%s',
    (suffix) => {
      const error = `OpenCode API error. resolved_behavior_changed:old->new_${suffix}`;
      const payload = buildMemberLaunchDiagnosticsPayload({
        memberName: 'tom',
        member: { name: 'tom', providerId: 'opencode' },
        spawnEntry: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailure: true,
          error,
          runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
          runtimeDiagnosticSeverity: 'error',
          updatedAt: '2026-05-18T08:13:23.902Z',
        },
      });

      expect(payload.memberCardError).toBe(error);
      expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
    }
  );

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
  ])('keeps card error for separator-attached failure detail %s', (detail) => {
    const error = `OpenCode API error. ${detail}`;
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error,
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe(error);
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('suppresses card error when refresh marker suffix is clean', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(false);
  });

  it('keeps card error when failure details are attached to a refresh marker with punctuation', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error. resolved_behavior_changed:old->new;permission_denied',
        runtimeDiagnostic: 'opencode_app_mcp_transport_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe(
      'OpenCode API error. resolved_behavior_changed:old->new;permission_denied'
    );
    expect(payload.diagnosticHints).toContain(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  });

  it('keeps generic card error when diagnostics mention refresh plus real failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new permission denied'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnosticHints).toContain(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  });

  it('keeps generic card error when clean refresh diagnostics are mixed with separate failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new', 'permission denied'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain('permission denied');
    expect(payload.diagnosticHints).toContain(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  });

  it('keeps generic card error when clean refresh diagnostics are mixed with network failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new', 'network timeout'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain('network timeout');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps generic card error when clean refresh diagnostics are mixed with auth failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new', 'auth_unavailable'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain('auth_unavailable');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps generic card error when clean refresh diagnostics are mixed with permission-blocked details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: ['resolved_behavior_changed:old->new', 'permission_blocked'],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain('permission_blocked');
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps generic card error when clean refresh diagnostics are mixed with quota failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: [
          'resolved_behavior_changed:old->new',
          'Key limit exceeded (total limit). Manage it using OpenRouter settings.',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain(
      'Key limit exceeded (total limit). Manage it using OpenRouter settings.'
    );
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps generic card error when stale log-projection diagnostics include protocol failure details', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'OpenCode API error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
      runtimeEntry: {
        memberName: 'tom',
        providerId: 'opencode',
        alive: true,
        restartable: false,
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_task_refs',
        ],
        updatedAt: '2026-05-18T08:34:47.845Z',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode API error');
    expect(payload.diagnostics).toContain(
      'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_task_refs'
    );
    expect(hasMemberLaunchDiagnosticsError(payload)).toBe(true);
  });

  it('keeps action-required runtime advisory errors even when the message looks like refresh evidence', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
      member: { name: 'tom', providerId: 'opencode' },
      runtimeAdvisoryLabel: 'OpenCode quota error',
      runtimeAdvisoryTitle: 'OpenCode quota exhausted.',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'quota_exhausted',
        message: 'resolved_behavior_changed:old->new',
      },
    });

    expect(payload.memberCardError).toBe('OpenCode quota exhausted.');
    expect(payload.runtimeAdvisoryReasonCode).toBe('quota_exhausted');
    expect(payload.diagnostics).toContain('OpenCode quota exhausted.');
  });

  it('does not suppress non-OpenCode runtime diagnostics that look like refresh markers', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'claude',
      member: { name: 'claude', providerId: 'anthropic' },
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: 'session_stale',
        runtimeDiagnostic: 'resolved_behavior_changed:old->new',
        runtimeDiagnosticSeverity: 'error',
        updatedAt: '2026-05-18T08:13:23.902Z',
      },
    });

    expect(payload.memberCardError).toBe('session_stale');
    expect(payload.diagnostics).toContain('resolved_behavior_changed:old->new');
    expect(payload.diagnosticHints).toContain(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  });

  it('does not suppress non-OpenCode advisory errors that look like session refresh', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'claude',
      member: { name: 'claude', providerId: 'anthropic' },
      runtimeAdvisoryLabel: 'Anthropic API error',
      runtimeAdvisoryTitle: 'Anthropic API error.\n\nresolved_behavior_changed:old->new',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'resolved_behavior_changed:old->new',
      },
    });

    expect(payload.memberCardError).toBe('Anthropic API error. resolved_behavior_changed:old->new');
    expect(payload.diagnostics).toContain(
      'Anthropic API error. resolved_behavior_changed:old->new'
    );
  });

  it('prioritizes durable bootstrap timeout over no-stdin stderr noise', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'run-mailbox-written-no-submit',
      memberName: 'atlas',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error:
          'Teammate process atlas@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: mailbox_bootstrap_written: messageId=bootstrap-atlas-1 Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
        livenessKind: 'stale_metadata',
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeDiagnosticSeverity: 'warning',
        updatedAt: '2026-05-19T13:53:36.668Z',
      },
    });

    expect(payload.probableCause).toBe(
      'Parent process timed out waiting for durable bootstrap_submitted evidence.'
    );
    expect(payload.diagnosticHints?.[0]).toBe(
      'Parent process timed out waiting for durable bootstrap_submitted evidence.'
    );
    expect(payload.diagnosticHints).toContain(
      'CLI read empty stdin before bootstrap submit; verify headless teammate runtime flag/env and startup input handling.'
    );
  });

  it('prioritizes bootstrap submit rejection over no-stdin stderr noise', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'run-submit-rejected-no-stdin',
      memberName: 'bob',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error:
          'Teammate process bob@signal-ops did not submit bootstrap prompt: timed out waiting for bootstrap_submitted; last transport stage: bootstrap_submit_rejected: submit rejected by local prompt handler retryable=true Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
        updatedAt: '2026-05-19T13:53:36.668Z',
      },
    });

    expect(payload.probableCause).toBe(
      'The teammate process observed bootstrap mail, but local prompt submission did not accept the bootstrap turn.'
    );
    expect(payload.diagnosticHints?.[0]).toBe(
      'The teammate process observed bootstrap mail, but local prompt submission did not accept the bootstrap turn.'
    );
    expect(payload.diagnosticHints).toContain(
      'CLI read empty stdin before bootstrap submit; verify headless teammate runtime flag/env and startup input handling.'
    );
  });

  it('prioritizes submitted-but-unconfirmed bootstrap over no-stdin stderr noise', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      teamName: 'signal-ops',
      runId: 'run-submitted-no-confirm',
      memberName: 'alice',
      spawnEntry: {
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error:
          'Teammate was registered but did not bootstrap-confirm before timeout. Last transport stage: bootstrap_submitted: messageId=bootstrap-alice-1 Last stderr: Warning: no stdin data received in 3s, proceeding without it.',
        updatedAt: '2026-05-19T13:53:36.668Z',
      },
    });

    expect(payload.probableCause).toBe(
      'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.'
    );
    expect(payload.diagnosticHints?.[0]).toBe(
      'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.'
    );
    expect(payload.diagnosticHints).toContain(
      'CLI read empty stdin before bootstrap submit; verify headless teammate runtime flag/env and startup input handling.'
    );
  });
});
