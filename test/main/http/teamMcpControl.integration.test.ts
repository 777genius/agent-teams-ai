// @vitest-environment node

import Fastify from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { registerTools } from '../../../mcp-server/src/tools';
import { registerTeamRoutes } from '@main/http/teams';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import type { HttpServices } from '@main/http';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
}

function collectTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();

  registerTools({
    addTool(config: RegisteredTool) {
      tools.set(config.name, config);
    },
  } as never);

  return tools;
}

function parseJsonToolResult(result: unknown): unknown {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  return JSON.parse(text ?? 'null');
}

async function fetchJson(
  baseUrl: string,
  pathname: string
): Promise<{
  body: unknown;
  status: number;
}> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    body: await response.json(),
  };
}

function createServices(claudeRoot: string): {
  createTeamCalls: TeamCreateRequest[];
  services: HttpServices;
} {
  const teamDataService = new TeamDataService();
  const createTeamCalls: TeamCreateRequest[] = [];
  const aliveTeams = new Set<string>();
  const progressByRunId = new Map<string, TeamProvisioningProgress>();
  const runIdByTeam = new Map<string, string>();

  async function persistLaunchedConfig(request: TeamCreateRequest): Promise<void> {
    const teamDir = path.join(claudeRoot, 'teams', request.teamName);
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify(
        {
          name: request.displayName ?? request.teamName,
          projectPath: request.cwd,
          members: [
            {
              name: 'team-lead',
              role: 'team-lead',
              agentType: 'team-lead',
            },
            ...request.members.map((member) => ({
              name: member.name,
              role: member.role,
              workflow: member.workflow,
              agentType: 'teammate',
              providerId: member.providerId,
              providerBackendId: member.providerBackendId,
              model: member.model,
              effort: member.effort,
              fastMode: member.fastMode,
            })),
          ],
        },
        null,
        2
      ),
      'utf8'
    );
  }

  async function createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    createTeamCalls.push(request);
    await persistLaunchedConfig(request);

    const runId = `run-${request.teamName}`;
    const progress: TeamProvisioningProgress = {
      runId,
      teamName: request.teamName,
      state: 'ready',
      message: 'Ready',
      startedAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:01.000Z',
    };
    aliveTeams.add(request.teamName);
    runIdByTeam.set(request.teamName, runId);
    progressByRunId.set(runId, progress);
    onProgress(progress);
    return { runId };
  }

  const teamProvisioningService = {
    createTeam,
    launchTeam: async (
      request: TeamLaunchRequest,
      onProgress: (progress: TeamProvisioningProgress) => void
    ): Promise<TeamLaunchResponse> => {
      return createTeam(
        {
          teamName: request.teamName,
          cwd: request.cwd,
          prompt: request.prompt,
          providerId: request.providerId,
          providerBackendId: request.providerBackendId,
          model: request.model,
          effort: request.effort,
          fastMode: request.fastMode,
          skipPermissions: request.skipPermissions,
          worktree: request.worktree,
          extraCliArgs: request.extraCliArgs,
          members: [],
        },
        onProgress
      );
    },
    getProvisioningStatus: (runId: string): Promise<TeamProvisioningProgress> => {
      const progress = progressByRunId.get(runId);
      if (!progress) {
        throw new Error('Unknown runId');
      }
      return Promise.resolve(progress);
    },
    getRuntimeState: (teamName: string): Promise<TeamRuntimeState> => {
      const runId = runIdByTeam.get(teamName) ?? null;
      return Promise.resolve({
        teamName,
        isAlive: aliveTeams.has(teamName),
        runId,
        progress: runId ? (progressByRunId.get(runId) ?? null) : null,
      });
    },
    stopTeam: (teamName: string): Promise<void> => {
      aliveTeams.delete(teamName);
      return Promise.resolve();
    },
    getAliveTeams: (): string[] => [...aliveTeams],
  } as HttpServices['teamProvisioningService'];

  return {
    createTeamCalls,
    services: {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService,
      teamProvisioningService,
    },
  };
}

