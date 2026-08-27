// @vitest-environment node

import { registerTeamRoutes } from '@main/http/teams';
import { attachExecutionProofToPrepareResult } from '@main/ipc/teams/attachExecutionProofToPrepareResult';
import { admitProductionTeamRosterLaunch } from '@main/ipc/teams/ensureProductionRosterLaunchTransaction';
import {
  markNativeModelTargetedLiveness,
} from '@main/services/team/provisioning/TeamProvisioningLaunchPreparationEvidence';
import { TeamDataService } from '@main/services/team/TeamDataService';
import {
  captureAuthoritativeProofEpoch,
  invalidateAuthoritativeModelExecutionProofs,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { crossRosterLaunchInvocationBoundary } from '@main/services/team/TeamMembersMetaStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { buildEffectiveRuntimeRosterRevision } from '@shared/utils/effectiveMemberRuntimeIdentity';
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
  TeamMember,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

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

const TEST_LEAD_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'explicit' as const,
  model: 'explicit' as const,
  effort: 'explicit' as const,
};

const TEST_MEMBER_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'inherited' as const,
  model: 'inherited' as const,
  effort: 'inherited' as const,
};

function canonicalDesktopRoster(memberName = 'builder'): TeamMember[] {
  return [
    {
      name: memberName,
      role: 'Engineer',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'high',
      runtimeSelectionProvenance: TEST_MEMBER_PROVENANCE,
    },
  ];
}

function canonicalDesktopLaunchRequest(
  cwd: string,
  teamName: string,
  overrides: Partial<TeamLaunchRequest> = {}
): TeamLaunchRequest {
  return {
    teamName,
    cwd,
    prompt: 'Coordinate the test task',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.2',
    effort: 'high',
    leadRuntimeSelectionProvenance: TEST_LEAD_PROVENANCE,
    ...overrides,
  };
}

function prepareDesktopExecutionProof(request: TeamLaunchRequest, roster: TeamMember[]) {
  const checks: TeamProvisioningModelCheckRequest[] = [
    {
      providerId: request.providerId!,
      providerBackendId: request.providerBackendId!,
      model: request.model!,
      effort: request.effort,
    },
  ];
  const runtimeRosterRevision = buildEffectiveRuntimeRosterRevision({
    lead: {
      providerId: request.providerId!,
      providerBackendId: request.providerBackendId,
      model: request.model,
      effort: request.effort,
    },
    leadRuntimeSelectionProvenance: request.leadRuntimeSelectionProvenance,
    members: roster,
    missingProvenance: 'reject',
  });
  if (!runtimeRosterRevision) throw new Error('Canonical test roster did not resolve');

  const prepared = attachExecutionProofToPrepareResult({
    authorityEpoch: captureAuthoritativeProofEpoch(request.cwd),
    result: markNativeModelTargetedLiveness(
      {
        ready: true,
        message: 'Fake exact-model probe completed',
        processedModelChecks: checks,
      } satisfies TeamProvisioningPrepareResult,
      checks
    ),
    cwd: request.cwd,
    mode: 'deep',
    checks,
    runtimeRosterRevision,
  });
  if (!prepared.ready || !prepared.executionProof) {
    throw new Error(prepared.message || 'Desktop proof preparation failed');
  }
  return prepared.executionProof;
}

