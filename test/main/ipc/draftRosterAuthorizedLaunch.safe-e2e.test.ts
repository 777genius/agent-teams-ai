import { initializeTeamHandlers, registerTeamHandlers, removeTeamHandlers } from '@main/ipc/teams';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { invalidateAuthoritativeModelExecutionProofs } from '@main/services/team/TeamLaunchExecutionProofAuthority';
import {
  crossRosterLaunchInvocationBoundary,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { TEAM_CREATE, TEAM_LAUNCH } from '@preload/constants/ipcChannels';
import { createRosterAuthorizationTransactionBridge } from '@preload/rosterAuthorizationTransactionBridge';
import { materializeConcreteLaunchRoster } from '@renderer/components/team/dialogs/authoritativeLaunchIdentity';
import { executeLaunchTeamDialogSubmissionWithRecheck } from '@renderer/components/team/dialogs/launchRosterAuthorizationTransaction';
import { buildEffectiveRuntimeRosterRevision } from '@shared/utils/effectiveMemberRuntimeIdentity';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareAuthoritativeExecutionProof } from './helpers/authoritativePreparationTestHarness';

import type { IpcResult, TeamCreateRequest, TeamCreateResponse } from '@shared/types';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}));

describe('draft roster-authorized launch fake E2E', () => {
  let sandbox = '';
  const defaultAnthropicProvenance = {
    version: 1 as const,
    providerBackendId: 'default' as const,
    model: 'explicit' as const,
    effort: 'default' as const,
  };

  afterEach(async () => {
    removeTeamHandlers(ipcMain as never);
    handlers.clear();
    setClaudeBasePathOverride(null);
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  });

  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };

  const materializeAnthropicMembers = (members: TeamCreateRequest['members']) =>
    materializeConcreteLaunchRoster({
      members: members.map((member) => ({
        ...member,
        runtimeSelectionProvenance: member.runtimeSelectionProvenance ?? {
          version: 1,
          providerBackendId: 'inherited',
          model: member.model ? 'explicit' : 'inherited',
          effort: member.effort ? 'explicit' : 'inherited',
        },
      })),
      leadProviderId: 'anthropic',
      leadBackendId: null,
      leadModel: 'claude',
      providerStatusById: new Map(),
    })!;

  const issueAnthropicExecutionProof = (members: TeamCreateRequest['members'], cwd: string) =>
    prepareAuthoritativeExecutionProof({
      cwd,
      checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
      runtimeRosterRevision: buildEffectiveRuntimeRosterRevision({
        lead: { providerId: 'anthropic', providerBackendId: null, model: 'claude' },
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        members,
        missingProvenance: 'reject',
      })!,
    });

  it('creates through an implicit proof-bound no-roster transaction before fake process behavior', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-create-ledger-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    const executionProof = issueAnthropicExecutionProof(members, project);
    const createTeam = vi.fn(async (request: TeamCreateRequest): Promise<TeamCreateResponse> => {
      expect(request.rosterTransactionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.rosterLaunchBinding?.transactionId).toBe(request.rosterTransactionId);
      expect(request.executionProof).toBeDefined();
      await expect(
        fs.stat(path.join(sandbox, 'teams', request.teamName, 'members.meta.json'))
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
      const invocationLease = await crossRosterLaunchInvocationBoundary();
      const dispatched = JSON.parse(
        await fs.readFile(
          path.join(
            sandbox,
            'teams',
            request.teamName,
            '.roster-launch-command-ledger',
            `${request.rosterTransactionId}.json`
          ),
          'utf8'
        )
      ) as { state: string };
      expect(dispatched.state).toBe('dispatched');
      await invocationLease.invoke(() =>
        fs.writeFile(
          path.join(sandbox, 'teams', request.teamName, 'bootstrap-state.json'),
          JSON.stringify({
            runId: request.rosterTransactionId,
            members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
          })
        )
      );
      return { runId: request.rosterTransactionId!, launchStatus: 'started' };
    });
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    const response = (await handlers.get(TEAM_CREATE)?.(
      { sender: {} },
      {
        teamName: 'new-team',
        cwd: project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        executionProof,
        members,
      }
    )) as IpcResult<TeamCreateResponse>;
    expect(response.success).toBe(true);
    expect(createTeam).toHaveBeenCalledTimes(1);
    const transactionId = createTeam.mock.calls[0]![0].rosterTransactionId!;
    await expect(
      service.getRosterAuthorizationTransactionOutcome('new-team', transactionId)
    ).resolves.toMatchObject({ status: 'committed', launchRunId: transactionId });
  });

  it('creates no cwd or team artifacts for missing or forged create authority', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-create-rejection-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const service = new TeamDataService();
    const begin = vi.spyOn(service, 'beginRosterAuthorizationTransaction');
    const createTeam = vi.fn();
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    const missingCwd = path.join(sandbox, 'must-not-be-created');
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    const noProof = (await handlers.get(TEAM_CREATE)?.(
      { sender: {} },
      {
        teamName: 'no-proof-team',
        cwd: missingCwd,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        members,
      }
    )) as IpcResult<TeamCreateResponse>;
    expect(noProof).toMatchObject({ success: false, error: 'cwd does not exist' });
    await expect(fs.stat(missingCwd)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(sandbox, 'teams', 'no-proof-team'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const existingCwd = path.join(sandbox, 'existing-project');
    await fs.mkdir(existingCwd);
    const forged = (await handlers.get(TEAM_CREATE)?.(
      { sender: {} },
      {
        teamName: 'forged-proof-team',
        cwd: existingCwd,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        members,
        executionProof: {
          authorityId: 'forged-authority',
          generation: 1,
          completedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requestDigest: '0'.repeat(64),
        },
      }
    )) as IpcResult<TeamCreateResponse>;
    expect(forged).toMatchObject({
      success: false,
      error: 'Fresh authoritative launch authorization is required',
    });
    await expect(fs.stat(path.join(sandbox, 'teams', 'forged-proof-team'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const provenanceProof = issueAnthropicExecutionProof(members, existingCwd);
    const wrongProvenanceMembers = members.map((member) => ({
      ...member,
      runtimeSelectionProvenance: {
        version: 1 as const,
        providerBackendId: 'inherited' as const,
        model: 'explicit' as const,
        effort: 'inherited' as const,
      },
    }));
    await expect(
      handlers.get(TEAM_CREATE)?.(
        { sender: {} },
        {
          teamName: 'wrong-provenance-team',
          cwd: existingCwd,
          providerId: 'anthropic',
          model: 'claude',
          members: wrongProvenanceMembers,
          executionProof: provenanceProof,
        }
      )
    ).resolves.toMatchObject({ success: false });

    const providerProof = issueAnthropicExecutionProof(members, existingCwd);
    await expect(
      handlers.get(TEAM_CREATE)?.(
        { sender: {} },
        {
          teamName: 'wrong-provider-team',
          cwd: existingCwd,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          members,
          executionProof: providerProof,
        }
      )
    ).resolves.toMatchObject({ success: false });

    expect(begin).not.toHaveBeenCalled();
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('launches an unchanged roster through an explicit durable no-roster transaction', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-launch-ledger-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    await service.createTeamConfig({
      teamName: 'existing-team',
      cwd: project,
      providerId: 'anthropic',
      model: 'claude',
      leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
      members,
    });
    const executionProof = issueAnthropicExecutionProof(members, project);
    const launchTeam = vi.fn(async (request) => {
      expect(request.rosterTransactionId).toMatch(/^[0-9a-f-]{36}$/);
      const invocationLease = await crossRosterLaunchInvocationBoundary();
      await invocationLease.invoke(() =>
        fs.writeFile(
          path.join(sandbox, 'teams', request.teamName, 'bootstrap-state.json'),
          JSON.stringify({
            runId: request.rosterTransactionId,
            members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
          })
        )
      );
      return { runId: request.rosterTransactionId!, launchStatus: 'started' };
    });
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam: launchTeam,
        launchTeam,
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    const response = (await handlers.get(TEAM_LAUNCH)?.(
      { sender: {} },
      {
        teamName: 'existing-team',
        cwd: project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        executionProof,
      }
    )) as IpcResult<TeamCreateResponse>;
    expect(response.success).toBe(true);
    const request = launchTeam.mock.calls[0]![0];
    expect(request.rosterLaunchBinding?.transactionId).toBe(request.rosterTransactionId);
    await expect(
      service.getRosterAuthorizationTransactionOutcome(
        'existing-team',
        request.rosterTransactionId!
      )
    ).resolves.toMatchObject({ status: 'committed' });
  });

  it('fails closed when provider authority is invalidated after binding but before dispatch', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-proof-race-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    const executionProof = issueAnthropicExecutionProof(members, project);
    const createTeam = vi.fn(async (_request: TeamCreateRequest): Promise<TeamCreateResponse> => {
      invalidateAuthoritativeModelExecutionProofs();
      await crossRosterLaunchInvocationBoundary();
      throw new Error('unreachable irreversible fake launch');
    });
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    const response = (await handlers.get(TEAM_CREATE)?.(
      { sender: {} },
      {
        teamName: 'proof-race',
        cwd: project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        executionProof,
        members,
      }
    )) as IpcResult<TeamCreateResponse>;
    expect(response.success).toBe(false);
    vi.mocked(console.error).mockClear();
    const transactionId = createTeam.mock.calls[0]?.[0].rosterTransactionId;
    expect(transactionId).toBeDefined();
    await expect(
      service.getRosterAuthorizationTransactionOutcome('proof-race', transactionId!)
    ).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(
      fs.stat(path.join(sandbox, 'teams', 'proof-race', 'bootstrap-state.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves persisted roster, ledger, locks, and runtime untouched for invalid implicit launch proof', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-launch-rejection-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    const otherProject = path.join(sandbox, 'other-project');
    await fs.mkdir(project);
    await fs.mkdir(otherProject);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    await service.createTeamConfig({
      teamName: 'existing-team',
      cwd: project,
      providerId: 'anthropic',
      model: 'claude',
      leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
      members,
    });
    const membersPath = path.join(sandbox, 'teams', 'existing-team', 'members.meta.json');
    const originalMembers = await fs.readFile(membersPath, 'utf8');
    const begin = vi.spyOn(service, 'beginRosterAuthorizationTransaction');
    const launchTeam = vi.fn();
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam: vi.fn(),
        launchTeam,
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    const invoke = (overrides: Record<string, unknown>) =>
      handlers.get(TEAM_LAUNCH)?.(
        { sender: {} },
        {
          teamName: 'existing-team',
          cwd: project,
          providerId: 'anthropic',
          model: 'claude',
          ...overrides,
        }
      ) as Promise<IpcResult<TeamCreateResponse>>;
    const forged = {
      authorityId: 'forged-authority',
      generation: 1,
      completedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestDigest: '0'.repeat(64),
    };
    const expired = {
      authorityId: 'expired-authority',
      generation: 1,
      completedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      requestDigest: '1'.repeat(64),
    };
    await expect(invoke({})).resolves.toMatchObject({ success: false });
    await expect(invoke({ executionProof: forged })).resolves.toMatchObject({ success: false });
    await expect(invoke({ executionProof: expired })).resolves.toMatchObject({ success: false });

    const wrongModel = issueAnthropicExecutionProof(members, project);
    await expect(
      invoke({ executionProof: wrongModel, model: 'claude-different' })
    ).resolves.toMatchObject({ success: false });
    const wrongProject = issueAnthropicExecutionProof(members, project);
    await expect(
      invoke({ executionProof: wrongProject, cwd: otherProject })
    ).resolves.toMatchObject({ success: false });
    const staleCatalog = issueAnthropicExecutionProof(members, project);
    invalidateAuthoritativeModelExecutionProofs();
    await expect(invoke({ executionProof: staleCatalog })).resolves.toMatchObject({
      success: false,
    });

    expect(begin).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
    expect(await fs.readFile(membersPath, 'utf8')).toBe(originalMembers);
    await expect(
      fs.stat(path.join(sandbox, 'teams', 'existing-team', '.roster-authorization-transactions'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(sandbox, 'teams', 'existing-team', '.roster-launch-command-ledger'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a saved draft untouched when implicit launch proof is invalid', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-proof-rejection-e2e-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    await service.createTeamConfig({
      teamName: 'draft-team',
      cwd: project,
      providerId: 'anthropic',
      model: 'claude',
      leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
      members,
    });
    const membersPath = path.join(sandbox, 'teams', 'draft-team', 'members.meta.json');
    const originalMembers = await fs.readFile(membersPath, 'utf8');
    const begin = vi.spyOn(service, 'beginRosterAuthorizationTransaction');
    const createTeam = vi.fn();
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    registerTeamHandlers(ipcMain as never);

    await expect(
      handlers.get(TEAM_LAUNCH)?.(
        { sender: {} },
        {
          teamName: 'draft-team',
          cwd: project,
          providerId: 'anthropic',
          model: 'claude',
          executionProof: {
            authorityId: 'forged-authority',
            generation: 1,
            completedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requestDigest: '0'.repeat(64),
          },
        }
      )
    ).resolves.toMatchObject({
      success: false,
      error: 'Fresh authoritative launch authorization is required',
    });

    expect(begin).not.toHaveBeenCalled();
    expect(createTeam).not.toHaveBeenCalled();
    expect(await fs.readFile(membersPath, 'utf8')).toBe(originalMembers);
    await expect(
      fs.stat(path.join(sandbox, 'teams', 'draft-team', '.roster-authorization-transactions'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(sandbox, 'teams', 'draft-team', '.roster-launch-command-ledger'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('consumes proof on roster persistence crash and lets fresh proof resume the exact attempt', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'production-create-persistence-crash-'));
    setClaudeBasePathOverride(sandbox);
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project);
    const service = new TeamDataService();
    const members = materializeAnthropicMembers([{ name: 'alice' }]);
    const originalBegin = service.beginRosterAuthorizationTransaction.bind(service);
    const begin = vi.spyOn(service, 'beginRosterAuthorizationTransaction');
    begin.mockImplementationOnce(async (...args) => {
      await originalBegin(...args);
      throw new Error('simulated crash after durable roster apply');
    });
    const createTeam = vi.fn(async (request: TeamCreateRequest): Promise<TeamCreateResponse> => {
      await crossRosterLaunchInvocationBoundary();
      await fs.writeFile(
        path.join(sandbox, 'teams', request.teamName, 'bootstrap-state.json'),
        JSON.stringify({
          runId: request.rosterTransactionId,
          members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
        })
      );
      return { runId: request.rosterTransactionId!, launchStatus: 'started' };
    });
    initializeTeamHandlers(service, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    registerTeamHandlers(ipcMain as never);
    const executionProof = issueAnthropicExecutionProof(members, project);
    const request = {
      teamName: 'crash-team',
      cwd: project,
      providerId: 'anthropic' as const,
      model: 'claude',
      leadRuntimeSelectionProvenance: {
        version: 1 as const,
        providerBackendId: 'default' as const,
        model: 'explicit' as const,
        effort: 'default' as const,
      },
      executionProof,
      members,
    };

    await expect(handlers.get(TEAM_CREATE)?.({ sender: {} }, request)).resolves.toMatchObject({
      success: false,
    });
    vi.mocked(console.error).mockClear();
    const firstTransactionId = begin.mock.calls[0]?.[1];
    expect(firstTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createTeam).not.toHaveBeenCalled();

    const restartedService = new TeamDataService();
    const restartedBegin = vi.spyOn(restartedService, 'beginRosterAuthorizationTransaction');
    initializeTeamHandlers(restartedService, {
      provisioningStart: {
        requiresAuthoritativeLaunchProof: true,
        createTeam,
        launchTeam: vi.fn(),
      },
    } as never);
    const transactionPath = path.join(
      sandbox,
      'teams',
      'crash-team',
      '.roster-authorization-transactions',
      `${firstTransactionId}.json`
    );
    const indexPath = path.join(sandbox, 'teams', 'crash-team', '.roster-authorization-index.json');
    const membersPath = path.join(sandbox, 'teams', 'crash-team', 'members.meta.json');
    const durableBeforeRejectedReplays = await Promise.all([
      fs.readFile(transactionPath, 'utf8'),
      fs.readFile(indexPath, 'utf8'),
      fs.readFile(membersPath, 'utf8'),
    ]);
    await expect(handlers.get(TEAM_CREATE)?.({ sender: {} }, request)).resolves.toMatchObject({
      success: false,
      error: 'Fresh authoritative launch authorization is required',
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(restartedBegin).not.toHaveBeenCalled();
    await expect(
      Promise.all([
        fs.readFile(transactionPath, 'utf8'),
        fs.readFile(indexPath, 'utf8'),
        fs.readFile(membersPath, 'utf8'),
      ])
    ).resolves.toEqual(durableBeforeRejectedReplays);

    const alteredProof = issueAnthropicExecutionProof(members, project);
    await expect(
      handlers.get(TEAM_CREATE)?.(
        { sender: {} },
        { ...request, prompt: 'different exact request', executionProof: alteredProof }
      )
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('busy with recoverable transaction'),
    });
    expect(restartedBegin).toHaveBeenCalledTimes(1);
    await expect(
      Promise.all([
        fs.readFile(transactionPath, 'utf8'),
        fs.readFile(indexPath, 'utf8'),
        fs.readFile(membersPath, 'utf8'),
      ])
    ).resolves.toEqual(durableBeforeRejectedReplays);
    await expect(
      fs.readdir(path.join(sandbox, 'teams', 'crash-team', '.roster-authorization-transactions'))
    ).resolves.toHaveLength(1);

    const freshProof = issueAnthropicExecutionProof(members, project);
    await expect(
      handlers.get(TEAM_CREATE)?.({ sender: {} }, { ...request, executionProof: freshProof })
    ).resolves.toMatchObject({ success: true });
    expect(restartedBegin).toHaveBeenCalledTimes(2);
    expect(restartedBegin.mock.calls[1]?.[1]).not.toBe(firstTransactionId);
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(createTeam.mock.calls[0]?.[0].rosterTransactionId).toBe(firstTransactionId);
    await expect(
      restartedService.getRosterAuthorizationTransactionOutcome('crash-team', firstTransactionId!)
    ).resolves.toMatchObject({ status: 'committed', launchRunId: firstTransactionId });
  });

  it.each([
    { label: 'unchanged', requested: [{ name: 'alice', role: 'Reviewer' }] },
    { label: 'edited', requested: [{ name: 'bob', role: 'Implementer' }] },
  ])(
    'launches the $label canonical roster without rewriting its metadata',
    async ({ requested }) => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-roster-launch-e2e-'));
      setClaudeBasePathOverride(sandbox);
      const project = path.join(sandbox, 'project');
      await fs.mkdir(project);
      const service = new TeamDataService();
      const configuredMembers = materializeAnthropicMembers([{ name: 'alice', role: 'Reviewer' }]);
      await service.createTeamConfig({
        teamName: 'draft-team',
        displayName: 'Draft Team',
        cwd: project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
        members: configuredMembers,
      });
      const membersPath = path.join(sandbox, 'teams', 'draft-team', 'members.meta.json');
      const seededRaw = JSON.parse(await fs.readFile(membersPath, 'utf8')) as {
        version: number;
        providerBackendId?: string;
        members: Array<Record<string, unknown>>;
      };
      seededRaw.providerBackendId = 'cli-sdk';
      Object.assign(seededRaw.members[0]!, {
        cwd: '/fake/member/cwd',
        runtimeMetadata: { opaque: true },
      });
      const exactSeededRaw = `${JSON.stringify(seededRaw, null, 2)}\n`;
      await fs.writeFile(membersPath, exactSeededRaw, 'utf8');
      const membersStore = new TeamMembersMetaStore();
      const original = await membersStore.getMembers('draft-team');
      const createTeam = vi.fn(async (request: TeamCreateRequest): Promise<TeamCreateResponse> => {
        const invocationLease = await crossRosterLaunchInvocationBoundary();
        await invocationLease.invoke(() =>
          fs.writeFile(
            path.join(sandbox, 'teams', 'draft-team', 'bootstrap-state.json'),
            JSON.stringify({
              runId: request.rosterTransactionId,
              members: [{ name: request.members[0]?.name, status: 'bootstrap_confirmed' }],
            })
          )
        );
        return { runId: request.rosterTransactionId!, launchStatus: 'started' };
      });
      initializeTeamHandlers(service, {
        provisioningStart: { createTeam, launchTeam: vi.fn() },
      } as never);
      registerTeamHandlers(ipcMain as never);

      const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing fake IPC handler: ${channel}`);
        const response = (await handler({}, ...args)) as IpcResult<T>;
        if (!response.success) throw new Error(response.error);
        if (response.data === undefined) throw new Error(`Missing fake IPC data: ${channel}`);
        return response.data;
      };
      const bridge = createRosterAuthorizationTransactionBridge(invoke);
      const transactionId = '55555555-5555-4555-8555-555555555555';
      const executionProof = issueAnthropicExecutionProof(
        materializeAnthropicMembers(requested),
        project
      );
      const authorization = {
        prepareState: 'ready' as const,
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'exact-project-proof',
        currentRequestSignature: 'exact-project-proof',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: Date.now() + 60_000,
        executionProof,
      };

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          async () => {
            const began = await bridge.beginRosterAuthorizationTransaction('draft-team', {
              transactionId,
              members: materializeAnthropicMembers(requested),
            });
            expect(
              buildEffectiveRuntimeRosterRevision({
                lead: { providerId: 'anthropic', providerBackendId: null, model: 'claude' },
                leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
                members: began.authorizedRoster ?? [],
                missingProvenance: 'reject',
              })
            ).toBe(
              buildEffectiveRuntimeRosterRevision({
                lead: { providerId: 'anthropic', providerBackendId: null, model: 'claude' },
                leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
                members: materializeAnthropicMembers(requested),
                missingProvenance: 'reject',
              })
            );
            return began;
          },
          () => bridge.getRosterAuthorizationTransactionOutcome('draft-team', transactionId),
          async (submittedProof) => {
            await invoke(TEAM_LAUNCH, {
              teamName: 'draft-team',
              cwd: project,
              providerId: 'anthropic',
              model: 'claude',
              leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
              rosterTransactionId: transactionId,
              executionProof: submittedProof,
            });
          },
          () => bridge.rollbackRosterAuthorizationTransaction('draft-team', transactionId)
        )
      ).resolves.toBe(true);

      const createRequest = createTeam.mock.calls[0]?.[0];
      expect(createRequest?.rosterTransactionId).toBe(transactionId);
      expect(createRequest?.members.map((member) => member.name)).toEqual(
        requested.map((member) => member.name)
      );
      const durableMembers = await membersStore.getMembers('draft-team');
      const requestedMember = durableMembers.find((member) => member.name === requested[0]?.name);
      expect(createRequest?.members[0]).toMatchObject({
        name: requested[0]?.name,
        role: requested[0]?.role,
        joinedAt: requestedMember?.joinedAt,
      });
      if (requested[0]?.name === 'alice') {
        expect(requestedMember?.joinedAt).toBe(original[0]?.joinedAt);
      }
      await expect(
        service.getRosterAuthorizationTransactionOutcome('draft-team', transactionId)
      ).resolves.toMatchObject({
        status: 'committed',
        launchRunId: transactionId,
      });
      const finalRaw = await fs.readFile(membersPath, 'utf8');
      if (requested[0]?.name === 'alice') {
        expect(finalRaw).toBe(exactSeededRaw);
      } else {
        const finalFile = JSON.parse(finalRaw) as {
          providerBackendId?: string;
          members: Array<Record<string, unknown>>;
        };
        expect(finalFile.providerBackendId).toBe('cli-sdk');
        expect(finalFile.members).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'alice',
              cwd: '/fake/member/cwd',
              runtimeMetadata: { opaque: true },
              removedAt: expect.any(Number),
            }),
            expect.objectContaining({ name: 'bob', role: 'Implementer' }),
          ])
        );
      }
    }
  );

  it('does not grant rollback authority to a rejecting replay of an applied roster', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-roster-launch-reject-'));
    setClaudeBasePathOverride(sandbox);
    const service = new TeamDataService();
    await service.createTeamConfig({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      cwd: os.tmpdir(),
      providerId: 'anthropic',
      model: 'claude',
      leadRuntimeSelectionProvenance: defaultAnthropicProvenance,
      members: materializeAnthropicMembers([{ name: 'alice', role: 'Reviewer' }]),
    });
    const originalRaw = await fs.readFile(
      path.join(sandbox, 'teams', 'draft-team', 'members.meta.json'),
      'utf8'
    );
    const createTeam = vi.fn();
    initializeTeamHandlers(service, {
      provisioningStart: { createTeam, launchTeam: vi.fn() },
    } as never);
    registerTeamHandlers(ipcMain as never);
    const transactionId = '66666666-6666-4666-8666-666666666666';
    await service.beginRosterAuthorizationTransaction('draft-team', transactionId, {
      members: materializeAnthropicMembers([{ name: 'bob', role: 'Implementer' }]),
    });

    await expect(
      handlers.get(TEAM_LAUNCH)?.(
        {},
        {
          teamName: 'draft-team',
          cwd: os.tmpdir(),
          model: 42,
          rosterTransactionId: transactionId,
        }
      )
    ).resolves.toEqual({ success: false, error: 'model must be a string' });
    expect(createTeam).not.toHaveBeenCalled();
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome('draft-team', transactionId)
    ).resolves.toMatchObject({ status: 'applied' });
    expect(
      await fs.readFile(path.join(sandbox, 'teams', 'draft-team', 'members.meta.json'), 'utf8')
    ).not.toBe(originalRaw);
  });
});
