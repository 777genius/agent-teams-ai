import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDeterministicLaunchProcessArgs,
  buildLaunchSyntheticRequest,
  createDeterministicLaunchProvisioningRun,
  getInitialLaunchValidationMessage,
  materializeDeterministicLaunchBootstrapFiles,
  parseLaunchConfigProjectPath,
  prepareDeterministicLaunchRunState,
  resolveExistingLaunchRunReuse,
  type TeamProvisioningLaunchBootstrapRun,
} from '../TeamProvisioningLaunchTeamFlow';

import type {
  MemberSpawnStatusEntry,
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamTask,
} from '@shared/types';

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

function createSpawnStatus(label: string): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: `2026-01-01T00:00:0${label}.000Z`,
  };
}

const syntheticRequest: TeamCreateRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  members: [
    { name: 'Lead', role: 'Lead' },
    { name: 'Builder', role: 'Build' },
  ],
};

const launchRequest: TeamLaunchRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

const testArtifactsRoot = '/repo/.agent-teams-test-artifacts';
const memberMcpConfigPath = `${testArtifactsRoot}/member-mcp.json`;
const mcpConfigPath = `${testArtifactsRoot}/mcp.json`;
const bootstrapSpecPath = `${testArtifactsRoot}/spec.json`;
const bootstrapUserPromptPath = `${testArtifactsRoot}/prompt.txt`;