async function runDesktopAuthorizedFakeLaunch(input: {
  service: TeamDataService;
  request: TeamLaunchRequest;
  roster: TeamMember[];
  response?: TeamLaunchResponse;
  onFakeSpawn?: (request: TeamLaunchRequest) => void;
}): Promise<TeamLaunchResponse> {
  const admitted = await admitProductionTeamRosterLaunch(
    input.service,
    input.request,
    undefined,
    true,
    input.roster
  );
  return admitted.context.run(admitted.request, async (boundRequest) => {
    const binding = boundRequest.rosterLaunchBinding;
    expect(binding).toMatchObject({
      transactionId: admitted.request.rosterTransactionId,
      teamName: input.request.teamName,
      rosterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      rosterRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      launchCommandId: admitted.request.rosterTransactionId,
      launchRequestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      executionProof: {
        authorityId: expect.any(String),
        generation: expect.any(Number),
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    if (input.response?.launchStatus === 'already_launching') return input.response;

    const invocation = await crossRosterLaunchInvocationBoundary();
    invocation.invoke(() => input.onFakeSpawn?.(boundRequest));
    return {
      runId: binding!.launchCommandId,
      launchStatus: 'not_started',
      ...input.response,
    };
  });
}

function createServices(claudeRoot: string): {
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
    await persistLaunchedConfig(savedRequest);
  }

  async function createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
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
    requiresAuthoritativeLaunchProof: true,
    createTeam,
    launchTeam: async (
      request: TeamLaunchRequest,
      onProgress: (progress: TeamProvisioningProgress) => void
    ): Promise<TeamLaunchResponse> => {
      launchTeamCalls.push(request);
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

  it('creates, gets, and lists a draft through MCP while production HTTP launch fails closed', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'agent-teams-control-e2e-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-project-e2e-'));
    setClaudeBasePathOverride(claudeRoot);

    const app = Fastify();
    const { configureDraftTeamForTest, launchTeamCalls, services } = createServices(claudeRoot);
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

      await expect(
        getTool('team_launch').execute({
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
      ).rejects.toThrow('desktop roster authorization transaction');
      expect(launchTeamCalls).toHaveLength(0);

      const restRuntime = await fetchJson(controlUrl, '/api/teams/mcp-e2e-team/runtime');
      expect(restRuntime.status).toBe(200);
      expect(restRuntime.body).toMatchObject({
        teamName: 'mcp-e2e-team',
        isAlive: false,
        runId: null,
      });

      const restListAfterLaunch = await fetchJson(controlUrl, '/api/teams');
      expect(restListAfterLaunch.status).toBe(200);
      const configuredListItem = (restListAfterLaunch.body as Record<string, unknown>[]).find(
        (team) => team.teamName === 'mcp-e2e-team'
      );
      expect(configuredListItem).toMatchObject({
        teamName: 'mcp-e2e-team',
        displayName: 'MCP E2E Team',
        pendingCreate: true,
      });

      const mcpConfiguredTeam = parseJsonToolResult(
        await getTool('team_get').execute({
          claudeDir: claudeRoot,
          controlUrl,
          teamName: 'mcp-e2e-team',
        })
      );
      expect(mcpConfiguredTeam).toMatchObject({
        teamName: 'mcp-e2e-team',
        config: {
          name: 'MCP E2E Team',
          projectPath: projectDir,
        },
        members: expect.arrayContaining([
          expect.objectContaining({ name: 'builder', role: 'Engineer' }),
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

  it('returns active provisioning re-entry without waiting after real desktop admission', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'agent-teams-control-active-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-project-active-'));
    const teamName = 'mcp-active-launch';
    setClaudeBasePathOverride(claudeRoot);
    try {
      await mkdir(path.join(claudeRoot, 'teams', teamName), { recursive: true });
      const roster = canonicalDesktopRoster();
      const request = canonicalDesktopLaunchRequest(projectDir, teamName);
      request.executionProof = prepareDesktopExecutionProof(request, roster);
      const service = new TeamDataService();
      const launched = await runDesktopAuthorizedFakeLaunch({
        service,
        request,
        roster,
        response: {
          runId: 'active-run-1',
          launchStatus: 'already_launching',
          alreadyLaunching: true,
        },
      });
      expect(launched).toMatchObject({
        runId: 'active-run-1',
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      });
    } finally {
      invalidateAuthoritativeModelExecutionProofs();
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it('uses an exact prepared binding once and rejects reuse before a second fake spawn', async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), 'desktop-authority-current-'));
    const projectDir = await mkdtemp(path.join(tmpdir(), 'desktop-authority-project-'));
    const teamName = 'desktop-authority-current';
    setClaudeBasePathOverride(claudeRoot);
    try {
      await mkdir(path.join(claudeRoot, 'teams', teamName), { recursive: true });
      const roster = canonicalDesktopRoster();
      const request = canonicalDesktopLaunchRequest(projectDir, teamName);
      request.executionProof = prepareDesktopExecutionProof(request, roster);
      const preparedProof = request.executionProof;
      const service = new TeamDataService();
      let fakeSpawnCount = 0;

      const admitted = await admitProductionTeamRosterLaunch(
        service,
        request,
        undefined,
        true,
        roster
      );
      const admittedProof = admitted.request.executionProof!;
      expect(admittedProof.authorityId).not.toBe(preparedProof.authorityId);
      expect(admittedProof.requestDigest).not.toBe(preparedProof.requestDigest);
      expect(admittedProof.generation).toBeGreaterThan(preparedProof.generation);
      const launch = (boundRequest: TeamLaunchRequest) =>
        admitted.context.run(boundRequest, async (exactRequest) => {
          expect(exactRequest.rosterLaunchBinding?.executionProof).toEqual(
            exactRequest.executionProof
          );
          expect(exactRequest.executionProof).toMatchObject({
            authorityId: expect.any(String),
            generation: expect.any(Number),
            requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
          expect(exactRequest.executionProof).toEqual(admittedProof);
          expect(exactRequest.rosterLaunchBinding?.launchRequestFingerprint).toMatch(
            /^[a-f0-9]{64}$/
          );
          const invocation = await crossRosterLaunchInvocationBoundary();
          invocation.invoke(() => {
            fakeSpawnCount += 1;
          });
          return {
            runId: exactRequest.rosterLaunchBinding!.launchCommandId,
            launchStatus: 'not_started' as const,
          };
        });

      await expect(launch(admitted.request)).resolves.toMatchObject({
        launchStatus: 'not_started',
      });
      await expect(launch(admitted.request)).rejects.toThrow(/stale|already used|transaction/i);
      expect(fakeSpawnCount).toBe(1);
    } finally {
      invalidateAuthoritativeModelExecutionProofs();
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it.each(['stale', 'roster-revision', 'provider', 'project', 'model'] as const)(
    'rejects %s desktop authority before launch admission or fake spawn',
    async (mismatch) => {
      const claudeRoot = await mkdtemp(path.join(tmpdir(), `desktop-authority-${mismatch}-`));
      const projectDir = await mkdtemp(path.join(tmpdir(), 'desktop-authority-project-'));
      const otherProjectDir = await mkdtemp(path.join(tmpdir(), 'desktop-authority-other-project-'));
      const teamName = `desktop-authority-${mismatch}`;
      setClaudeBasePathOverride(claudeRoot);
      try {
        await mkdir(path.join(claudeRoot, 'teams', teamName), { recursive: true });
        const canonicalRoster = canonicalDesktopRoster();
        const authorizedRequest = canonicalDesktopLaunchRequest(projectDir, teamName);
        const executionProof = prepareDesktopExecutionProof(authorizedRequest, canonicalRoster);
        const submittedRoster =
          mismatch === 'roster-revision'
            ? canonicalDesktopRoster('different-builder')
            : canonicalRoster;
        const submittedRequest = canonicalDesktopLaunchRequest(projectDir, teamName, {
          executionProof,
          ...(mismatch === 'provider'
            ? { providerId: 'opencode', providerBackendId: 'opencode-cli' }
            : {}),
          ...(mismatch === 'project' ? { cwd: otherProjectDir } : {}),
          ...(mismatch === 'model' ? { model: 'gpt-5.3' } : {}),
        });
        if (mismatch === 'stale') invalidateAuthoritativeModelExecutionProofs();

        const service = new TeamDataService();
        const beginTransaction = vi.spyOn(service, 'beginRosterAuthorizationTransaction');
        let fakeSpawnCount = 0;
        await expect(
          admitProductionTeamRosterLaunch(
            service,
            submittedRequest,
            undefined,
            true,
            submittedRoster
          ).then((admitted) =>
            admitted.context.run(admitted.request, async () => {
              fakeSpawnCount += 1;
              return { runId: 'must-not-launch' };
            })
          )
        ).rejects.toThrow('Fresh authoritative launch authorization is required');
        expect(beginTransaction).not.toHaveBeenCalled();
        expect(fakeSpawnCount).toBe(0);
      } finally {
        invalidateAuthoritativeModelExecutionProofs();
        await rm(claudeRoot, { recursive: true, force: true });
        await rm(projectDir, { recursive: true, force: true });
        await rm(otherProjectDir, { recursive: true, force: true });
        setClaudeBasePathOverride(null);
      }
    }
  );

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
