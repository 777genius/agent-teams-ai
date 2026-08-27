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
  TeamHttpHandlerApis,
  TeamHttpRuntimeApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
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

interface DesktopLaunchAuthorizationFixture {
  authorizedAt: string;
  cwd: string;
  executionProof: {
    expiresAt: string;
    model: string;
    providerBackendId: string;
    verifiedAt: string;
  };
  expiresAt: string;
  model: string;
  providerBackendId: string;
  rosterMemberNames: string[];
  teamName: string;
  transactionId: string;
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
  return typeof body === 'string' ? body : JSON.stringify(body);
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
    if (!request && typeof input !== 'string' && !(input instanceof URL)) {
      return originalFetch(input, init);
    }
    const requestUrl = request?.url ?? (input instanceof URL ? input.href : String(input));
    const url = new URL(requestUrl);
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

function createDesktopLaunchAuthorizationFixture(
  target: Pick<
    DesktopLaunchAuthorizationFixture,
    'cwd' | 'model' | 'providerBackendId' | 'rosterMemberNames' | 'teamName'
  >
): DesktopLaunchAuthorizationFixture {
  const authorizedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    ...target,
    transactionId: `test-only-roster-authorization-${target.teamName}`,
    authorizedAt,
    expiresAt,
    executionProof: {
      providerBackendId: target.providerBackendId,
      model: target.model,
      verifiedAt: authorizedAt,
      expiresAt,
    },
  };
}

