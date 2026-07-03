import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDeterministicLaunchProcessArgs,
  buildLaunchSyntheticRequest,
  getInitialLaunchValidationMessage,
  parseLaunchConfigProjectPath,
  prepareDeterministicLaunchRunState,
  resolveExistingLaunchRunReuse,
} from '../TeamProvisioningLaunchTeamFlow';

import type { ProviderModelLaunchIdentity, TeamProvisioningProgress } from '@shared/types';

const launchIdentity: ProviderModelLaunchIdentity = {
  providerId: 'codex',
  providerBackendId: null,
  selectedModel: 'gpt-5',
  selectedModelKind: 'explicit',
  resolvedLaunchModel: 'gpt-5',
  catalogId: 'gpt-5',
  catalogSource: 'runtime',
  catalogFetchedAt: null,
  selectedEffort: 'high',
  resolvedEffort: 'high',
};

describe('TeamProvisioningLaunchTeamFlow', () => {
  it('parses launch config project paths defensively', () => {
    expect(parseLaunchConfigProjectPath(JSON.stringify({ projectPath: 'relative/project' }))).toBe(
      path.resolve('relative/project')
    );
    expect(parseLaunchConfigProjectPath(JSON.stringify({ projectPath: '   ' }))).toBeNull();
    expect(parseLaunchConfigProjectPath('{not json')).toBeNull();
  });

  it('reuses an alive matching run and blocks ambiguous or mismatched live cwd', () => {
    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'demo',
        cwd: '/repo',
        existingAliveRunId: 'run-1',
        existingRun: { child: {}, processKilled: false, cancelRequested: false },
        existingRunCwd: '/repo',
        configProjectPath: null,
      })
    ).toEqual({ kind: 'reuse', runId: 'run-1' });

    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'demo',
        cwd: '/repo',
        existingAliveRunId: 'run-1',
        existingRun: { child: {}, processKilled: false, cancelRequested: false },
        existingRunCwd: null,
        configProjectPath: null,
      })
    ).toEqual({
      kind: 'blocked',
      message:
        'Team "demo" is already running, but its cwd could not be determined. Stop it before launching again.',
    });

    expect(
      resolveExistingLaunchRunReuse({
        teamName: 'demo',
        cwd: '/repo-next',
        existingAliveRunId: 'run-1',
        existingRun: { child: {}, processKilled: false, cancelRequested: false },
        existingRunCwd: '/repo',
        configProjectPath: null,
      })
    ).toEqual({
      kind: 'blocked',
      message:
        'Team "demo" is already running in "/repo". Stop it before launching with cwd "/repo-next".',
    });
  });

  it('builds launch synthetic requests with optional display metadata from config', () => {
    const synthetic = buildLaunchSyntheticRequest({
      request: {
        teamName: 'demo',
        cwd: '/repo',
        providerId: 'codex',
        model: 'gpt-5',
        effort: 'high',
        fastMode: 'off',
        skipPermissions: false,
      },
      members: [{ name: 'Builder', role: 'Build' }],
      configRaw: JSON.stringify({ color: ' blue ', name: ' Demo Team ' }),
    });

    expect(synthetic).toMatchObject({
      teamName: 'demo',
      cwd: '/repo',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'off',
      skipPermissions: false,
      color: 'blue',
      displayName: 'Demo Team',
    });
    expect(synthetic.members.map((member) => member.name)).toEqual(['Builder']);
  });

  it('keeps launch validation messages tied to roster source', () => {
    expect(getInitialLaunchValidationMessage('members-meta')).toBe(
      'Validating team launch request (members from members.meta.json)'
    );
    expect(getInitialLaunchValidationMessage('inboxes')).toBe(
      'Validating team launch request (members from inboxes)'
    );
    expect(getInitialLaunchValidationMessage('config-fallback')).toBe(
      'Validating team launch request (fallback members from config.json)'
    );
  });

  it('prepares deterministic launch run state in persisted-state order', async () => {
    const order: string[] = [];
    const progress: TeamProvisioningProgress = {
      runId: 'run-1',
      teamName: 'demo',
      state: 'validating',
      message: 'Validating team launch request',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const run = {
      runId: 'run-1',
      teamName: 'demo',
      launchStateClearedForRun: false,
      mixedSecondaryLanes: ['lane-a', 'lane-b'],
      progress,
      provisioningTraceLines: [],
      provisioningOutputParts: [],
      provisioningOutputIndexByMessageId: new Map<string, number>(),
      stallWarningIndex: null,
      apiRetryWarningIndex: null,
      onProgress: vi.fn(() => {
        order.push('progress');
      }),
    };

    await prepareDeterministicLaunchRunState({
      teamName: 'demo',
      run,
      resetTeamScopedTransientStateForNewRun: vi.fn(() => {
        order.push('reset');
      }),
      registerRun: vi.fn(() => {
        order.push('register');
      }),
      setProvisioningRunByTeam: vi.fn(() => {
        order.push('set-team-run');
      }),
      prepareWorkspaceTrustForDeterministicRun: vi.fn(async () => {
        order.push('workspace-trust');
      }),
      clearPersistedLaunchState: vi.fn(async () => {
        order.push('clear-launch-state');
      }),
      publishMixedSecondaryLaneStatusChange: vi.fn(async (_run, lane) => {
        order.push(`publish-${lane}`);
      }),
    });

    expect(order).toEqual([
      'reset',
      'register',
      'set-team-run',
      'progress',
      'workspace-trust',
      'progress',
      'clear-launch-state',
      'progress',
      'publish-lane-a',
      'publish-lane-b',
    ]);
    expect(run.launchStateClearedForRun).toBe(true);
    expect(run.progress.assistantOutput).toContain('Validating team launch request');
    expect(run.progress.assistantOutput).toContain('Publishing mixed secondary lane status');
  });

  it('builds deterministic launch process args in the legacy append order', () => {
    const args = buildDeterministicLaunchProcessArgs({
      mcpConfigPath: '/tmp/mcp.json',
      bootstrapSpecPath: '/tmp/spec.json',
      bootstrapUserPromptPath: '/tmp/prompt.txt',
      skipPermissions: false,
      worktree: 'feature-a',
      providerId: 'codex',
      model: 'gpt-5',
      launchIdentity,
      runtimeArgsPlan: {
        providerArgs: ['--provider-arg'],
        fastModeArgs: ['--fast'],
        runtimeTurnSettledHookArgs: ['--hook'],
        extraArgs: ['--extra'],
        settingsArgs: ['--settings', '{"a":1}'],
        inheritedProviderArgs: ['--inherit'],
        appManagedSettingsPath: null,
      },
      teammateModeDecision: { injectedTeammateMode: 'tmux' },
      disallowedTools: 'TeamDelete',
    });

    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'user,project,local',
      '--mcp-config',
      '/tmp/mcp.json',
      '--team-bootstrap-spec',
      '/tmp/spec.json',
      '--team-bootstrap-user-prompt-file',
      '/tmp/prompt.txt',
      '--disallowedTools',
      'TeamDelete',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'default',
      '--model',
      'gpt-5',
      '--effort',
      'high',
      '--provider-arg',
      '--fast',
      '--hook',
      '--worktree',
      'feature-a',
      '--teammate-mode',
      'tmux',
      '--extra',
      '--settings',
      '{"a":1}',
      '--inherit',
    ]);
  });
});
