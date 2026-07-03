import { describe, expect, it, vi } from 'vitest';

import {
  auditRegisteredMemberSpawnStatuses,
  type AuditRegisteredMemberSpawnStatusPorts,
  parseRegisteredTeamMemberNamesFromConfigJson,
  readRegisteredTeamMemberNamesFromConfig,
  type RegisteredMemberAuditRun,
} from '../TeamProvisioningRegisteredMemberAudit';

import type {
  MarkOpenCodeSecondaryBootstrapStalledPorts,
  ReconcileOpenCodeRuntimeProcessBootstrapPorts,
} from '../TeamProvisioningOpenCodeBootstrapStall';
import type { MemberSpawnStatusEntry } from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';
const NOW_MS = Date.parse('2026-01-01T00:03:00.000Z');

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: ISO,
    ...overrides,
  };
}

function createRun(overrides: Partial<RegisteredMemberAuditRun> = {}): RegisteredMemberAuditRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: { cwd: '/tmp/project' },
    provisioningOutputParts: [],
    memberSpawnStatuses: new Map(),
    progress: {} as never,
    onProgress: vi.fn(),
    isLaunch: true,
    provisioningComplete: false,
    expectedMembers: ['dev'],
    lastMemberSpawnAuditConfigReadWarningAt: 0,
    lastMemberSpawnAuditMissingWarningAt: new Map(),
    ...overrides,
  };
}

function createOpenCodePorts(): ReconcileOpenCodeRuntimeProcessBootstrapPorts &
  MarkOpenCodeSecondaryBootstrapStalledPorts {
  return {
    buildOpenCodeSecondaryBootstrapStallDiagnostic: vi.fn().mockResolvedValue('stalled'),
    setOpenCodeRuntimePendingBootstrapStatus: vi.fn(),
    maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: vi.fn().mockResolvedValue(undefined),
    scheduleOpenCodeBootstrapStallReevaluation: vi.fn(),
    setOpenCodeSecondaryBootstrapStalledStatus: vi.fn(),
  };
}

function createPorts(
  overrides: Partial<AuditRegisteredMemberSpawnStatusPorts<RegisteredMemberAuditRun>> = {}
): AuditRegisteredMemberSpawnStatusPorts<RegisteredMemberAuditRun> & {
  openCodePorts: ReconcileOpenCodeRuntimeProcessBootstrapPorts &
    MarkOpenCodeSecondaryBootstrapStalledPorts;
} {
  const openCodePorts = createOpenCodePorts();
  return {
    nowMs: vi.fn(() => NOW_MS),
    getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set(['dev'])),
    hasTeamDirectory: vi.fn().mockResolvedValue(true),
    getLiveTeamAgentNames: vi.fn().mockResolvedValue(new Set()),
    isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => false),
    isOpenCodeBootstrapStallWindowElapsed: vi.fn(() => false),
    getOpenCodeBootstrapStallReconciliationPorts: vi.fn(() => openCodePorts),
    setMemberSpawnStatus: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    openCodePorts,
    ...overrides,
  };
}

