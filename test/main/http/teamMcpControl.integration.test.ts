// @vitest-environment node

import { BoundControlContext } from '@features/external-agent-connection/main';
import { TeamPromptManagement } from '@features/team-prompt-management/main';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { vi } from 'vitest';
import { registerTeamRoutes } from '@main/http/teams';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride, setAppDataBasePath } from '@main/utils/pathDecoder';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { registerTools } from '../../../mcp-server/src/tools';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpHandlerApis,
  TeamHttpMemberDiagnosticsApi,
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
  TeamChangeEvent,
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

function createServices(claudeRoot: string): {
  createTeamCalls: TeamCreateRequest[];
  teamDataService: TeamDataService;
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

  const teamProvisioningStartApi = {
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

  const teamMemberDiagnosticsApi = {
    getMemberSpawnStatusesReadOnly: () =>
      Promise.reject(new Error('Unexpected member diagnostics call in the MCP control fixture')),
    getTeamAgentRuntimeSnapshotReadOnly: () =>
      Promise.reject(new Error('Unexpected member diagnostics call in the MCP control fixture')),
  } satisfies TeamHttpMemberDiagnosticsApi;

  return {
    createTeamCalls,
    teamDataService,
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
        memberDiagnostics: teamMemberDiagnosticsApi,
      } satisfies TeamHttpHandlerApis,
    },
  };
}