function createLaunchBootstrapRun(): { run: TeamProvisioningLaunchBootstrapRun } {
  const progress: TeamProvisioningProgress = {
    runId: 'run-1',
    teamName: 'demo',
    state: 'validating',
    message: 'Validating team launch request',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    warnings: ['Recovered roster'],
  };

  const run: TeamProvisioningLaunchBootstrapRun = {
    runId: 'run-1',
    progress,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    mcpConfigPath: null,
    requiresFirstRealTurnSuccess: false,
    cancelRequested: false,
    processKilled: false,
    provisioningTraceLines: [],
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    onProgress: vi.fn(),
  };

  return { run };
}

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

  it('creates the initial deterministic launch provisioning run state', () => {
    let spawnIndex = 0;
    const mixedSecondaryLanes = [{ lane: 'secondary-opencode' }];
    const workspaceTrustFullPlan = {
      launchArgPatches: [{ providerId: 'codex', args: ['--trust'] }],
    };
    const expectedMembers = ['Lead', 'Builder'];
    const initialLaunchWarnings = ['Recovered roster', 'Large team'];
    const effectiveMemberSpecs = [syntheticRequest.members[0]];
    const run = createDeterministicLaunchProvisioningRun({
      runId: 'run-1',
      teamName: 'demo',
      startedAt: '2026-01-01T00:00:00.000Z',
      onProgress: vi.fn(),
      teamsBasePathsToProbe: [{ location: 'configured', basePath: '/teams' }],
      syntheticRequest,
      expectedMembers,
      effectiveMemberSpecs,
      allEffectiveMemberSpecs: syntheticRequest.members,
      launchIdentity,
      mixedSecondaryLanes,
      workspaceTrustFullPlan,
      anthropicApiKeyHelper: { helper: 'material' },
      initialLaunchWarnings,
      initialLaunchWarningSource: 'members-meta',
      createInitialMemberSpawnStatusEntry: () => createSpawnStatus(String(spawnIndex++)),
    });

    expect(run).toMatchObject({
      runId: 'run-1',
      teamName: 'demo',
      startedAt: '2026-01-01T00:00:00.000Z',
      stdoutBuffer: '',
      stderrBuffer: '',
      claudeLogLines: [],
      lastClaudeLogStream: null,
      stdoutLogLineBuf: '',
      stderrLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      deterministicBootstrapMemberSpawnSeen: false,
      deterministicBootstrapMemberResultSeen: false,
      processKilled: false,
      finalizingByTimeout: false,
      cancelRequested: false,
      child: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      lastLogProgressAt: 0,
      lastDataReceivedAt: 0,
      lastStdoutReceivedAt: 0,
      stallCheckHandle: null,
      stallWarningIndex: null,
      preStallMessage: null,
      lastRetryAt: 0,
      apiRetryWarningIndex: null,
      apiErrorWarningEmitted: false,
      waitingTasksSince: null,
      provisioningComplete: false,
      processClosed: false,
      requiresFirstRealTurnSuccess: false,
      firstRealTurnSucceeded: false,
      mcpConfigPath: null,
      memberMcpConfigPaths: [],
      bootstrapSpecPath: null,
      bootstrapUserPromptPath: null,
      isLaunch: true,
      launchStateClearedForRun: false,
      deterministicBootstrap: true,
      workspaceTrustPlan: workspaceTrustFullPlan,
      workspaceTrustExecution: null,
      workspaceTrustDiagnostics: null,
      workspaceTrustRetryAttempted: false,
      fsPhase: 'waiting_members',
      leadRelayCapture: null,
      activeCrossTeamReplyHints: [],
      leadMsgSeq: 0,
      liveLeadTextBuffer: null,
      pendingToolCalls: [],
      pendingDirectCrossTeamSendRefresh: false,
      lastLeadTextEmitMs: 0,
      silentUserDmForward: null,
      silentUserDmForwardClearHandle: null,
      pendingInboxRelayCandidates: [],
      provisioningOutputParts: [],
      provisioningTraceLines: [],
      lastProvisioningTraceKey: null,
      detectedSessionId: null,
      leadActivityState: 'active',
      leadContextUsage: null,
      authFailureRetried: false,
      authRetryInProgress: false,
      spawnContext: null,
      anthropicApiKeyHelper: { helper: 'material' },
      pendingPostCompactReminder: false,
      postCompactReminderInFlight: false,
      suppressPostCompactReminderOutput: false,
      pendingGeminiPostLaunchHydration: false,
      geminiPostLaunchHydrationInFlight: false,
      geminiPostLaunchHydrationSent: false,
      suppressGeminiPostLaunchHydrationOutput: false,
      lastDeterministicBootstrapSeq: 0,
      lastMemberSpawnAuditAt: 0,
      lastMemberSpawnAuditConfigReadWarningAt: 0,
      progress: {
        runId: 'run-1',
        teamName: 'demo',
        state: 'validating',
        message: 'Validating team launch request (members from members.meta.json)',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        warnings: ['Recovered roster', 'Large team'],
        cliLogsTail: undefined,
      },
    });
    expect(run.request).toBe(syntheticRequest);
    expect(run.expectedMembers).toBe(expectedMembers);
    expect(run.progress.warnings).toBe(initialLaunchWarnings);
    expect(run.effectiveMembers).toBe(effectiveMemberSpecs);
    expect(run.allEffectiveMembers).toBe(syntheticRequest.members);
    expect(run.launchIdentity).toBe(launchIdentity);
    expect(run.mixedSecondaryLanes).toBe(mixedSecondaryLanes);
    expect(run.activeToolCalls).toBeInstanceOf(Map);
    expect(run.provisioningOutputIndexByMessageId).toBeInstanceOf(Map);
    expect(run.pendingApprovals).toBeInstanceOf(Map);
    expect(run.processedPermissionRequestIds).toBeInstanceOf(Set);
    expect(run.memberSpawnToolUseIds).toBeInstanceOf(Map);
    expect(run.pendingMemberRestarts).toBeInstanceOf(Map);
    expect(run.memberSpawnLeadInboxCursorByMember).toBeInstanceOf(Map);
    expect(run.lastMemberSpawnAuditMissingWarningAt).toBeInstanceOf(Map);
    expect(Array.from(run.memberSpawnStatuses.keys())).toEqual(['Lead', 'Builder']);
    expect(run.memberSpawnStatuses.get('Lead')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(run.memberSpawnStatuses.get('Builder')?.updatedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it.each([
    ['members-meta', 'Validating team launch request (members from members.meta.json)'],
    ['inboxes', 'Validating team launch request (members from inboxes)'],
    ['config-fallback', 'Validating team launch request (fallback members from config.json)'],
  ] as const)('creates launch progress for %s roster source', (source, message) => {
    const run = createDeterministicLaunchProvisioningRun({
      runId: 'run-1',
      teamName: 'demo',
      startedAt: '2026-01-01T00:00:00.000Z',
      onProgress: vi.fn(),
      teamsBasePathsToProbe: [],
      syntheticRequest,
      expectedMembers: ['Lead'],
      effectiveMemberSpecs: [syntheticRequest.members[0]],
      allEffectiveMemberSpecs: syntheticRequest.members,
      launchIdentity: null,
      mixedSecondaryLanes: [],
      workspaceTrustFullPlan: null,
      anthropicApiKeyHelper: null,
      initialLaunchWarnings: source === 'config-fallback' ? [] : ['Recovered roster'],
      initialLaunchWarningSource: source,
      createInitialMemberSpawnStatusEntry: () => createSpawnStatus('0'),
    });

    expect(run.progress.message).toBe(message);
    expect(run.progress.warnings).toEqual(
      source === 'config-fallback' ? undefined : ['Recovered roster']
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

  it('materializes deterministic launch bootstrap files in legacy order', async () => {
    const order: string[] = [];
    const { run } = createLaunchBootstrapRun();
    const existingTasks = [{ id: 'task-1', title: 'Resume work' } as unknown as TeamTask];
    const isValidationCancelled = vi.fn(() => false);
    const validationOptionsRef: { current?: { isCancelled(): boolean } } = {};

    const result = await materializeDeterministicLaunchBootstrapFiles(
      {
        request: launchRequest,
        run,
        effectiveMemberSpecs: syntheticRequest.members,
        controlApiBaseUrl: 'http://127.0.0.1:1234',
        isValidationCancelled,
      },
      {
        readTasks: vi.fn(async (teamName) => {
          order.push(`read:${teamName}`);
          return existingTasks;
        }),
        logTaskReadWarning: vi.fn(),
        buildDeterministicLaunchHydrationPrompt: vi.fn((request, members, tasks, includeLead) => {
          order.push(`prompt:${tasks.length}:${includeLead}`);
          expect(request).toBe(launchRequest);
          expect(members).toBe(syntheticRequest.members);
          expect(tasks).toBe(existingTasks);
          return 'hydrate\nprompt';
        }),
        getPromptSizeSummary: vi.fn((prompt) => {
          order.push(`size:${prompt}`);
          return { chars: 14, lines: 2 };
        }),
        buildNativeAppManagedBootstrapSpecsWithDiagnostics: vi.fn(async (input) => {
          order.push(`native:${input.teamName}:${input.members.length}`);
          return {
            specs: new Map([
              [
                'Builder',
                {
                  schemaVersion: 1 as const,
                  mode: 'startup_context_file' as const,
                  contextText: 'ctx',
                  contextHash: 'ctx-hash',
                  briefingHash: 'briefing-hash',
                  generatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            ]),
            diagnostics: {
              nativeMemberCount: 1,
              totalContextChars: 2048,
              totalContextLimitChars: 4096,
              warning: 'Native context is large',
            },
          };
        }),
        buildRuntimeBootstrapMemberMcpLaunchConfigs: vi.fn(async (input) => {
          order.push(`member-mcp:${input.controlApiBaseUrl}:${input.cwd}`);
          expect(input.run).toBe(run);
          return new Map([
            [
              'Builder',
              {
                mcpConfigPath: memberMcpConfigPath,
                mcpSettingSources: 'local',
                strictMcpConfig: true,
              },
            ],
          ]);
        }),
        writeDeterministicBootstrapSpecFile: vi.fn(async (spec) => {
          order.push(`write-spec:${spec.mode}:${spec.runId}`);
          expect(
            spec.members.find((member: { name: string }) => member.name === 'Builder')
          ).toMatchObject({
            mcpConfigPath: memberMcpConfigPath,
            nativeAppManagedBootstrap: { contextText: 'ctx' },
          });
          return bootstrapSpecPath;
        }),
        writeDeterministicBootstrapUserPromptFile: vi.fn(async (prompt) => {
          order.push(`write-prompt:${prompt}`);
          return bootstrapUserPromptPath;
        }),
        mcpConfigBuilder: {
          writeConfigFile: vi.fn(async (cwd, options) => {
            order.push(`write-mcp:${cwd}:${options.controlApiBaseUrl}`);
            return mcpConfigPath;
          }),
        },
        validateAgentTeamsMcpRuntime: vi.fn(async (nextMcpConfigPath, options) => {
          order.push(`validate:${nextMcpConfigPath}`);
          validationOptionsRef.current = options;
        }),
      }
    );

    expect(order).toEqual([
      'read:demo',
      'prompt:1:false',
      'size:hydrate\nprompt',
      'native:demo:2',
      'member-mcp:http://127.0.0.1:1234:/repo',
      'write-spec:launch:run-1',
      'write-prompt:hydrate\nprompt',
      'write-mcp:/repo:http://127.0.0.1:1234',
      `validate:${mcpConfigPath}`,
    ]);
    expect(
      run.provisioningTraceLines.map((line) => line.replace(/^.* \[validating\] /, ''))
    ).toEqual([
      'Reading existing tasks for launch prompt',
      'Building deterministic launch bootstrap spec - expectedMembers=2',
      'Native bootstrap startup context is large - Native context is large',
      'Writing deterministic bootstrap spec file',
      'Writing launch hydration prompt file - chars=14 lines=2',
      'Writing MCP config file',
      'Validating agent-teams MCP runtime',
    ]);
    expect(run.progress.warnings).toEqual(['Recovered roster', 'Native context is large']);
    expect(run.bootstrapSpecPath).toBe(bootstrapSpecPath);
    expect(run.bootstrapUserPromptPath).toBe(bootstrapUserPromptPath);
    expect(run.mcpConfigPath).toBe(mcpConfigPath);
    expect(run.requiresFirstRealTurnSuccess).toBe(true);
    expect(result).toEqual({
      prompt: 'hydrate\nprompt',
      promptSize: { chars: 14, lines: 2 },
      mcpConfigPath,
      bootstrapSpecPath,
      bootstrapUserPromptPath,
    });
    expect(validationOptionsRef.current?.isCancelled).toBe(isValidationCancelled);
  });

  it('logs task read warnings and builds launch prompts with empty tasks', async () => {
    const { run } = createLaunchBootstrapRun();
    const logTaskReadWarning = vi.fn();
    const buildPrompt = vi.fn(() => 'prompt');

    await materializeDeterministicLaunchBootstrapFiles(
      {
        request: launchRequest,
        run,
        effectiveMemberSpecs: syntheticRequest.members,
        isValidationCancelled: () => false,
      },
      {
        readTasks: vi.fn(async () => {
          throw new Error('read failed');
        }),
        logTaskReadWarning,
        buildDeterministicLaunchHydrationPrompt: buildPrompt,
        getPromptSizeSummary: vi.fn(() => ({ chars: 6, lines: 1 })),
        buildNativeAppManagedBootstrapSpecsWithDiagnostics: vi.fn(async () => ({
          specs: new Map(),
          diagnostics: {
            nativeMemberCount: 0,
            totalContextChars: 0,
            totalContextLimitChars: 0,
            warning: null,
          },
        })),
        buildRuntimeBootstrapMemberMcpLaunchConfigs: vi.fn(async () => new Map()),
        writeDeterministicBootstrapSpecFile: vi.fn(async () => bootstrapSpecPath),
        writeDeterministicBootstrapUserPromptFile: vi.fn(async () => bootstrapUserPromptPath),
        mcpConfigBuilder: {
          writeConfigFile: vi.fn(async () => mcpConfigPath),
        },
        validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
      }
    );

    expect(logTaskReadWarning).toHaveBeenCalledWith(
      '[demo] Failed to read tasks for launch prompt: Error: read failed'
    );
    expect(buildPrompt).toHaveBeenCalledWith(launchRequest, syntheticRequest.members, [], false);
  });

  it('builds deterministic launch process args in the legacy append order', () => {
    const args = buildDeterministicLaunchProcessArgs({
      mcpConfigPath,
      bootstrapSpecPath,
      bootstrapUserPromptPath,
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
      mcpConfigPath,
      '--team-bootstrap-spec',
      bootstrapSpecPath,
      '--team-bootstrap-user-prompt-file',
      bootstrapUserPromptPath,
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
