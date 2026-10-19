import * as manifestReader from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeBridgeCommandClient } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';

import { buildLiveTeamControlApiServices, getRuntimeTranscript } from './openCodeLiveTestHarness';

import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

function createServiceDouble(): TeamProvisioningService {
  const ack = async () => ({
    ok: true,
    providerId: 'opencode',
    teamName: 'team',
    runId: 'run',
    state: 'recorded',
    diagnostics: [],
    observedAt: '2026-01-01T00:00:00.000Z',
  });

  return {
    createTeam: async () => ({ runId: 'run' }),
    launchTeam: async () => ({ runId: 'run' }),
    getProvisioningStatus: async () => ({ runId: 'run', state: 'ready' }),
    repairStaleTaskActivityIntervalsBeforeSnapshot: async () => undefined,
    getRuntimeState: async () => ({
      teamName: 'team',
      isAlive: true,
      runId: 'run',
      progress: null,
    }),
    stopTeam: async () => undefined,
    getAliveTeams: () => ['team'],
    recordOpenCodeRuntimeBootstrapCheckin: ack,
    deliverOpenCodeRuntimeMessage: ack,
    recordOpenCodeRuntimeTaskEvent: ack,
    recordOpenCodeRuntimeHeartbeat: ack,
    answerOpenCodeRuntimePermission: ack,
    getMemberSpawnStatuses: async () => ({ runId: 'run', statuses: {} }),
    getMemberSpawnStatusesReadOnly: async () => ({ runId: 'run', statuses: {} }),
    getTeamAgentRuntimeSnapshot: async () => null,
    getTeamAgentRuntimeSnapshotReadOnly: async () => null,
  } as unknown as TeamProvisioningService;
}

