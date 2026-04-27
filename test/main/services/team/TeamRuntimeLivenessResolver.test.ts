import { describe, expect, it } from 'vitest';

import {
  resolveTeamMemberRuntimeLiveness,
  sanitizeProcessCommandForDiagnostics,
} from '@main/services/team/TeamRuntimeLivenessResolver';

const NOW = '2026-04-24T12:00:00.000Z';

describe('resolveTeamMemberRuntimeLiveness', () => {
  it('classifies tmux shell panes as weak shell-only evidence', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'bob',
      agentId: 'agent-bob',
      backendType: 'tmux',
      tmuxPaneId: '%1',
      pane: { paneId: '%1', panePid: 100, currentCommand: 'zsh' },
      processRows: [{ pid: 100, ppid: 1, command: 'zsh' }],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('shell_only');
    expect(result.pidSource).toBe('tmux_pane');
    expect(result.pid).toBe(100);
  });

  it('promotes a verified team and agent process to strong runtime evidence', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'alice',
      agentId: 'agent-alice',
      backendType: 'tmux',
      processRows: [
        {
          pid: 222,
          ppid: 1,
          command: 'node runtime --team-name demo --agent-id agent-alice',
        },
      ],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(true);
    expect(result.livenessKind).toBe('runtime_process');
    expect(result.pidSource).toBe('agent_process_table');
    expect(result.pid).toBe(222);
  });

  it('keeps a verified process pid visible after bootstrap is confirmed', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'alice',
      agentId: 'agent-alice',
      backendType: 'tmux',
      trackedSpawnStatus: {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        updatedAt: NOW,
      },
      processRows: [
        {
          pid: 222,
          ppid: 1,
          command: 'node runtime --team-name demo --agent-id agent-alice',
        },
      ],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(true);
    expect(result.livenessKind).toBe('runtime_process');
    expect(result.pidSource).toBe('agent_process_table');
    expect(result.pid).toBe(222);
  });

  it('keeps a non-shell tmux descendant without identity as a candidate', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'jack',
      agentId: 'agent-jack',
      backendType: 'tmux',
      tmuxPaneId: '%2',
      pane: { paneId: '%2', panePid: 300, currentCommand: 'zsh' },
      processRows: [
        { pid: 300, ppid: 1, command: 'zsh' },
        { pid: 301, ppid: 300, command: 'node helper.js' },
      ],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('runtime_process_candidate');
    expect(result.pidSource).toBe('tmux_child');
    expect(result.pid).toBe(301);
  });

  it('keeps a live OpenCode runtime pid as candidate until bootstrap is confirmed', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'bob',
      providerId: 'opencode',
      persistedRuntimePid: 404,
      persistedRuntimeSessionId: 'session-bob',
      processRows: [{ pid: 404, ppid: 1, command: 'opencode runtime host' }],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('runtime_process_candidate');
    expect(result.pidSource).toBe('opencode_bridge');
    expect(result.pid).toBe(404);
    expect(result.runtimeDiagnostic).toBe(
      'OpenCode runtime process detected, but teammate bootstrap is not confirmed'
    );
  });

  it('promotes a live OpenCode runtime pid after bootstrap confirmation', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'bob',
      providerId: 'opencode',
      persistedRuntimePid: 404,
      persistedRuntimeSessionId: 'session-bob',
      trackedSpawnStatus: {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        updatedAt: NOW,
      },
      processRows: [{ pid: 404, ppid: 1, command: 'opencode runtime host' }],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(true);
    expect(result.livenessKind).toBe('runtime_process');
    expect(result.pidSource).toBe('opencode_bridge');
    expect(result.pid).toBe(404);
  });

  it('does not trust an OpenCode runtime pid reused by an unrelated process', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'bob',
      providerId: 'opencode',
      persistedRuntimePid: 404,
      persistedRuntimeSessionId: 'session-bob',
      processRows: [{ pid: 404, ppid: 1, command: 'node unrelated-worker.js' }],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('runtime_process_candidate');
    expect(result.pidSource).toBe('opencode_bridge');
    expect(result.runtimeDiagnostic).toBe(
      'OpenCode runtime pid is alive, but process identity is unverified'
    );
  });

  it('does not trust a stale persisted pid without current process identity', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'tom',
      persistedRuntimePid: 444,
      processRows: [{ pid: 555, ppid: 1, command: 'node other.js' }],
      processTableAvailable: true,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('stale_metadata');
    expect(result.pidSource).toBe('persisted_metadata');
  });

  it('does not treat a persisted pid as stale when the process table is unavailable', () => {
    const result = resolveTeamMemberRuntimeLiveness({
      teamName: 'demo',
      memberName: 'tom',
      persistedRuntimePid: 444,
      processRows: [],
      processTableAvailable: false,
      nowIso: NOW,
    });

    expect(result.alive).toBe(false);
    expect(result.livenessKind).toBe('registered_only');
    expect(result.pidSource).toBe('persisted_metadata');
    expect(result.diagnostics).toContain('process table unavailable');
  });

  it('redacts common secret flags in diagnostics commands', () => {
    expect(
      sanitizeProcessCommandForDiagnostics('node runtime --api-key sk-123 --token=abc --safe ok')
    ).toBe('node runtime --api-key [redacted] --token=[redacted] --safe ok');
  });
});
