import { describe, expect, it } from 'vitest';

import {
  buildMemberLaunchDiagnosticsPayload,
  formatMemberLaunchDiagnosticsPayload,
  hasMemberLaunchDiagnosticsDetails,
  getMemberLaunchDiagnosticsErrorMessage,
} from '@renderer/utils/memberLaunchDiagnostics';

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

  it('does not surface recoverable OpenCode session refresh advisory as card error', () => {
    const payload = buildMemberLaunchDiagnosticsPayload({
      memberName: 'tom',
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
      runtimeAdvisoryLabel: 'OpenCode session refresh',
      runtimeAdvisoryTitle:
        'OpenCode session changed; refreshing the session before retry.',
      runtimeAdvisory: {
        kind: 'api_error',
        observedAt: '2026-05-18T08:31:46.075Z',
        reasonCode: 'backend_error',
        message: 'opencode_app_mcp_transport_changed:old->new',
      },
    });

    expect(payload.memberCardError).toBeUndefined();
  });
});