describe('MCP team tools over the local REST control API', () => {
  const tools = collectTools();

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  it('creates, gets, launches, and lists a team through MCP and REST end to end', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'agent-teams-control-e2e-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-project-e2e-'));
    setClaudeBasePathOverride(claudeRoot);

    const app = Fastify();
    const { createTeamCalls, services } = createServices(claudeRoot);
    registerTeamRoutes(app, services);

    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      const controlUrl = `http://127.0.0.1:${address.port}`;

      const created = parseJsonToolResult(
        await getTool('team_create').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
          displayName: 'MCP E2E Team',
          description: 'Created by MCP integration test',
          color: '#3366ff',
          cwd: projectDir,
          prompt: 'Coordinate the test task',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
          effort: 'high',
          fastMode: 'on',
          limitContext: true,
          skipPermissions: false,
          worktree: 'feature-e2e',
          extraCliArgs: '--max-turns 5',
          members: [
            {
              name: 'builder',
              role: 'Engineer',
              workflow: 'Ship a focused patch',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.2',
              effort: 'high',
              fastMode: 'on',
            },
          ],
        })
      ) as { teamName: string };
      expect(created).toEqual({ teamName: 'mcp-e2e-team' });

      const restDraft = await fetchJson(controlUrl, '/api/teams/mcp-e2e-team');
      expect(restDraft.status).toBe(200);
      expect(restDraft.body).toMatchObject({
        teamName: 'mcp-e2e-team',
        pendingCreate: true,
        savedRequest: {
          teamName: 'mcp-e2e-team',
          displayName: 'MCP E2E Team',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
          effort: 'high',
          fastMode: 'on',
          limitContext: true,
          skipPermissions: false,
          members: [
            {
              name: 'builder',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.2',
              effort: 'high',
              fastMode: 'on',
            },
          ],
        },
      });

      const mcpDraft = parseJsonToolResult(
        await getTool('team_get').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
        })
      );
      expect(mcpDraft).toMatchObject({
        teamName: 'mcp-e2e-team',
        pendingCreate: true,
        savedRequest: {
          prompt: 'Coordinate the test task',
          worktree: 'feature-e2e',
          extraCliArgs: '--max-turns 5',
        },
      });

      const restListBeforeLaunch = await fetchJson(controlUrl, '/api/teams');
      expect(restListBeforeLaunch.status).toBe(200);
      expect(restListBeforeLaunch.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            teamName: 'mcp-e2e-team',
            displayName: 'MCP E2E Team',
            pendingCreate: true,
          }),
        ])
      );

      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
          cwd: projectDir,
        })
      ) as { isAlive: boolean; progress: TeamProvisioningProgress; runId: string };
      expect(launched).toMatchObject({
        isAlive: true,
        runId: 'run-mcp-e2e-team',
        progress: {
          state: 'ready',
          teamName: 'mcp-e2e-team',
        },
      });
      expect(createTeamCalls).toHaveLength(1);
      expect(createTeamCalls[0]).toMatchObject({
        teamName: 'mcp-e2e-team',
        displayName: 'MCP E2E Team',
        cwd: projectDir,
        prompt: 'Coordinate the test task',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        effort: 'high',
        fastMode: 'on',
        limitContext: true,
        skipPermissions: false,
        worktree: 'feature-e2e',
        extraCliArgs: '--max-turns 5',
        members: [
          {
            name: 'builder',
            role: 'Engineer',
            workflow: 'Ship a focused patch',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.2',
            effort: 'high',
            fastMode: 'on',
          },
        ],
      });

      const restRuntime = await fetchJson(controlUrl, '/api/teams/mcp-e2e-team/runtime');
      expect(restRuntime.status).toBe(200);
      expect(restRuntime.body).toMatchObject({
        teamName: 'mcp-e2e-team',
        isAlive: true,
        runId: 'run-mcp-e2e-team',
      });

      const restListAfterLaunch = await fetchJson(controlUrl, '/api/teams');
      expect(restListAfterLaunch.status).toBe(200);
      const launchedListItem = (restListAfterLaunch.body as Record<string, unknown>[]).find(
        (team) => team.teamName === 'mcp-e2e-team'
      );
      expect(launchedListItem).toMatchObject({
        teamName: 'mcp-e2e-team',
        displayName: 'MCP E2E Team',
      });
      expect(launchedListItem).not.toHaveProperty('pendingCreate');

      const mcpLaunchedTeam = parseJsonToolResult(
        await getTool('team_get').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
        })
      );
      expect(mcpLaunchedTeam).toMatchObject({
        teamName: 'mcp-e2e-team',
        config: {
          name: 'MCP E2E Team',
          projectPath: projectDir,
        },
        members: expect.arrayContaining([
          expect.objectContaining({
            name: 'builder',
            role: 'Engineer',
          }),
        ]),
      });
    } finally {
      await app.close();
      setClaudeBasePathOverride(null);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
