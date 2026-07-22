import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningVerificationProbePorts,
  createTeamProvisioningVerificationProbePortsDepsFromService,
  type TeamProvisioningVerificationProbeServiceAdapter,
  type TeamProvisioningVerificationProbeServiceHost,
} from '../TeamProvisioningVerificationProbePortsFactory';

import type { TeamProvisioningProcessExitRun } from '../TeamProvisioningProcessExit';
import type { TeamProvisioningProgress } from '@shared/types';

type TestRun = TeamProvisioningProcessExitRun;
type TestServiceAdapter = TeamProvisioningVerificationProbeServiceAdapter<TestRun>;

function createProgress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    state: 'verifying',
    message: 'verifying',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamProvisioningProgress;
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'atlas-hq',
    progress: createProgress(),
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    provisioningComplete: false,
    processClosed: false,
    authRetryInProgress: false,
    isLaunch: true,
    request: {
      cwd: '/repo',
      color: 'blue',
      providerId: 'claude',
      model: 'sonnet',
      effort: 'medium',
      members: [{ name: 'Lead', role: 'Lead' }],
    },
    allEffectiveMembers: [{ name: 'Lead', role: 'Lead' }],
    detectedSessionId: 'session-1',
    expectedMembers: ['Lead'],
    teamsBasePathsToProbe: [{ location: 'configured', basePath: '/teams' }],
    onProgress: vi.fn(),
    ...overrides,
  } as TestRun;
}

function createServiceAdapter(overrides: Partial<TestServiceAdapter> = {}): TestServiceAdapter {
  return {
    persistMembersMeta: vi.fn(async () => undefined),
    updateConfigPostLaunch: vi.fn(async () => undefined),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
    maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
    finalizeMissingRegisteredMembersAsFailed: vi.fn(async () => undefined),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
    cleanupRun: vi.fn(),
    ...overrides,
  };
}