function enableManagement(services: HttpServices, teamDataService: TeamDataService, root: string) {
  setAppDataBasePath(path.join(root, 'app-state'));
  const backup = new TeamBackupService(teamDataService);
  const lifecycle = new TeamProvisioningService();
  teamDataService.setConfigurationGate((name, operation) =>
    lifecycle.runLiveRosterMutation(name, operation)
  );
  const context = new BoundControlContext('management-test-app', root);
  const events: TeamChangeEvent[] = [];
  services.teamPromptManagement = new TeamPromptManagement({
    run: (name, operation) => teamDataService.runConfigurationOperation(name, operation),
    async withExpectedContext(expected, operation) {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    getContext: async () => context.snapshot(),
    getRuntimeState: (name) => services.teamApis!.runtime.getRuntimeState(name),
    getSavedRequest: (name) => teamDataService.getSavedRequest(name),
    getTeamData: (name) => teamDataService.getTeamData(name),
    createTeamConfig: (request) => teamDataService.createTeamConfig(request),
    updateConfig: (name, updates) => teamDataService.updateConfig(name, updates),
    replaceMembers: (name, request) => teamDataService.replaceMembers(name, request),
    deleteTeam: (name) => teamDataService.deleteTeam(name),
    emit: (event) => {
      events.push(event);
    },
  });
  return { context, events, lifecycle, backup };
}

describe('MCP team tools over the local REST control API', () => {
  const tools = collectTools();

  function getTool(name: string): RegisteredTool {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  // Catches management writes bypassing immutable context/revision, runtime flags being lost,
  // roster removal resurrecting old identities, or draft trash accidentally deleting artifacts.
  it('manages providerless drafts through MCP, preserving saved runtime fields and reversible trash', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-team-management-'));
    setClaudeBasePathOverride(root);
    const app = Fastify();
    const { services, teamDataService, createTeamCalls } = createServices(root);
    const { context, events } = enableManagement(services, teamDataService, root);
    const expectedContext = context.snapshot();
    registerTeamRoutes(app, services);
    const controlUrl = 'http://team-management.test';
    const restoreFetch = installControlApiFetchMock(app, controlUrl);
    const teamName = 'managed-draft';
    const base = { claudeDir: root, controlUrl, teamName, expectedContext };
    const get = async () =>
      parseJsonToolResult(await getTool('team_get').execute(base)) as {
        configurationRevision: string;
        deletedAt?: string;
        savedRequest: TeamCreateRequest;
      };
    try {
      const created = parseJsonToolResult(
        await getTool('team_create').execute({
          ...base,
          runtimeSelectionVersion: 1,
          description: 'Initial',
          prompt: 'Saved lead instructions',
          members: [
            {
              name: 'builder',
              role: 'Developer',
              workflow: 'Implement',
              providerId: 'codex',
              model: 'test-model',
              isolation: 'worktree',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        })
      ) as { change: { kind: string; context: unknown } };
      expect(created.change).toMatchObject({ kind: 'created', context: expectedContext });
      const initial = await get();
      expect(initial.savedRequest).toMatchObject({
        runtimeSelectionVersion: 1,
        prompt: 'Saved lead instructions',
      });
      const edited = parseJsonToolResult(
        await getTool('team_update').execute({
          ...base,
          expectedRevision: initial.configurationRevision,
          metadata: { displayName: 'Readable name', description: '' },
        })
      ) as { configurationRevision: string; change: { changedFields: string[] } };
      expect(edited.change.changedFields).toEqual(['displayName', 'description']);
      expect(edited.configurationRevision).not.toBe(initial.configurationRevision);
      const stale = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/update`,
        payload: {
          expectedContext,
          expectedRevision: initial.configurationRevision,
          leadInstructions: 'Stale overwrite',
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('TEAM_REVISION_MISMATCH');
      const current = await get();
      const noOp = parseJsonToolResult(
        await getTool('team_update').execute({
          ...base,
          expectedRevision: current.configurationRevision,
          metadata: { displayName: 'Readable name' },
        })
      ) as { changed: boolean };
      expect(noOp.changed).toBe(false);
      expect(events).toHaveLength(2);
      const savedMember = (await new TeamMembersMetaStore().getMembers(teamName))[0];
      await new TeamMembersMetaStore().writeMembers(teamName, [
        { ...savedMember, agentId: 'old-builder-id', cwd: '/sandbox/worktree' },
      ]);
      let snapshot = await get();
      await getTool('team_update').execute({
        ...base,
        expectedRevision: snapshot.configurationRevision,
        members: [{ name: 'builder', role: 'Reviewer', workflow: 'Review' }],
      });
      expect((await new TeamMembersMetaStore().getMembers(teamName))[0]).toMatchObject({
        agentId: 'old-builder-id',
        cwd: '/sandbox/worktree',
        providerId: 'codex',
        model: 'test-model',
        isolation: 'worktree',
        mcpPolicy: { mode: 'appOnly' },
        role: 'Reviewer',
      });
      snapshot = await get();
      await getTool('team_update').execute({
        ...base,
        expectedRevision: snapshot.configurationRevision,
        members: [
          { name: 'zeta', role: 'Developer' },
          { name: 'alpha', role: 'Reviewer' },
        ],
      });
      const renamed = await new TeamMembersMetaStore().getMembers(teamName);
      expect(renamed.find((member) => member.name === 'builder')).toMatchObject({
        removedAt: expect.any(Number),
        agentId: 'old-builder-id',
      });
      expect(renamed.find((member) => member.name === 'zeta')?.agentId).toBeUndefined();
      // Canonical storage order must not turn an unsorted successful edit into uncertainty,
      // or make an equivalent reordered roster write again and publish another Edited fact.
      expect(renamed.filter((member) => !member.removedAt).map((member) => member.name)).toEqual([
        'alpha',
        'zeta',
      ]);
      snapshot = await get();
      const beforeReorderEvents = events.length;
      const reordered = parseJsonToolResult(
        await getTool('team_update').execute({
          ...base,
          expectedRevision: snapshot.configurationRevision,
          members: [
            { name: 'alpha', role: 'Reviewer' },
            { name: 'zeta', role: 'Developer' },
          ],
        })
      ) as { changed: boolean; configurationRevision: string };
      expect(reordered).toMatchObject({
        changed: false,
        configurationRevision: snapshot.configurationRevision,
      });
      expect(events).toHaveLength(beforeReorderEvents);
      const invalid = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/update`,
        payload: {
          expectedContext,
          expectedRevision: snapshot.configurationRevision,
          metadata: { providerId: 'anthropic' },
        },
      });
      expect(invalid.statusCode).toBe(400);
      const foreign = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/trash`,
        payload: {
          expectedContext: { ...expectedContext, appInstanceId: 'foreign-app' },
          expectedRevision: snapshot.configurationRevision,
        },
      });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json().code).toBe('APP_CONTEXT_MISMATCH');
      await getTool('team_update').execute({
        ...base,
        expectedRevision: snapshot.configurationRevision,
        leadInstructions: '',
      });
      snapshot = await get();
      expect(snapshot.savedRequest.prompt).toBeUndefined();
      await getTool('team_trash').execute({
        ...base,
        expectedRevision: snapshot.configurationRevision,
      });
      const trashed = await get();
      expect(trashed.deletedAt).toEqual(expect.any(String));
      expect(
        (await teamDataService.listTeams()).find((team) => team.teamName === teamName)?.deletedAt
      ).toBe(trashed.deletedAt);
      const repeated = parseJsonToolResult(
        await getTool('team_trash').execute({
          ...base,
          expectedRevision: trashed.configurationRevision,
        })
      ) as { changed: boolean };
      expect(repeated.changed).toBe(false);
      const rejectedUpdate = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/update`,
        payload: { expectedContext, expectedRevision: trashed.configurationRevision, members: [] },
      });
      expect(rejectedUpdate.json().code).toBe('TEAM_TRASHED');
      const launch = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/launch`,
        payload: { cwd: root, providerId: 'codex' },
      });
      expect(launch.statusCode).toBe(409);
      expect(createTeamCalls).toHaveLength(0);
      expect(
        JSON.parse(await readFile(path.join(root, 'teams', teamName, 'members.meta.json'), 'utf8'))
          .members
      ).toHaveLength(3);
      await expect(
        readFile(path.join(root, 'teams', teamName, 'config.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await teamDataService.restoreTeam(teamName);
      expect((await get()).deletedAt).toBeUndefined();
      expect(await new TeamMetaStore().getMeta(teamName)).toMatchObject({
        runtimeSelectionVersion: 1,
        displayName: 'Readable name',
      });
      expect(events.filter((event) => event.management?.kind === 'trashed')).toHaveLength(1);
    } finally {
      restoreFetch();
      await app.close();
      setAppDataBasePath(null);
      setClaudeBasePathOverride(null);
      TeamConfigReader.clearCacheForTests();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Catches admission checked before a queued launch, stale overwrites, and claiming a failed
  // mutation after its canonical writer committed but an observer/read response failed.
  it('fences stopped edits against launch and returns confirmed commits despite post-write faults', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-team-management-race-'));
    setClaudeBasePathOverride(root);
    const app = Fastify();
    const { services, teamDataService } = createServices(root);
    const { context, events } = enableManagement(services, teamDataService, root);
    registerTeamRoutes(app, services);
    const teamName = 'stopped-team';
    const expectedContext = context.snapshot();
    const configPath = path.join(root, 'teams', teamName, 'config.json');
    const get = async () =>
      (await app.inject({ method: 'GET', url: `/api/teams/${teamName}` })).json() as {
        configurationRevision: string;
        savedRequest: TeamCreateRequest | null;
      };
    const update = (expectedRevision: string, metadata: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/update`,
        payload: { expectedContext, expectedRevision, metadata },
      });
    try {
      await teamDataService.createTeamConfig({
        teamName,
        runtimeSelectionVersion: 1,
        members: [],
        prompt: 'Preserve saved lead instructions',
        description: 'Initial',
        cwd: root,
      });
      await writeFile(
        configPath,
        JSON.stringify({
          name: 'Initial',
          description: 'Initial',
          projectPath: root,
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        })
      );
      let snapshot = await get();
      // Lost mutation responses must be recoverable from authoritative stopped-team readback.
      const leadEdit = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamName}/update`,
        payload: {
          expectedContext,
          expectedRevision: snapshot.configurationRevision,
          leadInstructions: 'Edited stopped lead instructions',
        },
      });
      expect(leadEdit.statusCode).toBe(200);
      snapshot = await get();
      expect(snapshot.savedRequest?.prompt).toBe('Edited stopped lead instructions');
      const originalWriter = teamDataService.updateConfig.bind(teamDataService);
      const writer = vi
        .spyOn(teamDataService, 'updateConfig')
        .mockImplementation(async (name, metadata) => {
          await originalWriter(name, metadata);
          throw new Error('Simulated post-commit observer failure');
        });
      const confirmed = await update(snapshot.configurationRevision, {
        description: 'Saved after fault',
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({
        changed: true,
        change: { kind: 'edited', changedFields: ['description'] },
      });
      expect(await new TeamMetaStore().getMeta(teamName)).toMatchObject({
        description: 'Saved after fault',
        prompt: 'Edited stopped lead instructions',
        runtimeSelectionVersion: 1,
      });
      writer.mockRestore();
      snapshot = await get();
      const observer = vi.spyOn(events, 'push').mockImplementation(() => {
        throw new Error('Simulated event delivery failure');
      });
      expect((await update(snapshot.configurationRevision, { color: 'blue' })).statusCode).toBe(
        200
      );
      observer.mockRestore();
      snapshot = await get();
      let release!: () => void;
      const launch = teamDataService.runConfigurationOperation(teamName, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await originalWriter(teamName, { name: 'Launch won' });
      });
      const staleEdit = update(snapshot.configurationRevision, { description: 'Overwrite launch' });
      release();
      await launch;
      const staleResult = await staleEdit;
      expect(staleResult.statusCode).toBe(409);
      expect(staleResult.json().code).toBe('TEAM_REVISION_MISMATCH');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        name: 'Launch won',
        description: 'Saved after fault',
      });
      const idle = services.teamApis!.runtime.getRuntimeState;
      services.teamApis!.runtime.getRuntimeState = async (name) => ({
        teamName: name,
        isAlive: true,
        runId: 'test-alive',
        progress: null,
      });
      snapshot = await get();
      const active = await update(snapshot.configurationRevision, {
        description: 'Active overwrite',
      });
      expect(active.json().code).toBe('TEAM_ACTIVE');
      services.teamApis!.runtime.getRuntimeState = async (name) => ({
        teamName: name,
        isAlive: false,
        runId: 'test-provisioning',
        progress: {
          teamName: name,
          runId: 'test-provisioning',
          state: 'assembling',
          message: 'Test fixture',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      const provisioning = await update(snapshot.configurationRevision, {
        description: 'Provisioning overwrite',
      });
      expect(provisioning.json().code).toBe('TEAM_PROVISIONING');
      services.teamApis!.runtime.getRuntimeState = idle;
      const failure = vi
        .spyOn(teamDataService, 'updateConfig')
        .mockRejectedValueOnce(new Error('Write failed before commit'));
      const unconfirmed = await update(snapshot.configurationRevision, {
        description: 'Not saved',
      });
      expect(unconfirmed.statusCode).toBe(409);
      expect(unconfirmed.json()).toMatchObject({
        code: 'TEAM_MUTATION_UNCERTAIN',
        outcome: { state: 'partial', configurationRevision: snapshot.configurationRevision },
      });
      failure.mockRestore();
      expect(JSON.parse(await readFile(configPath, 'utf8')).description).toBe('Saved after fault');
    } finally {
      vi.restoreAllMocks();
      await app.close();
      setAppDataBasePath(null);
      setClaudeBasePathOverride(null);
      TeamConfigReader.clearCacheForTests();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Catches update recreating a detached directory or editing a replacement with an old revision.
  // Uses the same backup constructor wiring as desktop main, with real storage and HTTP admission.
  it('orders management against permanent deletion and a same-name replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-team-management-identity-'));
    setClaudeBasePathOverride(root);
    const app = Fastify();
    const { services, teamDataService } = createServices(root);
    const { context, backup, events } = enableManagement(services, teamDataService, root);
    registerTeamRoutes(app, services);
    const teamName = 'identity-team';
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await teamDataService.createTeamConfig({
        teamName,
        cwd: root,
        members: [],
        prompt: 'Original',
      });
      const original = await services.teamPromptManagement!.get(teamName);
      const deletion = backup.withTeamIdentityFence(teamName, async () => {
        entered();
        await barrier;
        expect(await teamDataService.permanentlyDeleteTeam(teamName)).toBe(true);
        await teamDataService.createTeamConfig({
          teamName,
          cwd: root,
          members: [],
          prompt: 'Replacement',
        });
      });
      await held;
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const originalAdmit = context.admit.bind(context);
      const observeAdmission = vi.spyOn(context, 'admit').mockImplementation((expected) => {
        const releaseContext = originalAdmit(expected);
        admitted();
        return releaseContext;
      });
      const pending = app
        .inject({
          method: 'POST',
          url: `/api/teams/${teamName}/update`,
          payload: {
            expectedContext: context.snapshot(),
            expectedRevision: original.configurationRevision,
            metadata: { description: 'Old request' },
          },
        })
        .then((response) => response);
      await admission;
      release();
      await deletion;
      const result = await pending;
      observeAdmission.mockRestore();
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('TEAM_REVISION_MISMATCH');
      const replacement = await services.teamPromptManagement!.get(teamName);
      expect(replacement.configurationRevision).not.toBe(original.configurationRevision);
      expect(replacement.savedRequest).toMatchObject({ prompt: 'Replacement' });
      expect(replacement.savedRequest?.description).toBeUndefined();
      expect(events).toHaveLength(0);
    } finally {
      release?.();
      vi.restoreAllMocks();
      await app.close();
      setAppDataBasePath(null);
      setClaudeBasePathOverride(null);
      TeamConfigReader.clearCacheForTests();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      ) as {
        teamName: string;
        draft: true;
        runtimeSelection: 'selected' | 'unresolved';
        runtimeSelectionVersion?: 1;
      };
      expect(created).toEqual({
        teamName: 'mcp-e2e-team',
        draft: true,
        runtimeSelection: 'selected',
      });

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
    services.teamApis!.provisioningStart!.launchTeam = (
      request: TeamLaunchRequest
    ): Promise<TeamLaunchResponse> => {
      launchRequest = request;
      return Promise.resolve({
        runId: 'active-run-1',
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      });
    };
    services.teamApis!.provisioningStatus!.getProvisioningStatus = () =>
      Promise.reject(
        new Error('team_launch should not wait for provisioning status after already_launching')
      );
    registerTeamRoutes(app, services);

    const controlUrl = 'http://agent-teams-control-active.test';
    const restoreFetch = installControlApiFetchMock(app, controlUrl);
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
      restoreFetch();
      await app.close().catch(() => undefined);
      await rm(claudeRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });
});
