import { createDesktopTeamFeatureCapabilitySources } from '@main/ipc/desktopTeamFeatureCapabilitySources';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';

const mocks = vi.hoisted(() => {
  const sources = {
    provisioningStart: { source: 'provisioningStart' },
    provisioningStatus: { source: 'provisioningStatus' },
    preflight: { source: 'preflight' },
    provisioningRun: { source: 'provisioningRun' },
    taskActivity: { source: 'taskActivity' },
    runtime: { source: 'runtime' },
    memberLifecycle: { source: 'memberLifecycle' },
    diagnostics: { source: 'diagnostics' },
    claudeLogs: { source: 'claudeLogs' },
    messaging: { source: 'messaging' },
    toolApproval: { source: 'toolApproval' },
  };

  return {
    sources,
    bindTeamProvisioningStartApi: vi.fn(() => sources.provisioningStart),
    bindTeamProvisioningStatusApi: vi.fn(() => sources.provisioningStatus),
    bindTeamProvisioningPreflightApi: vi.fn(() => sources.preflight),
    bindTeamProvisioningRunApi: vi.fn(() => sources.provisioningRun),
    bindTeamTaskActivityRepairApi: vi.fn(() => sources.taskActivity),
    bindTeamRuntimeApi: vi.fn(() => sources.runtime),
    bindTeamMemberLifecycleApi: vi.fn(() => sources.memberLifecycle),
    bindTeamDiagnosticsApi: vi.fn(() => sources.diagnostics),
    bindTeamClaudeLogsApi: vi.fn(() => sources.claudeLogs),
    bindTeamMessagingApi: vi.fn(() => sources.messaging),
    bindTeamToolApprovalApi: vi.fn(() => sources.toolApproval),
  };
});

vi.mock('@main/services/team/contracts/TeamMessagingApiBinder', () => ({
  bindTeamMessagingApi: mocks.bindTeamMessagingApi,
}));
vi.mock('@main/services/team/contracts/TeamProvisioningCapabilityApiBinder', () => ({
  bindTeamClaudeLogsApi: mocks.bindTeamClaudeLogsApi,
  bindTeamDiagnosticsApi: mocks.bindTeamDiagnosticsApi,
  bindTeamMemberLifecycleApi: mocks.bindTeamMemberLifecycleApi,
  bindTeamProvisioningPreflightApi: mocks.bindTeamProvisioningPreflightApi,
  bindTeamProvisioningRunApi: mocks.bindTeamProvisioningRunApi,
  bindTeamProvisioningStartApi: mocks.bindTeamProvisioningStartApi,
  bindTeamProvisioningStatusApi: mocks.bindTeamProvisioningStatusApi,
  bindTeamTaskActivityRepairApi: mocks.bindTeamTaskActivityRepairApi,
  bindTeamToolApprovalApi: mocks.bindTeamToolApprovalApi,
}));
vi.mock('@main/services/team/contracts/TeamRuntimeApiBinder', () => ({
  bindTeamRuntimeApi: mocks.bindTeamRuntimeApi,
}));

describe('createDesktopTeamFeatureCapabilitySources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the exact output identity and shape from all 11 narrow binders', () => {
    const teamProvisioningService = {} as TeamProvisioningService;

    const sources = createDesktopTeamFeatureCapabilitySources(teamProvisioningService);

    expect(sources).toStrictEqual(mocks.sources);
    expect(Object.keys(sources)).toEqual([
      'provisioningStart',
      'provisioningStatus',
      'preflight',
      'provisioningRun',
      'taskActivity',
      'runtime',
      'memberLifecycle',
      'diagnostics',
      'claudeLogs',
      'messaging',
      'toolApproval',
    ]);
    for (const key of Object.keys(mocks.sources) as Array<keyof typeof mocks.sources>) {
      expect(sources[key]).toBe(mocks.sources[key]);
    }

    for (const binder of [
      mocks.bindTeamProvisioningStartApi,
      mocks.bindTeamProvisioningStatusApi,
      mocks.bindTeamProvisioningPreflightApi,
      mocks.bindTeamProvisioningRunApi,
      mocks.bindTeamTaskActivityRepairApi,
      mocks.bindTeamRuntimeApi,
      mocks.bindTeamMemberLifecycleApi,
      mocks.bindTeamDiagnosticsApi,
      mocks.bindTeamClaudeLogsApi,
      mocks.bindTeamMessagingApi,
      mocks.bindTeamToolApprovalApi,
    ]) {
      expect(binder).toHaveBeenCalledTimes(1);
      expect(binder).toHaveBeenCalledWith(teamProvisioningService);
    }
  });
});
