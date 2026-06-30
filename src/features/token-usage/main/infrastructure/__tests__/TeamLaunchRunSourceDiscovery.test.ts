import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { TeamLaunchRunSourceDiscovery } from '../TeamLaunchRunSourceDiscovery';

describe('TeamLaunchRunSourceDiscovery', () => {
  it('discovers app-scoped team launch runs with command invocation attribution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          members: [
            {
              name: 'builder',
              agentId: 'alpha:builder',
              providerId: 'opencode',
              providerBackendId: 'adapter',
              model: 'qwen-coder',
            },
          ],
        })
      );
      await writeFile(
        path.join(teamDir, 'launch-state.json'),
        JSON.stringify({
          version: 2,
          teamName: 'alpha',
          updatedAt: '2026-06-30T00:04:00.000Z',
          launchPhase: 'active',
          expectedMembers: ['builder', 'ghost'],
          members: {
            builder: {
              name: 'builder',
              providerId: 'opencode',
              providerBackendId: 'adapter',
              billingMode: 'api',
              model: 'qwen-coder',
              launchState: 'ready',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              runtimeRunId: 'runtime-run-1',
              runtimeSessionId: 'native-session-1',
              firstSpawnAcceptedAt: '2026-06-30T00:01:00.000Z',
              lastEvaluatedAt: '2026-06-30T00:04:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'ready',
        })
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:member:builder:runtime-run-1',
          commandId: 'team-launch:alpha',
          commandInvocationId: 'team-launch:alpha:2026-06-30T00:01:00.000Z',
          runtimeKind: 'opencode',
          providerBackendId: 'adapter',
          billingMode: 'api',
          status: 'running',
          startedAt: '2026-06-30T00:01:00.000Z',
        })
      );
      expect(runs[0]?.sources[0]).toEqual(
        expect.objectContaining({
          nativeSessionId: 'native-session-1',
          sourceType: 'runtime_trace',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers team lead provider and model from team config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-lead-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          createdAt: 1780195320000,
          leadSessionId: 'lead-session-1',
          members: [
            {
              name: 'team-lead',
              agentId: 'team-lead@alpha',
              agentType: 'team-lead',
              provider: 'codex',
              model: 'gpt-5.5',
              joinedAt: 1780195380000,
            },
          ],
        })
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:lead:lead-session-1',
          agentId: 'team-lead@alpha',
          agentName: 'team-lead',
          runtimeKind: 'codex',
          providerId: 'codex',
          model: 'gpt-5.5',
          startedAt: '2026-05-31T02:43:00.000Z',
          endedAt: '2026-05-31T02:43:00.000Z',
          status: 'completed',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers team lead model from launch metadata when config stores provider only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-lead-meta-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          createdAt: 1780195320000,
          leadSessionId: 'lead-session-1',
          members: [
            {
              name: 'team-lead',
              agentType: 'team-lead',
              provider: 'codex',
              joinedAt: 1780195380000,
            },
          ],
        })
      );
      await writeFile(
        path.join(teamDir, 'team.meta.json'),
        JSON.stringify({
          providerId: 'codex',
          launchIdentity: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            billingMode: 'subscription',
            selectedModel: null,
            resolvedLaunchModel: 'gpt-5.5',
            catalogId: 'gpt-5.5',
          },
        })
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:lead:lead-session-1',
          runtimeKind: 'codex',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          billingMode: 'subscription',
          model: 'gpt-5.5',
          startedAt: '2026-05-31T02:43:00.000Z',
          endedAt: '2026-05-31T02:43:00.000Z',
          status: 'completed',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not use liveness evaluation time as endedAt for stopped member runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-stopped-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          members: [{ name: 'builder', providerId: 'opencode', model: 'qwen-coder' }],
        })
      );
      await writeFile(
        path.join(teamDir, 'launch-state.json'),
        JSON.stringify({
          version: 2,
          teamName: 'alpha',
          updatedAt: '2026-06-30T14:00:00.000Z',
          launchPhase: 'finished',
          expectedMembers: ['builder'],
          members: {
            builder: {
              name: 'builder',
              providerId: 'opencode',
              model: 'qwen-coder',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: true,
              hardFailure: false,
              runtimeSessionId: 'native-session-1',
              firstSpawnAcceptedAt: '2026-06-11T12:00:00.000Z',
              lastRuntimeAliveAt: '2026-06-11T19:58:15.440Z',
              lastEvaluatedAt: '2026-06-30T14:00:00.000Z',
            },
            ghost: {
              name: 'ghost',
              providerId: 'opencode',
              model: 'qwen-coder',
              launchState: 'failed_to_start',
              agentToolAccepted: false,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              lastEvaluatedAt: '2026-06-30T14:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 0,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'clean_success',
        })
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:member:builder:native-session-1',
          startedAt: '2026-06-11T12:00:00.000Z',
          endedAt: '2026-06-11T19:58:15.440Z',
          status: 'completed',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers teammate sessions from runtime traces when launch state is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-runtime-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(path.join(teamDir, 'runtime'), { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          members: [
            {
              name: 'auditor',
              agentId: 'auditor@alpha',
              providerId: 'anthropic',
              model: 'haiku',
            },
          ],
        })
      );
      await writeFile(
        path.join(teamDir, 'team.meta.json'),
        JSON.stringify({
          providerId: 'anthropic',
          launchIdentity: {
            providerId: 'anthropic',
            billingMode: 'subscription',
            resolvedLaunchModel: 'haiku',
          },
        })
      );
      await writeFile(
        path.join(teamDir, 'runtime', 'auditor.runtime.jsonl'),
        [
          JSON.stringify({
            type: 'cli_started',
            timestamp: '2026-06-30T01:00:00.000Z',
            teamName: 'alpha',
            agentName: 'auditor',
            agentId: 'auditor@alpha',
            runId: 'native-session-1',
            cwd: '/sandbox/project',
          }),
          JSON.stringify({
            type: 'runtime_ready',
            timestamp: '2026-06-30T01:01:00.000Z',
            teamName: 'alpha',
            agentName: 'auditor',
            agentId: 'auditor@alpha',
            runId: 'native-session-1',
            cwd: '/sandbox/project',
          }),
        ].join('\n')
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:member:auditor:native-session-1',
          agentId: 'auditor@alpha',
          agentName: 'auditor',
          runtimeKind: 'anthropic',
          providerId: 'anthropic',
          billingMode: 'subscription',
          model: 'haiku',
          startedAt: '2026-06-30T01:00:00.000Z',
          endedAt: '2026-06-30T01:01:00.000Z',
          status: 'completed',
        })
      );
      expect(runs[0]?.sources[0]).toEqual(
        expect.objectContaining({
          nativeSessionId: 'native-session-1',
          sourceType: 'cli_log',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not keep a runtime session running when persisted active pid is stale', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-discovery-stale-pid-'));
    try {
      const teamDir = path.join(root, 'alpha');
      await mkdir(path.join(teamDir, 'runtime'), { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'alpha',
          projectPath: '/sandbox/project',
          members: [
            {
              name: 'probe',
              agentId: 'probe@alpha',
              providerId: 'codex',
              model: 'gpt-5.4-mini',
              isActive: true,
              runtimePid: 999_999_999,
            },
          ],
        })
      );
      await writeFile(
        path.join(teamDir, 'runtime', 'probe.runtime.jsonl'),
        [
          JSON.stringify({
            type: 'cli_started',
            timestamp: '2026-06-30T01:00:00.000Z',
            teamName: 'alpha',
            agentName: 'probe',
            agentId: 'probe@alpha',
            runId: 'codex-session-1',
            cwd: '/sandbox/project',
          }),
          JSON.stringify({
            type: 'bootstrap_confirmed',
            timestamp: '2026-06-30T01:02:00.000Z',
            teamName: 'alpha',
            agentName: 'probe',
            agentId: 'probe@alpha',
            runId: 'codex-session-1',
            cwd: '/sandbox/project',
          }),
        ].join('\n')
      );

      const runs = await new TeamLaunchRunSourceDiscovery(root).discoverAppRuns();

      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(
        expect.objectContaining({
          appRunId: 'team:alpha:member:probe:codex-session-1',
          runtimeKind: 'codex',
          status: 'completed',
          endedAt: '2026-06-30T01:02:00.000Z',
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