describe('openCodeLiveTestHarness', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wires runtime-control callbacks into the live team control API services', () => {
    const svc = createServiceDouble();

    const services = buildLiveTeamControlApiServices(svc);

    expect(services.teamApis?.provisioningStart?.launchTeam).toBeDefined();
    expect(services.teamApis?.provisioningStatus?.getProvisioningStatus).toBeDefined();
    expect(services.teamApis?.runtime?.getRuntimeState).toBeDefined();
    expect(services.teamApis?.runtimeControl?.recordOpenCodeRuntimeHeartbeat).toBeDefined();
  });

  it('keeps explicit harness service overrides available for tests', () => {
    const svc = createServiceDouble();
    const override = { service: 'runtime-control-override' } as unknown as TeamProvisioningService;
    const defaultTeamApis = buildLiveTeamControlApiServices(svc).teamApis!;

    const services = buildLiveTeamControlApiServices(svc, {
      teamApis: {
        ...defaultTeamApis,
        runtimeControl: override,
      },
    });

    expect(services.teamApis?.runtimeControl).toBe(override);
    expect(services.teamApis?.provisioningStart?.launchTeam).toBeDefined();
  });

  function transcriptClient() {
    const bridgeClient = new OpenCodeBridgeCommandClient({
      binaryPath: '/TEST/cli-source',
      tempDirectory: '/TEST/bridge-input',
      env: {},
    });
    const response = {
      ok: false as const,
      schemaVersion: 1 as const,
      requestId: 'TEST-transcript-request',
      command: 'opencode.getRuntimeTranscript' as const,
      completedAt: '2026-10-19T00:00:00.000Z',
      durationMs: 1,
      error: {
        kind: 'runtime_not_ready' as const,
        message: 'Original owner absent',
        retryable: false,
      },
      diagnostics: [],
    };
    const execute = vi.spyOn(bridgeClient, 'execute').mockResolvedValue(response);
    const laneIndex = vi.spyOn(manifestReader, 'readOpenCodeRuntimeLaneIndex');
    const sessions = vi.spyOn(manifestReader, 'readCommittedOpenCodeBootstrapSessionEvidence');
    return { bridgeClient, execute, response, laneIndex, sessions };
  }

  it('reads only the supplied original run/lane/session and retains its refusal', async () => {
    const client = transcriptClient();
    client.laneIndex.mockRejectedValue(new Error('Unexpected lane lookup'));
    client.sessions.mockRejectedValue(new Error('Unexpected session lookup'));
    const result = await getRuntimeTranscript({
      bridgeClient: client.bridgeClient,
      teamName: 'TEST-team',
      memberName: 'alice',
      projectPath: '/TEST/project',
      originalBinding: {
        runId: 'TEST-original-run',
        laneId: 'TEST-lane',
        runtimeSessionId: 'ses_TESToriginal',
      },
    });
    expect(result).toBe(client.response);
    expect(client.execute).toHaveBeenCalledExactlyOnceWith(
      'opencode.getRuntimeTranscript',
      {
        teamId: 'TEST-team',
        teamName: 'TEST-team',
        memberName: 'alice',
        runId: 'TEST-original-run',
        laneId: 'TEST-lane',
        runtimeSessionId: 'ses_TESToriginal',
      },
      { cwd: '/TEST/project', timeoutMs: 60_000 }
    );
    expect(client.laneIndex).not.toHaveBeenCalled();
    expect(client.sessions).not.toHaveBeenCalled();
  });

  it('keeps initial and relaunched transcript identities distinct', async () => {
    const client = transcriptClient();
    for (const suffix of ['initial', 'relaunch']) {
      await getRuntimeTranscript({
        bridgeClient: client.bridgeClient,
        teamName: 'TEST-team',
        memberName: 'alice',
        projectPath: '/TEST/project',
        originalBinding: {
          runId: `TEST-${suffix}`,
          laneId: 'TEST-lane',
          runtimeSessionId: `ses_TEST${suffix}`,
        },
      });
    }
    expect(client.execute.mock.calls.map((call) => call[1])).toEqual([
      {
        teamId: 'TEST-team',
        teamName: 'TEST-team',
        memberName: 'alice',
        laneId: 'TEST-lane',
        runId: 'TEST-initial',
        runtimeSessionId: 'ses_TESTinitial',
      },
      {
        teamId: 'TEST-team',
        teamName: 'TEST-team',
        memberName: 'alice',
        laneId: 'TEST-lane',
        runId: 'TEST-relaunch',
        runtimeSessionId: 'ses_TESTrelaunch',
      },
    ]);
    expect(client.laneIndex).not.toHaveBeenCalled();
    expect(client.sessions).not.toHaveBeenCalled();
  });

  it.each(['runId', 'laneId', 'runtimeSessionId'] as const)(
    'refuses an incomplete original %s before any read or dispatch',
    async (field) => {
      const client = transcriptClient();
      const originalBinding = {
        runId: 'TEST-run',
        laneId: 'TEST-lane',
        runtimeSessionId: 'ses_TESTsession',
        [field]: '',
      };
      await expect(
        getRuntimeTranscript({
          bridgeClient: client.bridgeClient,
          teamName: 'TEST-team',
          memberName: 'alice',
          projectPath: '/TEST/project',
          originalBinding,
        })
      ).rejects.toThrow('Original OpenCode transcript binding incomplete');
      expect(client.execute).not.toHaveBeenCalled();
      expect(client.laneIndex).not.toHaveBeenCalled();
      expect(client.sessions).not.toHaveBeenCalled();
    }
  );

  it('preserves the existing unbound legacy lane lookup', async () => {
    const client = transcriptClient();
    client.laneIndex.mockResolvedValue({
      version: 1,
      updatedAt: 'TEST-time',
      lanes: {
        primary: { laneId: 'primary', state: 'active', updatedAt: 'TEST-time' },
      },
    });
    client.sessions.mockRejectedValue(new Error('TEST legacy session evidence absent'));
    await getRuntimeTranscript({
      bridgeClient: client.bridgeClient,
      teamName: 'TEST-team',
      memberName: 'alice',
      projectPath: '/TEST/project',
    });
    expect(client.execute).toHaveBeenCalledExactlyOnceWith(
      'opencode.getRuntimeTranscript',
      { teamId: 'TEST-team', teamName: 'TEST-team', laneId: 'primary', memberName: 'alice' },
      { cwd: '/TEST/project', timeoutMs: 60_000 }
    );
    expect(client.laneIndex).toHaveBeenCalledOnce();
    expect(client.sessions).toHaveBeenCalledOnce();
  });
});