describe('registered member audit helpers', () => {
  it('parses config.json member names with the same trim and fallback behavior', async () => {
    expect(
      parseRegisteredTeamMemberNamesFromConfigJson(
        JSON.stringify({
          members: [{ name: ' dev ' }, { name: '' }, { name: '   ' }, {}, { name: 'qa' }],
        })
      )
    ).toEqual(new Set(['dev', 'qa']));

    const readRegularFileUtf8 = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ members: [{ name: 'lead' }] }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('{');

    await expect(
      readRegisteredTeamMemberNamesFromConfig({
        configPath: '/tmp/config.json',
        timeoutMs: 5000,
        maxBytes: 1024,
        ports: { readRegularFileUtf8 },
      })
    ).resolves.toEqual(new Set(['lead']));
    await expect(
      readRegisteredTeamMemberNamesFromConfig({
        configPath: '/tmp/config.json',
        timeoutMs: 5000,
        maxBytes: 1024,
        ports: { readRegularFileUtf8 },
      })
    ).resolves.toBeNull();
    await expect(
      readRegisteredTeamMemberNamesFromConfig({
        configPath: '/tmp/config.json',
        timeoutMs: 5000,
        maxBytes: 1024,
        ports: { readRegularFileUtf8 },
      })
    ).resolves.toBeNull();
  });

  it('warns about unreadable config only after grace and throttle checks', async () => {
    const run = createRun({
      memberSpawnStatuses: new Map([
        ['dev', status({ agentToolAccepted: true, firstSpawnAcceptedAt: ISO })],
      ]),
    });
    const ports = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(null),
    });

    await auditRegisteredMemberSpawnStatuses(run, ports);

    expect(run.lastMemberSpawnAuditConfigReadWarningAt).toBe(NOW_MS);
    expect(ports.debug).toHaveBeenCalledWith(
      '[alpha] auditMemberSpawnStatuses: config.json not readable'
    );
    expect(ports.getLiveTeamAgentNames).not.toHaveBeenCalled();

    const throttledRun = createRun({
      lastMemberSpawnAuditConfigReadWarningAt: NOW_MS - 5_000,
      memberSpawnStatuses: new Map([
        ['dev', status({ agentToolAccepted: true, firstSpawnAcceptedAt: ISO })],
      ]),
    });
    const throttledPorts = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(null),
    });

    await auditRegisteredMemberSpawnStatuses(throttledRun, throttledPorts);

    expect(throttledPorts.debug).not.toHaveBeenCalled();
  });

  it('does not audit missing config after the team directory disappears', async () => {
    const ports = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(null),
      hasTeamDirectory: vi.fn().mockResolvedValue(false),
    });

    await auditRegisteredMemberSpawnStatuses(createRun(), ports);

    expect(ports.debug).not.toHaveBeenCalled();
    expect(ports.getLiveTeamAgentNames).not.toHaveBeenCalled();
  });

  it('marks registered live runtime aliases online through process liveness', async () => {
    const run = createRun();
    const ports = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set(['dev-2'])),
      getLiveTeamAgentNames: vi.fn().mockResolvedValue(new Set(['dev-2'])),
    });

    await auditRegisteredMemberSpawnStatuses(run, ports);

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'dev',
      'online',
      undefined,
      'process'
    );
  });

  it('reconciles live OpenCode secondary runtime processes instead of marking online', async () => {
    const run = createRun({
      memberSpawnStatuses: new Map([
        [
          'dev',
          status({
            bootstrapStalled: true,
            runtimeDiagnostic: 'existing',
            runtimeDiagnosticSeverity: 'info',
          }),
        ],
      ]),
    });
    const ports = createPorts({
      getLiveTeamAgentNames: vi.fn().mockResolvedValue(new Set(['dev'])),
      isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => true),
    });

    await auditRegisteredMemberSpawnStatuses(run, ports);

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
    expect(ports.openCodePorts.setOpenCodeRuntimePendingBootstrapStatus).toHaveBeenCalledWith(
      run,
      'dev',
      run.memberSpawnStatuses.get('dev'),
      {
        bootstrapStalled: true,
        runtimeDiagnostic: 'stalled',
        runtimeDiagnosticSeverity: 'warning',
      }
    );
  });

  it('keeps registered but non-live members waiting and handles OpenCode bootstrap stalls', async () => {
    const run = createRun({
      memberSpawnStatuses: new Map([
        [
          'dev',
          status({
            agentToolAccepted: true,
            launchState: 'runtime_pending_bootstrap',
            firstSpawnAcceptedAt: ISO,
          }),
        ],
      ]),
    });
    const ports = createPorts({
      isOpenCodeSecondaryLaneMemberInRun: vi.fn(() => true),
      isOpenCodeBootstrapStallWindowElapsed: vi.fn(() => true),
    });

    await auditRegisteredMemberSpawnStatuses(run, ports);

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalledWith(run, 'dev', 'waiting');
    expect(ports.openCodePorts.setOpenCodeSecondaryBootstrapStalledStatus).toHaveBeenCalledWith(
      run,
      'dev',
      run.memberSpawnStatuses.get('dev'),
      'stalled'
    );

    const nativeRun = createRun({
      memberSpawnStatuses: new Map([['dev', status({ agentToolAccepted: true })]]),
    });
    const nativePorts = createPorts();

    await auditRegisteredMemberSpawnStatuses(nativeRun, nativePorts);

    expect(nativePorts.setMemberSpawnStatus).toHaveBeenCalledWith(nativeRun, 'dev', 'waiting');
  });

  it('skips pending restarts before missing-member warnings or error transitions', async () => {
    const run = createRun({
      pendingMemberRestarts: new Map([['dev', {}]]),
      memberSpawnStatuses: new Map([
        ['dev', status({ agentToolAccepted: true, firstSpawnAcceptedAt: ISO })],
      ]),
    });
    const ports = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set()),
    });

    await auditRegisteredMemberSpawnStatuses(run, ports);

    expect(ports.warn).not.toHaveBeenCalled();
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('keeps accepted missing members waiting during grace and fails them after grace expires', async () => {
    const inGraceRun = createRun({
      memberSpawnStatuses: new Map([
        [
          'dev',
          status({
            agentToolAccepted: true,
            firstSpawnAcceptedAt: '2026-01-01T00:02:00.000Z',
          }),
        ],
      ]),
    });
    const inGracePorts = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set()),
    });

    await auditRegisteredMemberSpawnStatuses(inGraceRun, inGracePorts);

    expect(inGracePorts.warn).not.toHaveBeenCalled();
    expect(inGracePorts.setMemberSpawnStatus).toHaveBeenCalledWith(inGraceRun, 'dev', 'waiting');

    const expiredRun = createRun({
      memberSpawnStatuses: new Map([
        ['dev', status({ agentToolAccepted: true, firstSpawnAcceptedAt: ISO })],
      ]),
    });
    const expiredPorts = createPorts({
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set()),
    });

    await auditRegisteredMemberSpawnStatuses(expiredRun, expiredPorts);

    expect(expiredRun.lastMemberSpawnAuditMissingWarningAt.get('dev')).toBe(NOW_MS);
    expect(expiredPorts.warn).toHaveBeenCalledWith(
      '[alpha] Member "dev" not found in config.json members after provisioning'
    );
    expect(expiredPorts.setMemberSpawnStatus).toHaveBeenCalledWith(
      expiredRun,
      'dev',
      'error',
      'Teammate not registered after provisioning within the launch grace window.'
    );
  });
});