describe('TeamProvisioningVerificationProbePortsFactory', () => {
  it('builds verification probe deps from service-shaped dependencies', async () => {
    const serviceAdapter = createServiceAdapter();
    const listTeams = vi.fn(async () => [{ teamName: 'atlas-hq' }]);
    const readRegularFileUtf8 = vi.fn(async () => '{"name":"atlas-hq"}');
    const updateProgress = vi.fn();
    const service = {
      ...serviceAdapter,
      configReader: {
        listTeams,
      },
    } satisfies TeamProvisioningVerificationProbeServiceHost<TestRun>;
    const deps = createTeamProvisioningVerificationProbePortsDepsFromService(service, {
      getTeamsBasePath: () => '/teams',
      readRegularFileUtf8,
      updateProgress,
      verifyTimeoutMs: 15_000,
      verifyPollMs: 500,
      teamJsonReadTimeoutMs: 5_000,
      teamConfigMaxBytes: 10_000,
      sleep: vi.fn(async () => undefined),
    });
    const run = createRun();

    await expect(deps.listTeams()).resolves.toEqual([{ teamName: 'atlas-hq' }]);
    await deps.service.refreshMemberSpawnStatusesFromLeadInbox(run);
    await deps.service.maybeAuditMemberSpawnStatuses(run, { force: true });
    deps.service.cleanupRun(run);

    expect(deps.getTeamsBasePath()).toBe('/teams');
    expect(deps.readRegularFileUtf8).toBe(readRegularFileUtf8);
    expect(deps.updateProgress).toBe(updateProgress);
    expect(serviceAdapter.refreshMemberSpawnStatusesFromLeadInbox).toHaveBeenCalledWith(run);
    expect(serviceAdapter.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(run, {
      force: true,
    });
    expect(serviceAdapter.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('wires valid-config probes with service verification timing and file limits', async () => {
    const readRegularFileUtf8 = vi.fn(async () => '{"name":"atlas-hq"}');
    const ports = createTeamProvisioningVerificationProbePorts({
      service: createServiceAdapter(),
      listTeams: vi.fn(async () => []),
      getTeamsBasePath: () => '/teams',
      readRegularFileUtf8,
      updateProgress: vi.fn(),
      verifyTimeoutMs: 15_000,
      verifyPollMs: 500,
      teamJsonReadTimeoutMs: 5_000,
      teamConfigMaxBytes: 10_000,
      sleep: vi.fn(async () => undefined),
    });

    await expect(ports.waitForValidConfig(createRun(), 1234)).resolves.toEqual({
      ok: true,
      location: 'configured',
      configPath: '/teams/atlas-hq/config.json',
    });
    expect(readRegularFileUtf8).toHaveBeenCalledWith('/teams/atlas-hq/config.json', {
      timeoutMs: 5_000,
      maxBytes: 10_000,
    });
  });

  it('wires team-list and inbox probes through injected service ports', async () => {
    const listTeams = vi.fn(async () => [{ teamName: 'atlas-hq' }]);
    const pathExists = vi.fn(async () => true);
    const ports = createTeamProvisioningVerificationProbePorts({
      service: createServiceAdapter(),
      listTeams,
      getTeamsBasePath: () => '/teams',
      readRegularFileUtf8: vi.fn(async () => null),
      updateProgress: vi.fn(),
      verifyTimeoutMs: 15_000,
      verifyPollMs: 500,
      teamJsonReadTimeoutMs: 5_000,
      teamConfigMaxBytes: 10_000,
      sleep: vi.fn(async () => undefined),
      pathExists,
    });
    const run = createRun({ expectedMembers: ['Lead', 'Reviewer'] });

    await expect(ports.waitForTeamInList('atlas-hq', run)).resolves.toBe(true);
    await expect(ports.waitForMissingInboxes(run)).resolves.toEqual([]);

    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(pathExists).toHaveBeenCalledWith('/teams/atlas-hq/inboxes/Lead.json');
    expect(pathExists).toHaveBeenCalledWith('/teams/atlas-hq/inboxes/Reviewer.json');
  });

  it('wires timeout completion through composed probe ports and service callbacks', async () => {
    const service = createServiceAdapter();
    const updateProgress = vi.fn((run, state, message, extras) =>
      createProgress({ state, message, ...extras })
    );
    const ports = createTeamProvisioningVerificationProbePorts({
      service,
      listTeams: vi.fn(async () => [{ teamName: 'atlas-hq' }]),
      getTeamsBasePath: () => '/teams',
      readRegularFileUtf8: vi.fn(async () => '{"name":"atlas-hq"}'),
      updateProgress,
      verifyTimeoutMs: 15_000,
      verifyPollMs: 500,
      teamJsonReadTimeoutMs: 5_000,
      teamConfigMaxBytes: 10_000,
      sleep: vi.fn(async () => undefined),
      pathExists: vi.fn(async () => true),
    });
    const run = createRun();

    await expect(ports.tryCompleteAfterTimeout(run)).resolves.toBe(true);

    expect(service.updateConfigPostLaunch).toHaveBeenCalledWith(
      'atlas-hq',
      '/repo',
      'session-1',
      'blue',
      {
        providerId: 'claude',
        model: 'sonnet',
        effort: 'medium',
        members: [{ name: 'Lead', role: 'Lead' }],
      }
    );
    expect(service.refreshMemberSpawnStatusesFromLeadInbox).toHaveBeenCalledWith(run);
    expect(service.maybeAuditMemberSpawnStatuses).toHaveBeenCalledWith(run, { force: true });
    expect(service.finalizeMissingRegisteredMembersAsFailed).toHaveBeenCalledWith(run);
    expect(service.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'finished');
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'disconnected',
      'Team provisioned but process timed out',
      {
        warnings: ['CLI timed out after config was created — team provisioned but process killed'],
      }
    );
    expect(run.onProgress).toHaveBeenCalledWith(
      createProgress({
        state: 'disconnected',
        message: 'Team provisioned but process timed out',
        warnings: ['CLI timed out after config was created — team provisioned but process killed'],
      })
    );
    expect(service.cleanupRun).toHaveBeenCalledWith(run);
  });
});