function createServices(
  claudeRoot: string,
  desktopAuthorization?: DesktopLaunchAuthorizationFixture,
  launchResponse?: TeamLaunchResponse
): {
  configureDraftTeamForTest: (teamName: string) => Promise<void>;
  launchTeamCalls: TeamLaunchRequest[];
  services: HttpServices;
} {
  const teamDataService = new TeamDataService();
  const launchTeamCalls: TeamLaunchRequest[] = [];
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

  async function configureDraftTeamForTest(teamName: string): Promise<void> {
    const savedRequest = await teamDataService.getSavedRequest(teamName);
    if (!savedRequest) {
      throw new Error(`Missing test-only draft request for ${teamName}`);
    }
    if (desktopAuthorization?.teamName === teamName) {
      expect(savedRequest.members.map((member) => member.name)).toEqual(
        desktopAuthorization.rosterMemberNames
      );
    }
    await persistLaunchedConfig(savedRequest);
  }

  function assertCurrentDesktopAuthorization(
    request: Pick<TeamCreateRequest, 'cwd' | 'model' | 'providerBackendId' | 'teamName'>
  ): void {
    if (!desktopAuthorization) {
      throw new Error('Missing test-only desktop roster authorization transaction');
    }
    expect(Date.parse(desktopAuthorization.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(desktopAuthorization.executionProof.expiresAt)).toBeGreaterThan(Date.now());
    expect(desktopAuthorization.executionProof).toMatchObject({
      providerBackendId: request.providerBackendId,
      model: request.model,
    });
    expect(desktopAuthorization).toMatchObject({
      teamName: request.teamName,
      cwd: request.cwd,
      providerBackendId: request.providerBackendId,
      model: request.model,
    });
  }

  async function createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    assertCurrentDesktopAuthorization(request);
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

  const teamProvisioningStartApi = {
    // This test-only adapter stands in for the desktop boundary after it has
    // admitted the exact current roster transaction and execution proof above.
    requiresAuthoritativeLaunchProof: desktopAuthorization ? false : true,
    createTeam,
    launchTeam: async (
      request: TeamLaunchRequest,
      onProgress: (progress: TeamProvisioningProgress) => void
    ): Promise<TeamLaunchResponse> => {
      assertCurrentDesktopAuthorization(request);
      launchTeamCalls.push(request);
      if (launchResponse) {
        return launchResponse;
      }
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
    },
  } satisfies TeamProvisioningStartApi;
  const teamProvisioningStatusApi = {
    getProvisioningStatus: (runId: string): Promise<TeamProvisioningProgress> => {
      const progress = progressByRunId.get(runId);
      if (!progress) {
        throw new Error('Unknown runId');
      }
      return Promise.resolve(progress);
    },
  } satisfies TeamProvisioningStatusApi;
  const teamTaskActivityRepairApi = {
    repairStaleTaskActivityIntervalsBeforeSnapshot: (): Promise<void> => Promise.resolve(),
  } satisfies TeamTaskActivityRepairApi;
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
    answerOpenCodeRuntimePermission: (): Promise<OpenCodeRuntimeControlAck> =>
      Promise.resolve(runtimeAck('accepted')),
  } satisfies TeamRuntimeControlCompatibilityApi;

  return {
    configureDraftTeamForTest,
    launchTeamCalls,
    services: {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataApi: teamDataService,
      teamApis: {
        provisioningStart: teamProvisioningStartApi,
        provisioningStatus: teamProvisioningStatusApi,
        taskActivity: teamTaskActivityRepairApi,
        runtime: teamRuntimeApi,
        runtimeControl: teamRuntimeControlApi,
      } satisfies TeamHttpHandlerApis,
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
    const desktopAuthorization = createDesktopLaunchAuthorizationFixture({
      teamName: 'mcp-e2e-team',
      cwd: projectDir,
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      rosterMemberNames: ['builder'],
    });
    const { configureDraftTeamForTest, launchTeamCalls, services } = createServices(
      claudeRoot,
      desktopAuthorization
    );
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

      // Production-safe creation remains draft-only. Materialize config.json only
      // through this explicit fixture so MCP board admission sees a configured team
      // without starting a provider, terminal, or teammate process.
      await configureDraftTeamForTest('mcp-e2e-team');

      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
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
      expect(desktopAuthorization.transactionId).toBe(
        'test-only-roster-authorization-mcp-e2e-team'
      );
      expect(launchTeamCalls).toHaveLength(1);
      expect(launchTeamCalls[0]).toMatchObject({
        teamName: 'mcp-e2e-team',
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
    const desktopAuthorization = createDesktopLaunchAuthorizationFixture({
      teamName,
      cwd: projectDir,
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      rosterMemberNames: [],
    });
    const { configureDraftTeamForTest, launchTeamCalls, services } = createServices(
      claudeRoot,
      desktopAuthorization,
      {
        runId: 'active-run-1',
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      }
    );
    services.teamApis!.provisioningStatus!.getProvisioningStatus = () =>
      Promise.reject(
        new Error('team_launch should not wait for provisioning status after already_launching')
      );
    registerTeamRoutes(app, services);

    const controlUrl = 'http://agent-teams-control-active.test';
    const restoreFetch = installControlApiFetchMock(app, controlUrl);
    try {
      await getTool('team_create').execute({
        claudeDir: claudeRoot,
        controlUrl,
        teamName,
        cwd: projectDir,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        members: [],
      });
      await configureDraftTeamForTest(teamName);

      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName,
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
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
      expect(launchTeamCalls).toHaveLength(1);
      expect(launchTeamCalls[0]).toMatchObject({
        teamName,
        cwd: projectDir,
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        effort: 'minimal',
      });
    } finally {
      restoreFetch();
      await app.close().catch(() => undefined);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it('fails HTTP launch closed without a desktop roster authorization transaction', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'agent-teams-control-unauthorized-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-project-unauthorized-'));
    const teamName = 'mcp-unauthorized-launch';
    setClaudeBasePathOverride(claudeRoot);

    const app = Fastify();
    const { configureDraftTeamForTest, launchTeamCalls, services } = createServices(claudeRoot);
    registerTeamRoutes(app, services);

    const controlUrl = 'http://agent-teams-control-unauthorized.test';
    const restoreFetch = installControlApiFetchMock(app, controlUrl);
    try {
      await getTool('team_create').execute({
        claudeDir: claudeRoot,
        controlUrl,
        teamName,
        cwd: projectDir,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        members: [],
      });
      await configureDraftTeamForTest(teamName);

      const response = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/launch`,
        payload: {
          cwd: projectDir,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('desktop roster authorization transaction');
      expect(response.json().error).toContain('current exact-model execution proof');
      expect(launchTeamCalls).toHaveLength(0);
    } finally {
      restoreFetch();
      await app.close().catch(() => undefined);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });
});
