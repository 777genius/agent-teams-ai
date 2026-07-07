// @vitest-environment node

import { registerTeamRoutes } from '@main/http/teams';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { registerTools } from '../../../mcp-server/src/tools';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpRuntimeApi,
  TeamLaunchApi,
  TeamRuntimeControlCompatibilityApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';
import type { AddressInfo } from 'net';

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
}

type InjectHttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT' | 'OPTIONS';

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

function toInjectHttpMethod(method: string | undefined): InjectHttpMethod {
  switch ((method ?? 'GET').toUpperCase()) {
    case 'DELETE':
      return 'DELETE';
    case 'HEAD':
      return 'HEAD';
    case 'PATCH':
      return 'PATCH';
    case 'POST':
      return 'POST';
    case 'PUT':
      return 'PUT';
    case 'OPTIONS':
      return 'OPTIONS';
    default:
      return 'GET';
  }
}

async function readInjectedFetchBody(
  body: BodyInit | null | undefined
): Promise<string | Buffer | undefined> {
  if (body == null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  return String(body);
}

function responseHeadersFromInject(
  headers: Record<string, string | string[] | number | undefined>
): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        responseHeaders.append(key, entry);
      }
    } else if (value != null) {
      responseHeaders.set(key, String(value));
    }
  }
  return responseHeaders;
}

function installControlApiFetchMock(app: FastifyInstance, baseUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input));
    if (url.origin !== baseUrl) {
      return originalFetch(input, init);
    }

    const headers = new Headers(request?.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    const injected = await app.inject({
      method: toInjectHttpMethod(init?.method ?? request?.method),
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers),
      payload: await readInjectedFetchBody(
        init?.body ?? (request ? await request.clone().text() : undefined)
      ),
    });

    return new Response(injected.body, {
      status: injected.statusCode,
      headers: responseHeadersFromInject(injected.headers),
    });
  };
  return () => {
    globalThis.fetch = originalFetch;
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

  function runtimeAck(state: OpenCodeRuntimeControlAck['state']): OpenCodeRuntimeControlAck {
    return {
      ok: true,
      providerId: 'opencode',
      teamName: 'mcp-e2e-team',
      runId: 'run-mcp-e2e-team',
      state,
      diagnostics: [],
      observedAt: '2026-04-29T00:00:02.000Z',
    };
  }

  const teamLaunchApi = {
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
  } satisfies TeamLaunchApi;
  const teamRuntimeApi = {
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
  } satisfies TeamHttpRuntimeApi;
  const teamRuntimeControlApi = {
    recordOpenCodeRuntimeBootstrapCheckin: (): Promise<OpenCodeRuntimeControlAck> =>
      Promise.resolve(runtimeAck('accepted')),
    deliverOpenCodeRuntimeMessage: (): Promise<OpenCodeRuntimeControlAck> =>
      Promise.resolve(runtimeAck('delivered')),
    recordOpenCodeRuntimeTaskEvent: (): Promise<OpenCodeRuntimeControlAck> =>
      Promise.resolve(runtimeAck('recorded')),
    recordOpenCodeRuntimeHeartbeat: (): Promise<OpenCodeRuntimeControlAck> =>
      Promise.resolve(runtimeAck('recorded')),
  } satisfies TeamRuntimeControlCompatibilityApi;

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
      teamDataApi: teamDataService,
      teamProvisioningApis: {
        launch: teamLaunchApi,
        runtime: teamRuntimeApi,
        runtimeControl: teamRuntimeControlApi,
      },
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

    const controlUrl = 'http://agent-teams-control.test';
    const restoreFetch = installControlApiFetchMock(app, controlUrl);
    try {
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
      restoreFetch();
      await app.close();
      setClaudeBasePathOverride(null);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns active launch status without waiting when MCP team_launch re-enters provisioning', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'agent-teams-control-active-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-project-active-'));
    const teamName = 'mcp-active-launch';
    setClaudeBasePathOverride(claudeRoot);

    const app = Fastify();
    const { services } = createServices(claudeRoot);
    let launchRequest: TeamLaunchRequest | null = null;
    services.teamProvisioningApis!.launch!.launchTeam = (
      request: TeamLaunchRequest
    ): Promise<TeamLaunchResponse> => {
      launchRequest = request;
      return Promise.resolve({
        runId: 'active-run-1',
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      });
    };
    services.teamProvisioningApis!.launch!.getProvisioningStatus = () =>
      Promise.reject(
        new Error('team_launch should not wait for provisioning status after already_launching')
      );
    registerTeamRoutes(app, services);

    try {
      const teamDir = path.join(claudeRoot, 'teams', teamName);
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: teamName,
          projectPath: projectDir,
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        }),
        'utf8'
      );

      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      const controlUrl = `http://127.0.0.1:${address.port}`;

      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName,
          cwd: projectDir,
          effort: 'minimal',
        })
      );

      expect(launched).toMatchObject({
        teamName,
        runId: 'active-run-1',
        waitForReady: false,
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      });
      expect(launchRequest).toMatchObject({
        teamName,
        cwd: projectDir,
        effort: 'low',
      });
    } finally {
      await app.close().catch(() => undefined);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });
});
