/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars -- Synthetic adapter methods preserve the real async interface and named request parameters. */
/* eslint-disable @typescript-eslint/array-type, @typescript-eslint/consistent-type-definitions -- The matrix fixture mirrors runtime contract shapes and table types. */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-type-assertion -- Assertions document fixture boundaries exercised across runtime variants. */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing -- Diagnostic fixture strings deliberately expose aggregate values and empty fallbacks. */
/* eslint-disable sonarjs/no-alphabetical-sort -- Deterministic fixture comparisons intentionally use default and explicit lexical sorting. */
/* eslint-disable sonarjs/no-nested-conditional, sonarjs/cognitive-complexity -- The in-file fake adapters model a bounded runtime state matrix. */
/* eslint-disable sonarjs/file-permissions -- The executable permission applies only to an isolated test fixture. */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    // Synthetic launch-matrix PIDs do not exist in the host process table.
    // Model the awaited boundary while retaining the real ChildProcess event
    // contract; childProcess.ts owns OS-level identity verification tests.
    killProcessTreeAndWait: vi.fn(
      (child: import('child_process').ChildProcess | null | undefined, signal?: string) => {
        if (!child?.pid || child.exitCode != null || child.signalCode != null) {
          return Promise.resolve();
        }
        if (vi.isMockFunction(process.kill)) {
          process.kill(child.pid, signal ?? 'SIGTERM');
        }
        const terminationSignal = (signal ?? 'SIGTERM') as NodeJS.Signals;
        Object.assign(child, { signalCode: terminationSignal });
        child.emit('exit', null, terminationSignal);
        child.emit('close', null, terminationSignal);
        return Promise.resolve();
      }
    ),
  };
});

import { agentTeamsMcpHttpServer } from '../../../../src/main/services/team/AgentTeamsMcpHttpServer';
import { ClaudeBinaryResolver } from '../../../../src/main/services/team/ClaudeBinaryResolver';
import {
  getOpenCodeRuntimeLaneIndexPath,
  getOpenCodeRuntimeManifestPath,
  readCommittedOpenCodeBootstrapSessionEvidence,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
} from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';
import {
  type TeamLaunchRuntimeAdapter,
  TeamRuntimeAdapterRegistry,
  type TeamRuntimeLaunchInput,
  type TeamRuntimeLaunchResult,
  type TeamRuntimeMemberLaunchEvidence,
  type TeamRuntimeMemberSpec,
  type TeamRuntimePendingPermission,
  type TeamRuntimePermissionAnswerInput,
  type TeamRuntimePermissionListInput,
  type TeamRuntimePermissionListResult,
  type TeamRuntimePrepareResult,
  type TeamRuntimeReconcileInput,
  type TeamRuntimeReconcileResult,
  type TeamRuntimeStopInput,
  type TeamRuntimeStopResult,
} from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import {
  getMixedLaunchFallbackRecoveryError,
  TeamProvisioningService,
} from '../../../../src/main/services/team/TeamProvisioningService';
import {
  cancelRuntimeAdapterProvisioning,
  stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned,
  type RuntimeAdapterCancellationPorts,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningRuntimeAdapterCancellation';
import {
  encodePath,
  extractBaseDir,
  getProjectsBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustExecutionPlan,
} from '../../../../src/features/workspace-trust/core/application/WorkspaceTrustCoordinator';
import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
} from '../../../../src/main/services/team/runtime';
import type { TeamMemberWorktreeManager } from '../../../../src/main/services/team/TeamMemberWorktreeManager';
import type {
  InboxMessage,
  TaskRef,
  TeamProvisioningProgress,
  ToolApprovalEvent,
  ToolApprovalRequest,
} from '../../../../src/shared/types';

const LAUNCH_MATRIX_SAFE_E2E_TIMEOUT_MS = 60_000;
const WORKSPACE_TRUST_TEST_ENV_NAMES = [
  'AGENT_TEAMS_WORKSPACE_TRUST',
  'AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT',
  'AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY',
  'AGENT_TEAMS_WORKSPACE_TRUST_CODEX_ARGS',
  'AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS',
  'AGENT_TEAMS_WORKSPACE_TRUST_RETRY',
] as const;

type WorkspaceTrustTestEnvName = (typeof WORKSPACE_TRUST_TEST_ENV_NAMES)[number];
type RuntimeUsageStatsForTest = { rssBytes: number; cpuPercent?: number };
type RuntimeUsageProcessRowForTest = RuntimeUsageStatsForTest & {
  pid: number;
  ppid: number;
  command: string;
  runtimeTelemetrySource?: 'native' | 'wsl' | 'windows-host';
};
type PersistedLaunchSnapshotForTest = {
  members: Record<string, Record<string, unknown>>;
  summary?: Record<string, unknown>;
};
type RuntimeUsageStatsStubTarget = {
  aliveRunByTeam?: Map<string, string>;
  provisioningRunByTeam?: Map<string, string>;
  runs?: Map<string, { child?: { pid?: number } }>;
  getLiveTeamAgentRuntimeMetadata?: (
    teamName: string
  ) => Promise<Map<string, { pid?: number; metricsPid?: number }>>;
  runtimeResourceSampling: {
    readRuntimeProcessRowsForUsageSnapshot: (
      teamName: string
    ) => Promise<RuntimeUsageProcessRowForTest[]>;
    readProcessUsageStatsByPid: (
      pids: readonly number[]
    ) => Promise<Map<number, RuntimeUsageStatsForTest>>;
  };
};

async function expectOpenCodeTrackedPendingDelivery(
  delivery: Promise<unknown>
): Promise<Record<string, unknown>> {
  const result = (await delivery) as Record<string, unknown>;

  expect(result).toMatchObject({
    delivered: true,
    accepted: true,
    responsePending: true,
    responseState: 'not_observed',
    ledgerStatus: 'retry_scheduled',
    reason: 'opencode_delivery_response_pending',
  });
  expect(result.diagnostics).toEqual(
    expect.arrayContaining(['opencode_delivery_response_pending'])
  );
  expect(result.ledgerRecordId).toEqual(expect.stringMatching(/^opencode-prompt:/));
  expect(result.laneId).toEqual(expect.any(String));

  return result;
}

function addRuntimeUsagePidForTest(pids: Set<number>, pid: unknown): void {
  if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
    pids.add(pid);
  }
}

function createRuntimeUsageStatsMap(
  entries: readonly (readonly [number, number])[]
): Map<number, RuntimeUsageStatsForTest> {
  return new Map(entries.map(([pid, rssBytes]) => [pid, { rssBytes }]));
}

function createProvisioningChildFixture(input: {
  pid: number;
  stdin: { writable: boolean; write?: (...args: never[]) => unknown };
  onDirectKill?: () => void;
}): EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: typeof input.stdin;
  kill: () => boolean;
} {
  return Object.assign(new EventEmitter(), {
    pid: input.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: input.stdin,
    kill: () => {
      input.onDirectKill?.();
      return true;
    },
  });
}

function stubRuntimeUsageStatsByPid(
  service: TeamProvisioningService,
  entries: readonly (readonly [number, number])[] = []
): void {
  const configuredStatsByPid = createRuntimeUsageStatsMap(entries);
  const target = service as unknown as RuntimeUsageStatsStubTarget;

  target.runtimeResourceSampling.readRuntimeProcessRowsForUsageSnapshot = async (
    teamName: string
  ) => {
    const statsByPid = new Map(configuredStatsByPid);
    const candidatePids = new Set<number>();
    const runId =
      target.aliveRunByTeam?.get(teamName) ?? target.provisioningRunByTeam?.get(teamName);
    const run = runId ? target.runs?.get(runId) : undefined;
    addRuntimeUsagePidForTest(candidatePids, run?.child?.pid);

    const liveMetadataByMember = await target.getLiveTeamAgentRuntimeMetadata?.(teamName);
    for (const metadata of liveMetadataByMember?.values() ?? []) {
      addRuntimeUsagePidForTest(candidatePids, metadata.pid);
      addRuntimeUsagePidForTest(candidatePids, metadata.metricsPid);
    }

    for (const pid of candidatePids) {
      if (!statsByPid.has(pid)) {
        statsByPid.set(pid, { rssBytes: pid * 1_000 });
      }
    }

    return [...statsByPid].map(([pid, stats]) => ({
      pid,
      ppid: 0,
      command: `test-runtime-${pid}`,
      ...stats,
      runtimeTelemetrySource: 'native' as const,
    }));
  };

  target.runtimeResourceSampling.readProcessUsageStatsByPid = async (pids: readonly number[]) => {
    const requestedPids = new Set(pids);
    return new Map(
      [...pids]
        .filter((pid) => Number.isFinite(pid) && pid > 0)
        .map((pid) => [pid, configuredStatsByPid.get(pid) ?? { rssBytes: pid * 1_000 }] as const)
        .filter(([pid]) => requestedPids.has(pid))
    );
  };
}

function stubLiveOpenCodeRuntimeProcessesForTest(
  service: TeamProvisioningService,
  teamName: string,
  memberNames: readonly string[]
): void {
  const target = service as unknown as {
    runtimeResourceSampling: {
      readRuntimeProcessRowsForLiveRuntimeMetadata: () => Promise<{
        rows: RuntimeUsageProcessRowForTest[];
        processTableAvailable: boolean;
      }>;
    };
  };
  target.runtimeResourceSampling.readRuntimeProcessRowsForLiveRuntimeMetadata = async () => ({
    rows: memberNames.map((memberName) => ({
      pid: 10_000,
      ppid: 1,
      command: `opencode --team-name ${teamName} --agent-id ${memberName}`,
      runtimeTelemetrySource: 'native',
      rssBytes: 10_000_000,
    })),
    processTableAvailable: true,
  });
}

describe(
  'Team agent launch matrix safe e2e',
  () => {
    let tempDir: string;
    let tempClaudeRoot: string;
    let projectPath: string;
    let originalClaudeCliPath: string | undefined;
    let originalWorkspaceTrustEnv: Partial<Record<WorkspaceTrustTestEnvName, string | undefined>>;

    beforeEach(async () => {
      TeamConfigReader.clearCacheForTests();
      ClaudeBinaryResolver.clearCache();
      originalClaudeCliPath = process.env.CLAUDE_CLI_PATH;
      originalWorkspaceTrustEnv = snapshotWorkspaceTrustTestEnv();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-launch-matrix-e2e-'));
      tempClaudeRoot = path.join(tempDir, '.claude');
      projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(tempClaudeRoot, { recursive: true });
      setClaudeBasePathOverride(tempClaudeRoot);
    });

    afterEach(async () => {
      TeamConfigReader.clearCacheForTests();
      restoreOptionalEnvValue('CLAUDE_CLI_PATH', originalClaudeCliPath);
      restoreWorkspaceTrustTestEnv(originalWorkspaceTrustEnv);
      ClaudeBinaryResolver.clearCache();
      setClaudeBasePathOverride(null);
      await removeTempDirWithRetries(tempDir);
    });

    it('launches a pure OpenCode team through the runtime adapter and exposes live members', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      const { runId } = await svc.createTeam(
        {
          teamName: 'pure-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      expect(runId).toBe(adapter.launchInputs[0]?.runId);
      expect(adapter.launchInputs).toHaveLength(1);
      expect(adapter.launchInputs[0]?.expectedMembers.map((member) => member.name)).toEqual([
        'team-lead',
        'alice',
        'bob',
      ]);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot('pure-opencode-safe-e2e');
      expect(runtimeSnapshot.members['team-lead']).toMatchObject({
        alive: true,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });
      expect(runtimeSnapshot.members.alice).toMatchObject({
        alive: true,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        alive: true,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });

      const launchState = JSON.parse(
        await fs.readFile(
          path.join(getTeamsBasePath(), 'pure-opencode-safe-e2e', 'launch-state.json'),
          {
            encoding: 'utf8',
          }
        )
      ) as { expectedMembers: string[]; members: Record<string, unknown>; teamLaunchState: string };
      expect(launchState.teamLaunchState).toBe('clean_success');
      expect(launchState.expectedMembers).toEqual(['team-lead', 'alice', 'bob']);
      expect(Object.keys(launchState.members)).toEqual(['team-lead', 'alice', 'bob']);
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName: 'pure-opencode-safe-e2e',
          laneId: 'primary',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: expect.arrayContaining([
          expect.objectContaining({ memberName: 'team-lead' }),
          expect.objectContaining({ memberName: 'alice' }),
          expect.objectContaining({ memberName: 'bob' }),
        ]),
      });
    });

    it('rejects concurrent member restarts that both replace an untracked pure OpenCode primary', async () => {
      const teamName = 'pure-opencode-untracked-concurrent-restarts-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Reviewer', providerId: 'opencode' },
            { name: 'bob', role: 'Developer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      const primaryGate = adapter.holdNextPrimaryLaunch();
      const firstRestart = svc.restartMember(teamName, 'alice');
      await primaryGate.entered;

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'aggregate primary restart for teammate "alice" is already in progress'
      );
      primaryGate.release();
      await firstRestart;

      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'alice' }),
            expect.objectContaining({ name: 'bob' }),
          ],
        }),
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('does not resurrect an untracked pure OpenCode restart cancelled during persistence', async () => {
      const teamName = 'pure-opencode-untracked-restart-persist-stop-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      let markPersistenceEntered!: () => void;
      let releasePersistence!: () => void;
      const persistenceEntered = new Promise<void>((resolve) => {
        markPersistenceEntered = resolve;
      });
      const persistenceReleased = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const originalPersist = (svc as any).persistOpenCodeRuntimeAdapterLaunchResult.bind(svc);
      vi.spyOn(svc as any, 'persistOpenCodeRuntimeAdapterLaunchResult').mockImplementation(
        async (...args: unknown[]) => {
          markPersistenceEntered();
          await persistenceReleased;
          return originalPersist(...args);
        }
      );

      const restartExpectation = expect(svc.restartMember(teamName, 'alice')).rejects.toThrow(
        'was cancelled because team "pure-opencode-untracked-restart-persist-stop-safe-e2e" is no longer running'
      );
      await persistenceEntered;
      const stopPromise = svc.stopTeam(teamName);
      releasePersistence();

      await stopPromise;
      await restartExpectation;
      expect(svc.isTeamAlive(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the OpenCode lead in primary when teammates use separate model lanes', async () => {
      const teamName = 'pure-opencode-lead-distinct-model-lanes-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      stubLiveOpenCodeRuntimeProcessesForTest(svc, teamName, ['alice', 'jack']);
      const progressEvents: TeamProvisioningProgress[] = [];

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Z.AI teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
            {
              name: 'jack',
              role: 'MiniMax teammate',
              providerId: 'opencode',
              model: 'minimax-coding-plan/MiniMax-M3',
            },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      expect(adapter.launchInputs).toHaveLength(3);
      expect(adapter.launchInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            laneId: 'primary',
            model: 'xai/grok-4.5',
            expectedMembers: [
              expect.objectContaining({
                name: 'team-lead',
                model: 'xai/grok-4.5',
              }),
              expect.objectContaining({
                name: 'tom',
                model: 'xai/grok-4.5',
              }),
            ],
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:alice',
            model: 'zai-coding-plan/glm-5.1',
            runtimeOnly: true,
            expectedMembers: [
              expect.objectContaining({
                name: 'alice',
                model: 'zai-coding-plan/glm-5.1',
              }),
            ],
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:jack',
            model: 'minimax-coding-plan/MiniMax-M3',
            runtimeOnly: true,
            expectedMembers: [
              expect.objectContaining({
                name: 'jack',
                model: 'minimax-coding-plan/MiniMax-M3',
              }),
            ],
          }),
        ])
      );
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode member lanes are ready',
      });

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members['team-lead']).toMatchObject({
        alive: true,
        runtimeModel: 'xai/grok-4.5',
      });
      expect(snapshot.members.tom).toMatchObject({
        alive: true,
        runtimeModel: 'xai/grok-4.5',
      });
      expect(snapshot.members.alice).toMatchObject({
        alive: true,
        runtimeModel: 'zai-coding-plan/glm-5.1',
      });
      expect(snapshot.members.jack).toMatchObject({
        alive: true,
        runtimeModel: 'minimax-coding-plan/MiniMax-M3',
      });

      const primaryLaunch = adapter.launchInputs.find((input) => input.laneId === 'primary');
      expect(primaryLaunch?.runId).toBe(runId);
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'primary',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [
          expect.objectContaining({
            id: 'session-team-lead',
            memberName: 'team-lead',
            laneId: 'primary',
            runId,
          }),
          expect.objectContaining({
            id: 'session-tom',
            memberName: 'tom',
            laneId: 'primary',
            runId,
          }),
        ],
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'secondary:opencode:alice',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [expect.objectContaining({ memberName: 'alice' })],
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'secondary:opencode:jack',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [expect.objectContaining({ memberName: 'jack' })],
      });

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'team-lead',
          text: 'lead remains addressable through primary lane',
          messageId: 'msg-opencode-lead-primary-lane',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        memberName: 'team-lead',
        cwd: projectPath,
        text: 'lead remains addressable through primary lane',
        messageId: 'msg-opencode-lead-primary-lane',
      });

      const launchCountBeforeRestart = adapter.launchInputs.length;
      await svc.restartMember(teamName, 'tom');
      expect(adapter.stopInputs).toEqual([
        expect.objectContaining({
          runId,
          teamName,
          laneId: 'primary',
        }),
      ]);
      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          teamName,
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({
          teamName,
          laneId: 'secondary:opencode:tom',
          expectedMembers: [expect.objectContaining({ name: 'tom' })],
        }),
      ]);
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'primary',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [
          expect.objectContaining({
            id: 'session-team-lead',
            memberName: 'team-lead',
            laneId: 'primary',
            runId,
          }),
        ],
      });

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'team-lead',
          text: 'lead remains addressable after primary teammate restart',
          messageId: 'msg-opencode-lead-after-primary-restart',
        })
      );
      expect(adapter.messageInputs).toHaveLength(2);
      expect(adapter.messageInputs[1]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        memberName: 'team-lead',
        cwd: projectPath,
        text: 'lead remains addressable after primary teammate restart',
        messageId: 'msg-opencode-lead-after-primary-restart',
      });
    });

    it('does not resurrect an OpenCode primary lane when the team stops during member restart', async () => {
      const teamName = 'pure-opencode-primary-restart-stop-race-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      const primaryGate = adapter.holdNextPrimaryLaunch();
      const restartExpectation = expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'was cancelled because the owning run is no longer active'
      );
      await primaryGate.entered;

      const stopPromise = svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      const stopCompletedBeforeRelease = await Promise.race([
        stopPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      primaryGate.release();

      expect(stopCompletedBeforeRelease).toBe(true);
      await restartExpectation;
      await stopPromise;

      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
      ]);
      expect(adapter.stopInputs.filter((input) => input.laneId === 'primary')).toHaveLength(2);
      expect(adapter.stopInputs).toEqual(
        expect.arrayContaining([expect.objectContaining({ laneId: 'secondary:opencode:alice' })])
      );
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('waits for an in-flight primary stop before completing team stop during member restart', async () => {
      const teamName = 'pure-opencode-primary-restart-stop-await-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const primaryStopGate = adapter.holdNextLaneStop('primary');
      const restartExpectation = expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        `was cancelled because team "${teamName}" is no longer running`
      );
      await primaryStopGate.entered;

      let stopSettled = false;
      const stopPromise = svc.stopTeam(teamName).finally(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(stopSettled).toBe(false);
      primaryStopGate.release();
      await stopPromise;
      await restartExpectation;

      expect(svc.isTeamAlive(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('cleans OpenCode primary state when a stopped member restart launch rejects', async () => {
      const teamName = 'pure-opencode-primary-restart-stop-rejection-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const primaryGate = adapter.holdNextPrimaryLaunch();
      adapter.failNextPrimaryLaunch('primary launch rejected after stop');
      const restartExpectation = expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'was cancelled because the owning run is no longer active'
      );
      await primaryGate.entered;

      const stopPromise = svc.stopTeam(teamName);
      const stopCompletedBeforeRelease = await Promise.race([
        stopPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      primaryGate.release();

      expect(stopCompletedBeforeRelease).toBe(true);
      await restartExpectation;
      await stopPromise;
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('serializes aggregate primary restarts across different OpenCode members', async () => {
      const teamName = 'pure-opencode-concurrent-primary-restarts-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'First same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'bob',
              role: 'Second same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      const primaryGate = adapter.holdNextPrimaryLaunch();
      const firstRestart = svc.restartMember(teamName, 'tom');
      await primaryGate.entered;

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'aggregate primary restart for teammate "tom" is already in progress'
      );
      primaryGate.release();
      await firstRestart;

      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'bob' }),
          ],
        }),
        expect.objectContaining({
          laneId: 'secondary:opencode:tom',
          expectedMembers: [expect.objectContaining({ name: 'tom' })],
        }),
      ]);
      expect(adapter.launchInputs.some((input) => input.laneId === 'secondary:opencode:bob')).toBe(
        false
      );
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('serializes an aggregate primary restart behind an earlier same-team relaunch', async () => {
      const teamName = 'pure-opencode-relaunch-before-primary-restart-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      let markRelaunchConfigReadEntered!: () => void;
      let releaseRelaunchConfigRead!: () => void;
      const relaunchConfigReadEntered = new Promise<void>((resolve) => {
        markRelaunchConfigReadEntered = resolve;
      });
      const relaunchConfigReadReleased = new Promise<void>((resolve) => {
        releaseRelaunchConfigRead = resolve;
      });
      const originalResolveMembers = (svc as any).resolveLaunchExpectedMembers.bind(svc);
      vi.spyOn(svc as any, 'resolveLaunchExpectedMembers').mockImplementation(
        async (...args: unknown[]) => {
          markRelaunchConfigReadEntered();
          await relaunchConfigReadReleased;
          return originalResolveMembers(...args);
        }
      );

      const launchCountBeforeRelaunch = adapter.launchInputs.length;
      const relaunchPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
        },
        () => undefined
      );
      await relaunchConfigReadEntered;

      let restartSettled = false;
      const restartPromise = svc.restartMember(teamName, 'tom').finally(() => {
        restartSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(restartSettled).toBe(false);
      expect(adapter.launchInputs).toHaveLength(launchCountBeforeRelaunch);
      releaseRelaunchConfigRead();

      await relaunchPromise;
      await restartPromise;
      expect(adapter.launchInputs.slice(launchCountBeforeRelaunch)).toEqual([
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'tom' }),
          ],
        }),
        expect.objectContaining({ laneId: 'secondary:opencode:alice' }),
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({ laneId: 'secondary:opencode:tom' }),
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('waits for an earlier secondary detach before relaunching the same team', async () => {
      const teamName = 'pure-opencode-detach-before-relaunch-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRelaunch = adapter.launchInputs.length;
      const secondaryStopGate = adapter.holdNextLaneStop('secondary:opencode:alice');
      const detachPromise = svc.detachLiveRosterMember(teamName, 'alice');
      await secondaryStopGate.entered;

      let relaunchSettled = false;
      const relaunchPromise = svc
        .launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: 'xai/grok-4.5',
            skipPermissions: true,
          },
          () => undefined
        )
        .finally(() => {
          relaunchSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(relaunchSettled).toBe(false);
      expect(adapter.launchInputs).toHaveLength(launchCountBeforeRelaunch);
      secondaryStopGate.release();

      await detachPromise;
      await relaunchPromise;
      expect(adapter.launchInputs.slice(launchCountBeforeRelaunch)).toEqual([
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'tom' }),
          ],
        }),
        expect.objectContaining({
          laneId: 'secondary:opencode:alice',
          expectedMembers: [expect.objectContaining({ name: 'alice' })],
        }),
      ]);
      const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
      expect(laneIndex.lanes.primary).toMatchObject({ state: 'active' });
      expect(laneIndex.lanes['secondary:opencode:alice']).toMatchObject({ state: 'active' });
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('waits for an earlier same-team relaunch before detaching a secondary lane', async () => {
      const teamName = 'pure-opencode-relaunch-before-detach-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      let markRelaunchConfigReadEntered!: () => void;
      let releaseRelaunchConfigRead!: () => void;
      const relaunchConfigReadEntered = new Promise<void>((resolve) => {
        markRelaunchConfigReadEntered = resolve;
      });
      const relaunchConfigReadReleased = new Promise<void>((resolve) => {
        releaseRelaunchConfigRead = resolve;
      });
      const originalResolveMembers = (svc as any).resolveLaunchExpectedMembers.bind(svc);
      vi.spyOn(svc as any, 'resolveLaunchExpectedMembers').mockImplementation(
        async (...args: unknown[]) => {
          markRelaunchConfigReadEntered();
          await relaunchConfigReadReleased;
          return originalResolveMembers(...args);
        }
      );

      const secondaryStopCountBeforeRelaunch = adapter.stopInputs.filter(
        (input) => input.laneId === 'secondary:opencode:alice'
      ).length;
      const relaunchPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
        },
        () => undefined
      );
      await relaunchConfigReadEntered;

      let detachSettled = false;
      const detachPromise = svc.detachLiveRosterMember(teamName, 'alice').finally(() => {
        detachSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(detachSettled).toBe(false);
      expect(
        adapter.stopInputs.filter((input) => input.laneId === 'secondary:opencode:alice')
      ).toHaveLength(secondaryStopCountBeforeRelaunch);
      releaseRelaunchConfigRead();

      await relaunchPromise;
      await detachPromise;
      const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
      expect(laneIndex.lanes.primary).toMatchObject({ state: 'active' });
      expect(laneIndex.lanes['secondary:opencode:alice']).toBeUndefined();
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('does not propagate a failed secondary retry into a waiting relaunch', async () => {
      const teamName = 'pure-opencode-failed-retry-before-relaunch-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      let markRetryCollectionEntered!: () => void;
      let releaseRetryCollection!: () => void;
      const retryCollectionEntered = new Promise<void>((resolve) => {
        markRetryCollectionEntered = resolve;
      });
      const retryCollectionReleased = new Promise<void>((resolve) => {
        releaseRetryCollection = resolve;
      });
      vi.spyOn(svc as any, 'collectFailedOpenCodeSecondaryRetryCandidates').mockImplementation(
        async () => {
          markRetryCollectionEntered();
          await retryCollectionReleased;
          throw new Error('retry candidate read failed');
        }
      );

      const retryFailure = svc
        .retryFailedOpenCodeSecondaryLanes(teamName)
        .catch((error: unknown) => error);
      await retryCollectionEntered;

      const launchCountBeforeRelaunch = adapter.launchInputs.length;
      let relaunchSettled = false;
      const relaunchPromise = svc
        .launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: 'xai/grok-4.5',
            skipPermissions: true,
          },
          () => undefined
        )
        .finally(() => {
          relaunchSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(relaunchSettled).toBe(false);
      expect(adapter.launchInputs).toHaveLength(launchCountBeforeRelaunch);
      releaseRetryCollection();

      await expect(retryFailure).resolves.toMatchObject({ message: 'retry candidate read failed' });
      await expect(relaunchPromise).resolves.toEqual(
        expect.objectContaining({ runId: expect.any(String) })
      );
      expect(adapter.launchInputs.slice(launchCountBeforeRelaunch)).toEqual([
        expect.objectContaining({ laneId: 'primary' }),
        expect.objectContaining({ laneId: 'secondary:opencode:alice' }),
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('serializes a secondary detach behind OpenCode primary restart rollback', async () => {
      const teamName = 'pure-opencode-primary-restart-detach-serialization-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      const primaryGate = adapter.holdNextPrimaryLaunch();
      adapter.failNextPrimaryLaunch('primary relaunch failed before detach');
      const restartExpectation = expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'primary relaunch failed before detach'
      );
      await primaryGate.entered;

      let detachSettled = false;
      const detachPromise = svc.detachLiveRosterMember(teamName, 'alice').then(() => {
        detachSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(detachSettled).toBe(false);
      expect(adapter.stopInputs.some((input) => input.laneId === 'secondary:opencode:alice')).toBe(
        false
      );
      primaryGate.release();

      await restartExpectation;
      await detachPromise;

      expect(detachSettled).toBe(true);
      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'tom' }),
          ],
        }),
      ]);
      expect(adapter.stopInputs.some((input) => input.laneId === 'secondary:opencode:alice')).toBe(
        true
      );
      const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
      expect(laneIndex.lanes.primary).toMatchObject({ state: 'active' });
      expect(laneIndex.lanes['secondary:opencode:alice']).toBeUndefined();
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('clears a late rollback snapshot when stop cancels a tracked OpenCode primary restart', async () => {
      const teamName = 'pure-opencode-primary-rollback-persist-stop-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      adapter.setLaunchResult('partial_pending');
      adapter.failNextPrimaryLaunch('primary relaunch failed before persisted rollback');
      let markPersistenceEntered!: () => void;
      let releasePersistence!: () => void;
      const persistenceEntered = new Promise<void>((resolve) => {
        markPersistenceEntered = resolve;
      });
      const persistenceReleased = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const originalPersist = (svc as any).persistLaunchStateSnapshot.bind(svc);
      let rollbackPersistenceHeld = false;
      vi.spyOn(svc as any, 'persistLaunchStateSnapshot').mockImplementation(
        async (...args: unknown[]) => {
          if (rollbackPersistenceHeld || args[1] !== 'finished') {
            return originalPersist(...args);
          }
          rollbackPersistenceHeld = true;
          markPersistenceEntered();
          await persistenceReleased;
          return originalPersist(...args);
        }
      );

      const restartExpectation = expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        `was cancelled because team "${teamName}" is no longer running`
      );
      await persistenceEntered;
      const stopPromise = svc.stopTeam(teamName);
      releasePersistence();

      await stopPromise;
      await restartExpectation;
      expect(svc.isTeamAlive(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await waitForCondition(
        async () =>
          (await fs
            .stat(path.join(getTeamsBasePath(), teamName, 'launch-state.json'))
            .catch(() => null)) === null
      );
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('waits for an earlier secondary detach before snapshotting a primary restart', async () => {
      const teamName = 'pure-opencode-detach-before-primary-restart-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      const secondaryStopGate = adapter.holdNextLaneStop('secondary:opencode:alice');
      const detachPromise = svc.detachLiveRosterMember(teamName, 'alice');
      await secondaryStopGate.entered;

      const primaryGate = adapter.holdNextPrimaryLaunch();
      let restartSettled = false;
      const restartPromise = svc.restartMember(teamName, 'tom').finally(() => {
        restartSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(restartSettled).toBe(false);
      expect(adapter.stopInputs.some((input) => input.laneId === 'primary')).toBe(false);
      expect(adapter.launchInputs).toHaveLength(launchCountBeforeRestart);

      secondaryStopGate.release();
      await detachPromise;
      await primaryGate.entered;
      primaryGate.release();
      await restartPromise;

      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({
          laneId: 'secondary:opencode:tom',
          expectedMembers: [expect.objectContaining({ name: 'tom' })],
        }),
      ]);
      const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
      expect(laneIndex.lanes.primary).toMatchObject({ state: 'active' });
      expect(laneIndex.lanes['secondary:opencode:alice']).toBeUndefined();
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('restores the original OpenCode primary lane when member restart relaunch fails', async () => {
      const teamName = 'pure-opencode-primary-restart-rollback-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      const launchCountBeforeRestart = adapter.launchInputs.length;
      adapter.failNextPrimaryLaunch('transient primary relaunch failure');

      await expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'transient primary relaunch failure'
      );

      expect(adapter.launchInputs.slice(launchCountBeforeRestart)).toEqual([
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({
          runId,
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'tom' }),
          ],
        }),
      ]);
      expect(
        adapter.launchInputs.some(
          (input) =>
            input.laneId === 'secondary:opencode:tom' &&
            input.expectedMembers.some((member) => member.name === 'tom')
        )
      ).toBe(false);
      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode member restart failed; original primary lane was restored',
        messageSeverity: 'warning',
        error: undefined,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: { state: 'active' },
          'secondary:opencode:alice': { state: 'active' },
        },
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'primary',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: expect.arrayContaining([
          expect.objectContaining({ memberName: 'team-lead', runId }),
          expect.objectContaining({ memberName: 'tom', runId }),
        ]),
      });

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'team-lead',
          text: 'lead remains available after primary rollback',
          messageId: 'msg-opencode-lead-after-primary-rollback',
        })
      );
      expect(adapter.messageInputs.at(-1)).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        memberName: 'team-lead',
      });
    });

    it('stops the exact persisted primary candidate before rollback after relaunch persistence fails', async () => {
      const teamName = 'pure-opencode-primary-restart-persist-failure-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        () => undefined
      );

      const events: string[] = [];
      const originalAdapterLaunch = adapter.launch.bind(adapter);
      vi.spyOn(adapter, 'launch').mockImplementation(async (input) => {
        events.push(`launch:${input.laneId}:${input.expectedMembers.map((member) => member.name)}`);
        return originalAdapterLaunch(input);
      });
      const originalAdapterStop = adapter.stop.bind(adapter);
      vi.spyOn(adapter, 'stop').mockImplementation(async (input) => {
        events.push(`stop:${input.laneId}:${input.cwd}`);
        return originalAdapterStop(input);
      });
      const originalPrimaryLaunch = (svc as any).launchOpenCodeAggregatePrimaryLane.bind(svc);
      let failPersistedCandidate = true;
      vi.spyOn(svc as any, 'launchOpenCodeAggregatePrimaryLane').mockImplementation(
        async (...args: unknown[]) => {
          const result = await originalPrimaryLaunch(...args);
          if (failPersistedCandidate) {
            failPersistedCandidate = false;
            throw new Error('primary candidate post-persistence index failed');
          }
          return result;
        }
      );

      await expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'primary candidate post-persistence index failed'
      );

      expect(events).toEqual([
        `stop:primary:${projectPath}`,
        'launch:primary:team-lead',
        `stop:primary:${projectPath}`,
        'launch:primary:team-lead,tom',
      ]);
      expect(adapter.stopInputs.at(-1)).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'cleanup',
        force: true,
      });
      expect(svc.isTeamAlive(teamName)).toBe(true);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: { state: 'active' },
          'secondary:opencode:alice': { state: 'active' },
        },
      });
    });

    it('rolls back when primary restart returns a hard failure for the OpenCode lead', async () => {
      const teamName = 'pure-opencode-primary-restart-lead-failure-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      adapter.setNextPrimaryMemberOutcomes({ 'team-lead': 'failed' });

      await expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'did not retain the team lead runtime'
      );

      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode member restart failed; original primary lane was restored',
        messageSeverity: 'warning',
      });
      expect(adapter.launchInputs.slice(-2)).toEqual([
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [expect.objectContaining({ name: 'team-lead' })],
        }),
        expect.objectContaining({
          laneId: 'primary',
          expectedMembers: [
            expect.objectContaining({ name: 'team-lead' }),
            expect.objectContaining({ name: 'tom' }),
          ],
        }),
      ]);
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'team-lead',
          text: 'lead recovered from hard-failure result',
          messageId: 'msg-opencode-lead-after-hard-failure-rollback',
        })
      );
      expect(adapter.messageInputs.at(-1)).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'team-lead',
      });
    });

    it('stops the OpenCode aggregate cleanly when member restart and primary rollback both fail', async () => {
      const teamName = 'pure-opencode-primary-restart-double-failure-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'xai/grok-4.5',
          skipPermissions: true,
          members: [
            {
              name: 'tom',
              role: 'Same-model teammate',
              providerId: 'opencode',
              model: 'xai/grok-4.5',
            },
            {
              name: 'alice',
              role: 'Side-lane teammate',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.1',
            },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      adapter.failNextPrimaryLaunch('persistent primary relaunch failure', 2);

      await expect(svc.restartMember(teamName, 'tom')).rejects.toThrow(
        'Primary rollback failed: persistent primary relaunch failure'
      );

      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'failed',
        message: 'OpenCode member restart and primary rollback failed',
        messageSeverity: 'error',
        error: expect.stringContaining('Rollback failed: persistent primary relaunch failure'),
      });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await waitForCondition(async () => {
        const artifactPath = path.join(
          getTeamsBasePath(),
          teamName,
          'launch-failure-artifacts',
          'latest.json'
        );
        return (await fs.stat(artifactPath).catch(() => null))?.isFile() === true;
      });
      expect(adapter.launchInputs.some((input) => input.laneId === 'secondary:opencode:tom')).toBe(
        false
      );
    });

    it('launches pure OpenCode worktree members as aggregate worktree-root lanes', async () => {
      const teamName = 'pure-opencode-worktree-root-lanes-safe-e2e';
      const bobWorktree = path.join(projectPath, '.agent-teams', 'bob');
      const tomWorktree = path.join(projectPath, '.agent-teams', 'tom');
      const worktreeManager: Pick<TeamMemberWorktreeManager, 'ensureMemberWorktree'> = {
        ensureMemberWorktree: vi.fn(async (input) => ({
          baseRepoPath: projectPath,
          worktreePath: input.memberName === 'bob' ? bobWorktree : tomWorktree,
          branchName: `agent-teams/${teamName}/${input.memberName}`,
        })),
      };
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        worktreeManager as TeamMemberWorktreeManager
      );
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              isolation: 'worktree',
            },
            {
              name: 'tom',
              role: 'Reviewer',
              providerId: 'opencode',
              isolation: 'worktree',
            },
          ],
        },
        (progress) => progressEvents.push(progress)
      );

      expect(runId).toMatch(/[0-9a-f-]{36}/);
      expect(worktreeManager.ensureMemberWorktree).toHaveBeenCalledTimes(2);
      expect(adapter.launchInputs.map((input) => input.laneId).sort()).toEqual([
        'primary',
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(adapter.launchInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            laneId: 'primary',
            cwd: projectPath,
            expectedMembers: [
              expect.objectContaining({
                name: 'team-lead',
                providerId: 'opencode',
              }),
            ],
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:bob',
            cwd: bobWorktree,
            runtimeOnly: true,
            expectedMembers: [
              expect.objectContaining({
                name: 'bob',
                providerId: 'opencode',
                isolation: 'worktree',
                cwd: bobWorktree,
              }),
            ],
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:tom',
            cwd: tomWorktree,
            runtimeOnly: true,
            expectedMembers: [
              expect.objectContaining({
                name: 'tom',
                providerId: 'opencode',
                isolation: 'worktree',
                cwd: tomWorktree,
              }),
            ],
          }),
        ])
      );
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode member lanes are ready',
      });
      expect(svc.getAliveTeams()).toContain(teamName);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: { state: 'active' },
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'primary',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [expect.objectContaining({ memberName: 'team-lead' })],
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'secondary:opencode:bob',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [expect.objectContaining({ memberName: 'bob' })],
      });
      await expect(
        readCommittedOpenCodeBootstrapSessionEvidence({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: 'secondary:opencode:tom',
        })
      ).resolves.toMatchObject({
        committed: true,
        sessions: [expect.objectContaining({ memberName: 'tom' })],
      });

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        launchState: 'confirmed_alive',
      });

      const launchCountBeforeRestart = adapter.launchInputs.length;
      await svc.restartMember(teamName, 'bob');
      expect(adapter.stopInputs).toEqual([
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          teamName,
        }),
      ]);
      expect(adapter.launchInputs).toHaveLength(launchCountBeforeRestart + 1);
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:bob',
        cwd: bobWorktree,
        runtimeOnly: true,
        expectedMembers: [
          expect.objectContaining({
            name: 'bob',
            providerId: 'opencode',
            isolation: 'worktree',
            cwd: bobWorktree,
          }),
        ],
      });

      const stopCountBeforeRelaunch = adapter.stopInputs.length;
      const launchCountBeforeRelaunch = adapter.launchInputs.length;
      await svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        (progress) => progressEvents.push(progress)
      );
      expect(
        adapter.stopInputs
          .slice(stopCountBeforeRelaunch)
          .map((input) => input.laneId)
          .sort()
      ).toEqual(['primary', 'secondary:opencode:bob', 'secondary:opencode:tom']);
      expect(
        adapter.launchInputs
          .slice(launchCountBeforeRelaunch)
          .map((input) => input.laneId)
          .sort()
      ).toEqual(['primary', 'secondary:opencode:bob', 'secondary:opencode:tom']);
    });

    it('accepts pure OpenCode runtime bootstrap check-ins during adapter launch', async () => {
      const svc = new TeamProvisioningService();
      const adapter = new BootstrapCheckingOpenCodeRuntimeAdapter(svc);
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName: 'pure-opencode-bootstrap-during-launch-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      expect(runId).toBe(adapter.launchInputs[0]?.runId);
      expect(adapter.bootstrapCheckins).toEqual([
        {
          memberName: 'team-lead',
          runId,
          state: 'accepted',
        },
      ]);

      const statuses = await svc.getMemberSpawnStatuses(
        'pure-opencode-bootstrap-during-launch-safe-e2e'
      );
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      });
    });

    it('keeps failed OpenCode runtime adapter launches out of alive teams', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      await svc.createTeam(
        {
          teamName: 'failed-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        (progress) => progressEvents.push(progress)
      );

      expect(progressEvents.at(-1)).toMatchObject({
        state: 'failed',
        message: 'OpenCode team launch failed readiness gate',
      });
      expect(svc.isTeamAlive('failed-opencode-safe-e2e')).toBe(false);

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot('failed-opencode-safe-e2e');
      expect(runtimeSnapshot.members.alice).toMatchObject({
        alive: false,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });
    });

    it('launches an existing pure OpenCode team config through the runtime adapter', async () => {
      await writeOpenCodeTeamConfig({
        teamName: 'existing-opencode-safe-e2e',
        projectPath,
        members: ['alice', 'bob'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      const { runId } = await svc.launchTeam(
        {
          teamName: 'existing-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        (progress) => progressEvents.push(progress)
      );

      expect(runId).toBe(adapter.launchInputs[0]?.runId);
      expect(adapter.launchInputs[0]?.expectedMembers.map((member) => member.name)).toEqual([
        'team-lead',
        'alice',
        'bob',
      ]);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });

      const statuses = await svc.getMemberSpawnStatuses('existing-opencode-safe-e2e');
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('materializes members metadata before relaunching a legacy pure team config', async () => {
      const teamName = 'legacy-pure-config-repair-safe-e2e';
      await writePureAnthropicTeamConfigWithMembers({
        teamName,
        projectPath,
        members: ['alice', 'bob'],
      });
      const svc = new TeamProvisioningService();
      vi.spyOn(svc as any, 'normalizeTeamConfigForLaunch').mockImplementation(async () => {
        throw new Error('stop after compatibility repair');
      });

      await expect(
        svc.launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'anthropic',
            model: 'sonnet',
            skipPermissions: true,
          },
          () => undefined
        )
      ).rejects.toThrow('stop after compatibility repair');

      const membersMeta = JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), teamName, 'members.meta.json'), 'utf8')
      ) as { members: Array<{ name: string; providerId?: string; model?: string }> };
      expect(membersMeta.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'alice', providerId: 'anthropic', model: 'haiku' }),
          expect.objectContaining({ name: 'bob', providerId: 'anthropic', model: 'sonnet' }),
        ])
      );
    });

    it('fails unsafe old mixed OpenCode config without launch-state or members metadata mutation', async () => {
      const teamName = 'legacy-mixed-config-unsafe-safe-e2e';
      await writeMixedTeamConfigWithoutOpenCodeProviderMetadata({ teamName, projectPath });
      const svc = new TeamProvisioningService();
      const normalizeSpy = vi.spyOn(svc as any, 'normalizeTeamConfigForLaunch');

      await expect(
        svc.launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
            skipPermissions: true,
          },
          () => undefined
        )
      ).rejects.toThrow(getMixedLaunchFallbackRecoveryError());

      expect(normalizeSpy).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'members.meta.json'), 'utf8')
      ).rejects.toThrow();
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ).rejects.toThrow();
    });

    it('keeps permission-pending OpenCode members pending instead of reading the team as fully ready', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const progressEvents: TeamProvisioningProgress[] = [];

      await svc.createTeam(
        {
          teamName: 'permission-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: false,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        (progress) => progressEvents.push(progress)
      );

      expect(progressEvents.at(-1)).toMatchObject({
        state: 'ready',
        message: 'OpenCode team launch is waiting for runtime evidence or permissions',
        messageSeverity: 'warning',
      });
      expect(svc.isTeamAlive('permission-opencode-safe-e2e')).toBe(true);

      const statuses = await svc.getMemberSpawnStatuses('permission-opencode-safe-e2e');
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        runtimeAlive: false,
        pendingPermissionRequestIds: ['perm-alice'],
      });
      expect(statuses.summary?.pendingCount).toBe(1);
    });

    it('routes OpenCode runtime approval UI responses back through the adapter', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName: 'approve-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: false,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const approval = approvalEvents.find(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event) && event.source === 'alice'
      );
      expect(approval).toMatchObject({
        runId: launch.runId,
        teamName: 'approve-opencode-safe-e2e',
        providerId: 'opencode',
        source: 'alice',
        toolName: 'Bash',
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'alice',
          providerRequestId: 'perm-alice',
        },
      });
      expect(approval?.toolInput).toMatchObject({
        provider: 'opencode',
        providerRequestId: 'perm-alice',
        command: 'git status',
      });

      await svc.respondToToolApproval(
        'approve-opencode-safe-e2e',
        launch.runId!,
        approval!.requestId,
        true
      );

      expect(adapter.permissionAnswerInputs).toEqual([
        expect.objectContaining({
          runId: launch.runId,
          teamName: 'approve-opencode-safe-e2e',
          laneId: 'primary',
          memberName: 'alice',
          requestId: 'perm-alice',
          decision: 'allow',
        }),
      ]);
      const statuses = await svc.getMemberSpawnStatuses('approve-opencode-safe-e2e');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.alice?.pendingPermissionRequestIds).toBeUndefined();
    });

    it('blocks createTeam at workspace trust preflight before spawn and preserves existing launch state', async () => {
      forceWorkspaceTrustPreflightEnv();
      process.env.CLAUDE_CLI_PATH = await writeFakeClaudeCli(tempDir);
      ClaudeBinaryResolver.clearCache();

      const teamName = 'workspace-trust-create-blocked-safe-e2e';
      const staleLaunchStatePath = path.join(getTeamsBasePath(), teamName, 'launch-state.json');
      const staleLaunchState = {
        version: 2,
        teamName,
        updatedAt: '2026-05-13T00:00:00.000Z',
        leadSessionId: 'previous-lead-session',
        launchPhase: 'finished',
        expectedMembers: ['alice'],
        bootstrapExpectedMembers: ['alice'],
        members: {},
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          shellOnlyPendingCount: 0,
          runtimeProcessPendingCount: 0,
          runtimeCandidatePendingCount: 0,
          noRuntimePendingCount: 0,
          permissionPendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      };
      await writeJsonFile(staleLaunchStatePath, staleLaunchState);

      const errorMessage = `Claude workspace trust was not confirmed for ${projectPath}`;
      const { coordinator, execute, planFull } = createBlockedWorkspaceTrustCoordinator({
        errorMessage,
        rawTail: 'Unexpected Claude startup screen',
      });
      const svc = new TeamProvisioningService();
      svc.setWorkspaceTrustCoordinator(coordinator);
      const progressEvents: TeamProvisioningProgress[] = [];

      await expect(
        svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'anthropic',
            model: 'sonnet',
            skipPermissions: true,
            members: [{ name: 'alice', role: 'Reviewer', providerId: 'anthropic', model: 'haiku' }],
          },
          (progress) => progressEvents.push(progress)
        )
      ).rejects.toThrow(errorMessage);

      expect(progressEvents.map((progress) => progress.message)).toContain(
        'Preparing workspace trust'
      );
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'failed',
        message: 'Workspace trust required',
        error: errorMessage,
      });
      expect(progressEvents.at(-1)?.launchDiagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'workspace_trust_preflight',
          label: 'Workspace trust preflight blocked launch',
          detail: errorMessage,
        }),
      ]);
      expect(planFull).toHaveBeenCalledTimes(1);
      expect(planFull.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ providers: ['claude'] })
      );
      expect(execute).toHaveBeenCalledTimes(1);
      const executePlan = execute.mock.calls[0]?.[0];
      expect(executePlan).toBeDefined();
      expect(executePlan?.providers).toEqual(['claude']);
      expect(executePlan?.workspaces.map((workspace) => workspace.cwd)).toContain(projectPath);

      await expect(fs.readFile(staleLaunchStatePath, 'utf8')).resolves.toBe(
        `${JSON.stringify(staleLaunchState, null, 2)}\n`
      );
      await expect(
        fs.access(path.join(getTeamsBasePath(), teamName, 'config.json'))
      ).rejects.toThrow();

      const manifest = await readLatestLaunchFailureManifest(teamName);
      expect(manifest).toMatchObject({
        reason: 'launch_progress_failed',
        classification: { code: 'workspace_trust_required' },
        progress: {
          state: 'failed',
          message: 'Workspace trust required',
          error: errorMessage,
        },
        flags: {
          isLaunch: false,
          workspaceTrustPreflight: {
            strategyResults: [
              expect.objectContaining({
                status: 'blocked',
                errorCode: 'workspace_trust_preflight_not_confirmed',
                errorMessage,
                rawTail: 'Unexpected Claude startup screen',
              }),
            ],
          },
        },
      });
      expect(manifest.launchDiagnostics).toEqual([
        expect.objectContaining({
          code: 'workspace_trust_preflight',
          severity: 'error',
          detail: errorMessage,
        }),
      ]);
    });

    it('blocks launchTeam at workspace trust preflight and restores the prelaunch config backup', async () => {
      forceWorkspaceTrustPreflightEnv();
      process.env.CLAUDE_CLI_PATH = await writeFakeClaudeCli(tempDir);
      ClaudeBinaryResolver.clearCache();

      const teamName = 'workspace-trust-launch-blocked-safe-e2e';
      const originalProjectPath = path.join(tempDir, 'original-project');
      const nextProjectPath = path.join(tempDir, 'next-project');
      await fs.mkdir(originalProjectPath, { recursive: true });
      await fs.mkdir(nextProjectPath, { recursive: true });
      const originalConfig = await writeAnthropicTeamConfig({
        teamName,
        projectPath: originalProjectPath,
        members: ['alice', 'bob'],
      });

      const errorMessage = `Claude workspace trust was not confirmed for ${nextProjectPath}`;
      const { coordinator, execute } = createBlockedWorkspaceTrustCoordinator({
        errorMessage,
        evidence: ['workspace trust preflight blocked launch'],
      });
      const svc = new TeamProvisioningService();
      svc.setWorkspaceTrustCoordinator(coordinator);
      const progressEvents: TeamProvisioningProgress[] = [];

      await expect(
        svc.launchTeam(
          {
            teamName,
            cwd: nextProjectPath,
            providerId: 'anthropic',
            model: 'sonnet',
            skipPermissions: true,
          },
          (progress) => progressEvents.push(progress)
        )
      ).rejects.toThrow(errorMessage);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'failed',
        message: 'Workspace trust required',
        error: errorMessage,
      });
      await expect(
        fs.readFile(path.join(getTeamsBasePath(), teamName, 'config.json'), 'utf8')
      ).resolves.toBe(originalConfig);

      const manifest = await readLatestLaunchFailureManifest(teamName);
      expect(manifest).toMatchObject({
        classification: { code: 'workspace_trust_required' },
        flags: {
          isLaunch: true,
          workspaceTrustPreflight: {
            strategyResults: [
              expect.objectContaining({
                status: 'blocked',
                errorMessage,
              }),
            ],
          },
        },
      });
      expect(manifest.progress.launchDiagnostics).toEqual([
        expect.objectContaining({
          code: 'workspace_trust_preflight',
          severity: 'error',
          detail: errorMessage,
        }),
      ]);
    });

    it('preserves mixed OpenCode per-member outcomes after a partial runtime adapter launch', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure', {
        alice: 'confirmed',
        bob: 'permission',
        tom: 'failed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'mixed-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: false,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
            { name: 'tom', role: 'Developer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );

      expect(svc.isTeamAlive('mixed-opencode-safe-e2e')).toBe(false);
      expect(adapter.stopInputs).toHaveLength(0);

      const statuses = await svc.getMemberSpawnStatuses('mixed-opencode-safe-e2e');
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        runtimeAlive: false,
        pendingPermissionRequestIds: ['perm-bob'],
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason: 'fake_open_code_launch_failure',
      });
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 1,
      });
    });

    it('stops a pure OpenCode runtime adapter team and clears alive tracking', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'stoppable-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      expect(svc.isTeamAlive('stoppable-opencode-safe-e2e')).toBe(true);

      await svc.stopTeam('stoppable-opencode-safe-e2e');

      await waitForCondition(() => adapter.stopInputs.length === 1);
      await waitForCondition(() => !svc.isTeamAlive('stoppable-opencode-safe-e2e'));
      expect(adapter.stopInputs[0]).toMatchObject({
        teamName: 'stoppable-opencode-safe-e2e',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
    });

    it('stops one pure OpenCode runtime adapter team without disconnecting another team', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'pure-opencode-stop-isolated-a-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await svc.createTeam(
        {
          teamName: 'pure-opencode-stop-isolated-b-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      expect(svc.isTeamAlive('pure-opencode-stop-isolated-a-safe-e2e')).toBe(true);
      expect(svc.isTeamAlive('pure-opencode-stop-isolated-b-safe-e2e')).toBe(true);

      await svc.stopTeam('pure-opencode-stop-isolated-a-safe-e2e');

      await waitForCondition(() => adapter.stopInputs.length === 1);
      await waitForCondition(() => !svc.isTeamAlive('pure-opencode-stop-isolated-a-safe-e2e'));
      expect(svc.isTeamAlive('pure-opencode-stop-isolated-b-safe-e2e')).toBe(true);
      expect(adapter.stopInputs[0]).toMatchObject({
        teamName: 'pure-opencode-stop-isolated-a-safe-e2e',
        providerId: 'opencode',
        reason: 'user_requested',
      });

      const survivingStatuses = await svc.getMemberSpawnStatuses(
        'pure-opencode-stop-isolated-b-safe-e2e'
      );
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      const survivingSnapshot = await svc.getTeamAgentRuntimeSnapshot(
        'pure-opencode-stop-isolated-b-safe-e2e'
      );
      expect(survivingSnapshot.members.bob).toMatchObject({
        alive: true,
        providerId: 'opencode',
        runtimeModel: 'opencode/big-pickle',
      });
    });

    it('lists only still-running OpenCode runtime adapter teams after one team stops', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'pure-opencode-alive-list-a-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await svc.createTeam(
        {
          teamName: 'pure-opencode-alive-list-b-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      expect(svc.getAliveTeams().sort()).toEqual([
        'pure-opencode-alive-list-a-safe-e2e',
        'pure-opencode-alive-list-b-safe-e2e',
      ]);

      await svc.stopTeam('pure-opencode-alive-list-a-safe-e2e');

      await waitForCondition(() => !svc.isTeamAlive('pure-opencode-alive-list-a-safe-e2e'));
      expect(svc.getAliveTeams()).toEqual(['pure-opencode-alive-list-b-safe-e2e']);
      const statuses = await svc.getMemberSpawnStatuses('pure-opencode-alive-list-b-safe-e2e');
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('reports pure OpenCode runtime state as alive before stop and offline after stop', async () => {
      const teamName = 'pure-opencode-runtime-state-stop-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const runningState = await svc.getRuntimeState(teamName);
      expect(runningState).toMatchObject({
        teamName,
        isAlive: true,
        runId,
        progress: {
          state: 'ready',
          message: 'OpenCode team launch is ready',
        },
      });

      await svc.stopTeam(teamName);

      await waitForCondition(() => !svc.isTeamAlive(teamName));
      const stoppedState = await svc.getRuntimeState(teamName);
      expect(stoppedState).toMatchObject({
        teamName,
        isAlive: false,
      });
    });

    it('stops the stale pure OpenCode primary runtime before same-team relaunch', async () => {
      const teamName = 'pure-opencode-relaunch-stops-stale-runtime-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const first = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(adapter.stopInputs).toHaveLength(0);
      const firstSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(firstSnapshot).toMatchObject({
        runId: first.runId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });

      const second = await svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      expect(second.runId).not.toBe(first.runId);
      expect(adapter.launchInputs.map((input) => input.runId)).toEqual([first.runId, second.runId]);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: first.runId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      expect(svc.isTeamAlive(teamName)).toBe(true);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: second.runId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });

      await svc.stopTeam(teamName);

      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs[1]).toMatchObject({
        runId: second.runId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      await waitForCondition(() => !svc.isTeamAlive(teamName));
    });

    it('relaunches one pure OpenCode team without stopping another live OpenCode team', async () => {
      const relaunchTeamName = 'pure-opencode-relaunch-isolated-a-safe-e2e';
      const survivingTeamName = 'pure-opencode-relaunch-isolated-b-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const relaunchFirst = await svc.createTeam(
        {
          teamName: relaunchTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const surviving = await svc.createTeam(
        {
          teamName: survivingTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const relaunchSecond = await svc.launchTeam(
        {
          teamName: relaunchTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: relaunchFirst.runId,
        teamName: relaunchTeamName,
        laneId: 'primary',
        providerId: 'opencode',
      });
      expect(svc.getAliveTeams().sort()).toEqual([relaunchTeamName, survivingTeamName].sort());

      const relaunchedSnapshot = await svc.getTeamAgentRuntimeSnapshot(relaunchTeamName);
      expect(relaunchedSnapshot).toMatchObject({
        runId: relaunchSecond.runId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });
      const survivingSnapshot = await svc.getTeamAgentRuntimeSnapshot(survivingTeamName);
      expect(survivingSnapshot).toMatchObject({
        runId: surviving.runId,
        members: {
          bob: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });
    });

    it('serializes same-team pure OpenCode relaunch behind an in-flight launch before replacing the current run', async () => {
      const teamName = 'pure-opencode-relaunch-queued-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(firstRunId).toBeTruthy();

      const secondPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );
      await Promise.resolve();
      expect(adapter.pendingLaunchInputs).toHaveLength(1);
      expect(adapter.stopInputs).toHaveLength(0);

      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      const second = await secondPromise;
      const secondRunId = second.runId;
      expect(secondRunId).toBeTruthy();
      expect(secondRunId).not.toBe(firstRunId);

      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(svc.getAliveTeams()).toEqual([teamName]);
      expect(adapter.launchInputs.map((input) => input.runId)).toEqual([firstRunId, secondRunId]);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: firstRunId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: secondRunId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: { state: 'active' },
        },
      });
    });

    it('keeps relaunch waiting while the previous same-team OpenCode runtime stop is slow', async () => {
      const teamName = 'pure-opencode-relaunch-slow-stop-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(firstRunId).toBeTruthy();
      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      expect(svc.isTeamAlive(teamName)).toBe(true);

      const secondPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: firstRunId,
        teamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
        runId: firstRunId,
        teamName,
        state: 'disconnected',
        message: 'Stopping OpenCode team through runtime adapter',
      });
      expect(adapter.pendingLaunchInputs).toHaveLength(1);
      expect(adapter.launchInputs).toHaveLength(1);
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseStops();
      const second = await secondPromise;
      expect(second.runId).toBeTruthy();
      expect(second.runId).not.toBe(firstRunId);
      await waitForCondition(() => adapter.launchInputs.length === 2);

      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(svc.getAliveTeams()).toEqual([teamName]);
      await expect(svc.getProvisioningStatus(second.runId)).resolves.toMatchObject({
        runId: second.runId,
        teamName,
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });
      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: second.runId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });
    });

    it('serializes manual stop and same-team OpenCode relaunch behind a slow runtime stop', async () => {
      const teamName = 'pure-opencode-stop-then-relaunch-slow-stop-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(firstRunId).toBeTruthy();
      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      expect(svc.getAliveTeams()).toEqual([teamName]);

      svc.stopTeam(teamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: firstRunId,
        teamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'user_requested',
        force: true,
      });
      expect(svc.getAliveTeams()).toEqual([]);

      const secondPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );
      await Promise.resolve();
      expect(adapter.pendingLaunchInputs).toHaveLength(1);
      expect(adapter.launchInputs).toHaveLength(1);

      adapter.releaseStops();
      const second = await secondPromise;
      expect(second.runId).toBeTruthy();
      expect(second.runId).not.toBe(firstRunId);
      await waitForCondition(() => adapter.launchInputs.length === 2);

      expect(svc.getAliveTeams()).toEqual([teamName]);
      await expect(svc.getProvisioningStatus(second.runId)).resolves.toMatchObject({
        runId: second.runId,
        teamName,
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });
    });

    it('keeps slow OpenCode stop scoped to one team while another team relaunches', async () => {
      const stoppingTeamName = 'pure-opencode-cross-team-slow-stop-a-safe-e2e';
      const relaunchTeamName = 'pure-opencode-cross-team-slow-stop-b-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const stoppingCreate = svc.createTeam(
        {
          teamName: stoppingTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      adapter.releaseLaunches();
      const stopping = await stoppingCreate;

      const relaunchFirst = await svc.createTeam(
        {
          teamName: relaunchTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.launchInputs.length === 2);
      expect(svc.getAliveTeams().sort()).toEqual([relaunchTeamName, stoppingTeamName].sort());
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), stoppingTeamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: { state: 'active' },
        },
      });

      const stoppingPromise = svc.stopTeam(stoppingTeamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: stopping.runId,
        teamName: stoppingTeamName,
        laneId: 'primary',
        reason: 'user_requested',
      });
      expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
      expect(svc.isTeamAlive(relaunchTeamName)).toBe(true);

      const relaunchSecondPromise = svc.launchTeam(
        {
          teamName: relaunchTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );
      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs[1]).toMatchObject({
        runId: relaunchFirst.runId,
        teamName: relaunchTeamName,
        laneId: 'primary',
        reason: 'user_requested',
      });
      expect(adapter.launchInputs).toHaveLength(2);

      adapter.releaseStops();
      const [relaunchSecond] = await Promise.all([relaunchSecondPromise, stoppingPromise]);
      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(relaunchSecond.runId).not.toBe(relaunchFirst.runId);
      expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
      expect(svc.isTeamAlive(relaunchTeamName)).toBe(true);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), stoppingTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('isolates rejected stale-run cancellation from deduped replacement cancellation', async () => {
      const teamName = 'pure-opencode-cross-run-stop-failure-safe-e2e';
      const oldRunId = 'run-old';
      const replacementRunId = 'run-new';
      const adapter = new RejectingThenBlockingStopOpenCodeRuntimeAdapter('run-old stop rejected');
      const runtimeAdapterRunByTeam = new Map([
        [
          teamName,
          {
            runId: oldRunId,
            providerId: 'opencode' as const,
            cwd: projectPath,
          },
        ],
      ]);
      const provisioningRunByTeam = new Map([[teamName, oldRunId]]);
      const aliveRunByTeam = new Map([[teamName, oldRunId]]);
      const runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
      const warnings: string[] = [];
      const ports: RuntimeAdapterCancellationPorts = {
        cancelledRuntimeAdapterRunIds: new Set(),
        runtimeAdapterRunByTeam,
        runtimeAdapterProgressByRunId,
        provisioningRunByTeam,
        aliveRunByTeam,
        teamsBasePath: getTeamsBasePath(),
        nowIso: () => '2026-05-08T10:00:00.000Z',
        clearOpenCodeRuntimeToolApprovals: () => undefined,
        deleteAliveRunId: (ownerTeamName) => {
          aliveRunByTeam.delete(ownerTeamName);
        },
        invalidateRuntimeSnapshotCaches: () => undefined,
        setRuntimeAdapterProgress: (progress, onProgress) => {
          runtimeAdapterProgressByRunId.set(progress.runId, progress);
          onProgress?.(progress);
          return progress;
        },
        emitTeamChange: () => undefined,
        readLaunchState: async () => null,
        getOpenCodeRuntimeAdapter: () => adapter,
        readPersistedTeamProjectPath: () => projectPath,
        clearOpenCodeRuntimeLaneStorage: async () => true,
        logWarning: (message) => {
          warnings.push(message);
        },
      };
      const cancellationProgress = (runId: string): TeamProvisioningProgress => ({
        runId,
        teamName,
        state: 'spawning',
        message: `Launching ${runId}`,
        startedAt: '2026-05-08T09:59:00.000Z',
        updatedAt: '2026-05-08T09:59:30.000Z',
      });

      const oldStopping = stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
        teamName,
        runId: oldRunId,
        ports,
      });
      await waitForCondition(() => adapter.stopInputs.length === 1);

      const replacementOwner = {
        runId: replacementRunId,
        providerId: 'opencode' as const,
        cwd: projectPath,
      };
      runtimeAdapterRunByTeam.set(teamName, replacementOwner);
      provisioningRunByTeam.set(teamName, replacementRunId);
      aliveRunByTeam.set(teamName, replacementRunId);
      const replacementProgress = cancellationProgress(replacementRunId);
      const replacementCancellation = cancelRuntimeAdapterProvisioning({
        runId: replacementRunId,
        runtimeProgress: replacementProgress,
        ports,
      });
      const duplicateReplacementCancellation = cancelRuntimeAdapterProvisioning({
        runId: replacementRunId,
        runtimeProgress: replacementProgress,
        ports,
      });

      await Promise.resolve();
      expect(adapter.stopInputs).toHaveLength(1);
      adapter.rejectOldStop();
      await waitForCondition(() => adapter.stopInputs.length === 2);
      const oldOutcome = await oldStopping;

      expect(oldOutcome).toBe(false);
      expect(adapter.stopInputs.map((input) => input.runId)).toEqual([oldRunId, replacementRunId]);
      expect(runtimeAdapterRunByTeam.get(teamName)).toBe(replacementOwner);
      expect(provisioningRunByTeam.get(teamName)).toBe(replacementRunId);
      expect(aliveRunByTeam.get(teamName)).toBe(replacementRunId);
      expect(warnings).toEqual([
        `[${teamName}] Failed to stop OpenCode runtime adapter launch before primary lane cleanup: run-old stop rejected`,
      ]);

      adapter.releaseReplacementStop();
      const replacementOutcomes = await Promise.allSettled([
        replacementCancellation,
        duplicateReplacementCancellation,
      ]);

      expect(replacementOutcomes).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(adapter.stopInputs).toHaveLength(2);
      expect(runtimeAdapterRunByTeam.has(teamName)).toBe(false);
      expect(provisioningRunByTeam.has(teamName)).toBe(false);
      expect(aliveRunByTeam.has(teamName)).toBe(false);
      expect(runtimeAdapterProgressByRunId.has(oldRunId)).toBe(false);
      expect(runtimeAdapterProgressByRunId.get(replacementRunId)).toMatchObject({
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      });
    });

    it('does not resurrect a same-team OpenCode relaunch after stopAllTeams during slow replacement stop', async () => {
      const teamName = 'pure-opencode-relaunch-stop-all-during-slow-stop-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(firstRunId).toBeTruthy();
      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const relaunchPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: firstRunId,
        teamName,
        laneId: 'primary',
        reason: 'user_requested',
      });
      expect(adapter.launchInputs).toHaveLength(1);

      const stopAllPromise = svc.stopAllTeams();
      adapter.releaseStops();
      const [relaunch] = await Promise.all([relaunchPromise, stopAllPromise]);

      expect(relaunch.runId).toBeTruthy();
      expect(relaunch.runId).not.toBe(firstRunId);
      expect(adapter.launchInputs).toHaveLength(1);
      await expect(svc.getProvisioningStatus(relaunch.runId)).resolves.toMatchObject({
        runId: relaunch.runId,
        teamName,
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('allows a fresh OpenCode launch after stopAllTeams cancelled a queued same-team relaunch', async () => {
      const teamName = 'pure-opencode-launch-after-stop-all-cancelled-relaunch-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(firstRunId).toBeTruthy();
      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const cancelledRelaunchPromise = svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );
      await waitForCondition(() => adapter.stopInputs.length === 1);
      const stopAllPromise = svc.stopAllTeams();
      adapter.releaseStops();
      const cancelledRelaunch = await cancelledRelaunchPromise;
      await stopAllPromise;

      expect(adapter.launchInputs).toHaveLength(1);
      await expect(svc.getProvisioningStatus(cancelledRelaunch.runId)).resolves.toMatchObject({
        runId: cancelledRelaunch.runId,
        teamName,
        state: 'cancelled',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);

      const freshLaunch = await svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      expect(freshLaunch.runId).toBeTruthy();
      expect(freshLaunch.runId).not.toBe(firstRunId);
      expect(freshLaunch.runId).not.toBe(cancelledRelaunch.runId);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      expect(adapter.launchInputs[1]).toMatchObject({
        runId: freshLaunch.runId,
        teamName,
        providerId: 'opencode',
        cwd: projectPath,
      });
      await expect(svc.getProvisioningStatus(freshLaunch.runId)).resolves.toMatchObject({
        runId: freshLaunch.runId,
        teamName,
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });
      expect(svc.isTeamAlive(teamName)).toBe(true);
      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: freshLaunch.runId,
        members: {
          alice: {
            alive: true,
            providerId: 'opencode',
            runtimeModel: 'opencode/big-pickle',
          },
        },
      });
    });

    it('stopAllTeams does not double-stop an already stopping OpenCode team and still stops live siblings', async () => {
      const stoppingTeamName = 'pure-opencode-stop-all-already-stopping-a-safe-e2e';
      const liveTeamName = 'pure-opencode-stop-all-already-stopping-b-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const stoppingCreate = svc.createTeam(
        {
          teamName: stoppingTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const stoppingRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(stoppingRunId).toBeTruthy();
      adapter.releaseLaunches();
      await expect(stoppingCreate).resolves.toEqual({ runId: stoppingRunId });

      const live = await svc.createTeam(
        {
          teamName: liveTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.launchInputs.length === 2);
      expect(svc.getAliveTeams().sort()).toEqual([liveTeamName, stoppingTeamName].sort());

      const stoppingTeam = svc.stopTeam(stoppingTeamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: stoppingRunId,
        teamName: stoppingTeamName,
        laneId: 'primary',
        reason: 'user_requested',
      });
      expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
      expect(svc.isTeamAlive(liveTeamName)).toBe(true);

      const stoppingAllTeams = svc.stopAllTeams();
      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: stoppingRunId,
            teamName: stoppingTeamName,
            laneId: 'primary',
            reason: 'user_requested',
          }),
          expect.objectContaining({
            runId: live.runId,
            teamName: liveTeamName,
            laneId: 'primary',
            reason: 'user_requested',
          }),
        ])
      );
      expect(
        adapter.stopInputs.filter((input) => input.teamName === stoppingTeamName)
      ).toHaveLength(1);
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseStops();
      await Promise.all([stoppingTeam, stoppingAllTeams]);
      expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), stoppingTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), liveTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('cancels an in-flight pure OpenCode runtime adapter launch without letting late success resurrect it', async () => {
      const teamName = 'pure-opencode-cancel-inflight-runtime-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const createPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const runId = adapter.pendingLaunchInputs[0]?.runId;
      expect(runId).toBeTruthy();

      await svc.cancelProvisioning(runId!);

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await expect(createPromise).resolves.toEqual({ runId });
      await waitForCondition(() => adapter.launchInputs.length === 1);

      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(svc.getAliveTeams()).not.toContain(teamName);
      const state = await svc.getRuntimeState(teamName);
      expect(state).toMatchObject({
        teamName,
        isAlive: false,
        runId: null,
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
    });

    it('shows cancelled status immediately when manual cancel waits on a slow OpenCode stop', async () => {
      const teamName = 'pure-opencode-cancel-slow-stop-status-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const createPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const runId = adapter.pendingLaunchInputs[0]?.runId;
      expect(runId).toBeTruthy();

      const cancelPromise = svc.cancelProvisioning(runId!);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
        message: 'Provisioning cancellation requested; stopping OpenCode runtime',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await expect(createPromise).resolves.toEqual({ runId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
      });

      adapter.releaseStops();
      await expect(cancelPromise).resolves.toBeUndefined();
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      expect(svc.getAliveTeams()).not.toContain(teamName);
    });

    it('cancels one in-flight pure OpenCode launch without cancelling another OpenCode team', async () => {
      const cancelledTeamName = 'pure-opencode-cancel-inflight-isolated-a-safe-e2e';
      const survivingTeamName = 'pure-opencode-cancel-inflight-isolated-b-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const cancelledPromise = svc.createTeam(
        {
          teamName: cancelledTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const survivingPromise = svc.createTeam(
        {
          teamName: survivingTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
      const cancelledRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === cancelledTeamName
      )?.runId;
      const survivingRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === survivingTeamName
      )?.runId;
      expect(cancelledRunId).toBeTruthy();
      expect(survivingRunId).toBeTruthy();

      await svc.cancelProvisioning(cancelledRunId!);

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: cancelledRunId,
        teamName: cancelledTeamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(false);

      adapter.releaseLaunches();

      await expect(cancelledPromise).resolves.toEqual({ runId: cancelledRunId });
      await expect(survivingPromise).resolves.toEqual({ runId: survivingRunId });
      await waitForCondition(() => adapter.launchInputs.length === 2);

      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);
      expect(svc.getAliveTeams()).toEqual([survivingTeamName]);
      await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
        runId: cancelledRunId,
        teamName: cancelledTeamName,
        state: 'cancelled',
      });
      const survivingState = await svc.getRuntimeState(survivingTeamName);
      expect(survivingState).toMatchObject({
        teamName: survivingTeamName,
        isAlive: true,
        runId: survivingRunId,
        progress: {
          state: 'ready',
          message: 'OpenCode team launch is ready',
        },
      });
      const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('manual cancel with slow OpenCode stop stays scoped while another in-flight team succeeds', async () => {
      const cancelledTeamName = 'pure-opencode-cancel-slow-stop-isolated-a-safe-e2e';
      const survivingTeamName = 'pure-opencode-cancel-slow-stop-isolated-b-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const cancelledPromise = svc.createTeam(
        {
          teamName: cancelledTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const survivingPromise = svc.createTeam(
        {
          teamName: survivingTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
      const cancelledRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === cancelledTeamName
      )?.runId;
      const survivingRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === survivingTeamName
      )?.runId;
      expect(cancelledRunId).toBeTruthy();
      expect(survivingRunId).toBeTruthy();

      const cancelPromise = svc.cancelProvisioning(cancelledRunId!);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: cancelledRunId,
        teamName: cancelledTeamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
        runId: cancelledRunId,
        teamName: cancelledTeamName,
        state: 'cancelled',
      });
      await expect(svc.getProvisioningStatus(survivingRunId!)).resolves.toMatchObject({
        runId: survivingRunId,
        teamName: survivingTeamName,
        state: 'spawning',
      });
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseLaunches();
      await expect(cancelledPromise).resolves.toEqual({ runId: cancelledRunId });
      await expect(survivingPromise).resolves.toEqual({ runId: survivingRunId });
      await waitForCondition(() => adapter.launchInputs.length === 2);

      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);
      expect(svc.getAliveTeams()).toEqual([survivingTeamName]);
      await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
        state: 'cancelled',
      });
      await expect(svc.getProvisioningStatus(survivingRunId!)).resolves.toMatchObject({
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });

      adapter.releaseStops();
      await expect(cancelPromise).resolves.toBeUndefined();
      const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects cancel for a ready pure OpenCode runtime adapter team without stopping it', async () => {
      const teamName = 'pure-opencode-cancel-ready-reject-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(svc.cancelProvisioning(runId)).rejects.toThrow(
        'Provisioning cannot be cancelled in current state'
      );
      expect(adapter.stopInputs).toEqual([]);
      expect(svc.isTeamAlive(teamName)).toBe(true);
      const state = await svc.getRuntimeState(teamName);
      expect(state).toMatchObject({
        teamName,
        isAlive: true,
        runId,
        progress: {
          state: 'ready',
          message: 'OpenCode team launch is ready',
        },
      });
    });

    it('does not stop a live OpenCode team when cancelling an unknown run id', async () => {
      const teamName = 'pure-opencode-cancel-unknown-run-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(svc.cancelProvisioning('missing-run-id')).rejects.toThrow('Unknown runId');

      expect(adapter.stopInputs).toHaveLength(0);
      expect(svc.isTeamAlive(teamName)).toBe(true);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('stopAllTeams cancels an in-flight pure OpenCode runtime adapter launch without late success resurrecting it', async () => {
      const teamName = 'pure-opencode-stop-all-inflight-runtime-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const createPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const runId = adapter.pendingLaunchInputs[0]?.runId;
      expect(runId).toBeTruthy();

      const stopAllPromise = svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await expect(createPromise).resolves.toEqual({ runId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await stopAllPromise;

      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(svc.getAliveTeams()).not.toContain(teamName);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.alice?.launchState).not.toBe('confirmed_alive');
    });

    it('allows a fresh OpenCode launch after stopAllTeams cancelled an in-flight create', async () => {
      const teamName = 'pure-opencode-launch-after-stop-all-cancelled-create-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const createPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const cancelledRunId = adapter.pendingLaunchInputs[0]?.runId;
      expect(cancelledRunId).toBeTruthy();

      const stopAllPromise = svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: cancelledRunId,
        teamName,
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
        runId: cancelledRunId,
        teamName,
        state: 'cancelled',
      });

      adapter.releaseLaunches();
      await expect(createPromise).resolves.toEqual({ runId: cancelledRunId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await stopAllPromise;
      expect(svc.isTeamAlive(teamName)).toBe(false);

      const freshLaunch = await svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      expect(freshLaunch.runId).toBeTruthy();
      expect(freshLaunch.runId).not.toBe(cancelledRunId);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      expect(adapter.launchInputs[1]).toMatchObject({
        runId: freshLaunch.runId,
        teamName,
        providerId: 'opencode',
        cwd: projectPath,
      });
      await expect(svc.getProvisioningStatus(freshLaunch.runId)).resolves.toMatchObject({
        runId: freshLaunch.runId,
        teamName,
        state: 'ready',
        message: 'OpenCode team launch is ready',
      });
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('shows cancelled status immediately when stopAllTeams waits on a slow OpenCode stop', async () => {
      const teamName = 'pure-opencode-stop-all-slow-stop-status-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const createPromise = svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const runId = adapter.pendingLaunchInputs[0]?.runId;
      expect(runId).toBeTruthy();

      const stopAllPromise = svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        cwd: projectPath,
        reason: 'user_requested',
        force: true,
      });
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
        message: 'Provisioning cancellation requested; stopping OpenCode runtime',
      });
      expect(svc.getAliveTeams()).not.toContain(teamName);

      adapter.releaseLaunches();
      await expect(createPromise).resolves.toEqual({ runId });
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
        runId,
        teamName,
        state: 'cancelled',
      });
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseStops();
      await stopAllPromise;
      await waitForCondition(() => adapter.stopInputs.length === 1);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('shows cancelled status immediately for multiple teams when OpenCode stops are slow', async () => {
      const firstTeamName = 'pure-opencode-stop-all-slow-stop-multi-a-safe-e2e';
      const secondTeamName = 'pure-opencode-stop-all-slow-stop-multi-b-safe-e2e';
      const adapter = new BlockingStopOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName: firstTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const secondPromise = svc.createTeam(
        {
          teamName: secondTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
      const firstRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === firstTeamName
      )?.runId;
      const secondRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === secondTeamName
      )?.runId;
      expect(firstRunId).toBeTruthy();
      expect(secondRunId).toBeTruthy();

      const stopAllPromise = svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
        firstTeamName,
        secondTeamName,
      ]);
      expect(adapter.stopInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: firstRunId,
            teamName: firstTeamName,
            laneId: 'primary',
            cwd: projectPath,
            reason: 'user_requested',
            force: true,
          }),
          expect.objectContaining({
            runId: secondRunId,
            teamName: secondTeamName,
            laneId: 'primary',
            cwd: projectPath,
            reason: 'user_requested',
            force: true,
          }),
        ])
      );
      await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
        runId: firstRunId,
        teamName: firstTeamName,
        state: 'cancelled',
      });
      await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
        runId: secondRunId,
        teamName: secondTeamName,
        state: 'cancelled',
      });
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await expect(secondPromise).resolves.toEqual({ runId: secondRunId });
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
        state: 'cancelled',
      });
      await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
        state: 'cancelled',
      });
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseStops();
      await stopAllPromise;
      await waitForCondition(() => adapter.stopInputs.length === 2);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('stopAllTeams cancels multiple in-flight pure OpenCode launches without cross-team resurrection', async () => {
      const firstTeamName = 'pure-opencode-stop-all-inflight-multi-a-safe-e2e';
      const secondTeamName = 'pure-opencode-stop-all-inflight-multi-b-safe-e2e';
      const adapter = new BlockingOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const firstPromise = svc.createTeam(
        {
          teamName: firstTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const secondPromise = svc.createTeam(
        {
          teamName: secondTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
      const firstRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === firstTeamName
      )?.runId;
      const secondRunId = adapter.pendingLaunchInputs.find(
        (input) => input.teamName === secondTeamName
      )?.runId;
      expect(firstRunId).toBeTruthy();
      expect(secondRunId).toBeTruthy();

      svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
        firstTeamName,
        secondTeamName,
      ]);
      expect(adapter.stopInputs.map((input) => input.laneId)).toEqual(['primary', 'primary']);
      await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
        runId: firstRunId,
        teamName: firstTeamName,
        state: 'cancelled',
      });
      await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
        runId: secondRunId,
        teamName: secondTeamName,
        state: 'cancelled',
      });

      adapter.releaseLaunches();
      await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
      await expect(secondPromise).resolves.toEqual({ runId: secondRunId });
      await waitForCondition(() => adapter.launchInputs.length === 2);

      expect(svc.getAliveTeams()).toEqual([]);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('stops pure OpenCode and mixed secondary runtime teams during stopAllTeams', async () => {
      const pureTeamName = 'pure-opencode-stop-all-safe-e2e';
      const mixedTeamName = 'mixed-opencode-stop-all-safe-e2e';
      await writeMixedTeamConfig({ teamName: mixedTeamName, projectPath });
      await writeTeamMeta(mixedTeamName, projectPath);
      await writeMembersMeta(mixedTeamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: pureTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const mixedRun = createMixedLiveRun({ teamName: mixedTeamName, projectPath });
      mixedRun.child = { kill: () => undefined };
      trackLiveRun(svc, mixedRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(mixedRun);
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        mixedRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      expect(svc.getAliveTeams().sort()).toEqual([mixedTeamName, pureTeamName].sort());

      await svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 3);
      await waitForCondition(() => svc.getAliveTeams().length === 0);
      expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
        mixedTeamName,
        mixedTeamName,
        pureTeamName,
      ]);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'primary',
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
    });

    it('launches mixed OpenCode lanes after a fresh abandoned lane index lock', async () => {
      const teamName = 'mixed-opencode-abandoned-lane-lock-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const lockPath = `${getOpenCodeRuntimeLaneIndexPath(getTeamsBasePath(), teamName)}.lock`;
      const abandonedPid = 424_242;
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, `${abandonedPid}\n${Date.now()}\n`, 'utf8');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number | string) => {
        if (pid === abandonedPid) {
          const error = new Error('process is gone') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }) as typeof process.kill);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);

      try {
        await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      } finally {
        killSpy.mockRestore();
      }

      await waitForCondition(() => adapter.launchInputs.length === 2);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'finished',
        'finished',
      ]);
    });

    it('stopAllTeams stops in-flight mixed OpenCode secondary lanes without late failure degrading launch state', async () => {
      const teamName = 'mixed-opencode-stop-all-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake shutdown bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({ hardFailure: false });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({ hardFailure: false });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('allows fresh mixed OpenCode secondary lanes after stopAllTeams cancelled in-flight handoff', async () => {
      const teamName = 'mixed-opencode-fresh-after-stop-all-cancelled-handoff-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const quiescenceState = svc as unknown as {
        aliveRunByTeam: Map<string, string>;
        provisioningRunByTeam: Map<string, string>;
        secondaryRuntimeRunByTeam: Map<string, Map<string, unknown>>;
        stoppingSecondaryRuntimeTeams: Set<string>;
        teamOpLocks: Map<string, Promise<unknown>>;
      };
      stubLiveOpenCodeRuntimeProcessesForTest(svc, teamName, ['bob', 'tom']);
      const cancelledRun = createMixedLiveRun({ teamName, projectPath });
      cancelledRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      const stopAllPromise = svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await stopAllPromise;
      expect(svc.getAliveTeams()).toEqual([]);
      expect(quiescenceState.aliveRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.provisioningRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.secondaryRuntimeRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.stoppingSecondaryRuntimeTeams.has(teamName)).toBe(false);
      expect(quiescenceState.teamOpLocks.has(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });

      const freshRun = createMixedLiveRun({ teamName, projectPath });
      freshRun.runId = `${cancelledRun.runId}-fresh`;
      freshRun.detectedSessionId = 'lead-session-fresh';
      freshRun.child = { kill: () => undefined };
      trackLiveRun(svc, freshRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
      // The fresh pair is serialized behind cancelled-lane cleanup. Full-suite filesystem pressure
      // can legitimately outlive the short polling default without indicating a stuck handoff.
      await waitForCondition(() => adapter.launchInputs.length === 3, 60_000);
      await waitForCondition(() =>
        freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: freshRun.runId,
        members: {
          bob: {
            alive: true,
            providerId: 'opencode',
            laneKind: 'secondary',
          },
          tom: {
            alive: true,
            providerId: 'opencode',
            laneKind: 'secondary',
          },
        },
      });

      await svc.stopAllTeams();
      expect(svc.getAliveTeams()).toEqual([]);
      expect(quiescenceState.aliveRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.provisioningRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.secondaryRuntimeRunByTeam.has(teamName)).toBe(false);
      expect(quiescenceState.stoppingSecondaryRuntimeTeams.has(teamName)).toBe(false);
      expect(quiescenceState.teamOpLocks.has(teamName)).toBe(false);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    }, 120_000);

    it('stopAllTeams stops in-flight mixed OpenCode secondary lanes for multiple teams', async () => {
      const firstTeamName = 'mixed-opencode-stop-all-inflight-multi-a-safe-e2e';
      const secondTeamName = 'mixed-opencode-stop-all-inflight-multi-b-safe-e2e';
      await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
      await writeTeamMeta(firstTeamName, projectPath);
      await writeMembersMeta(firstTeamName);
      await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
      await writeTeamMeta(secondTeamName, projectPath);
      await writeMembersMeta(secondTeamName);
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake multi shutdown failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = { kill: () => undefined };
      secondRun.child = { kill: () => undefined };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

      svc.stopAllTeams();

      await waitForCondition(() => adapter.stopInputs.length === 2);
      expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
        firstTeamName,
        secondTeamName,
      ]);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:bob',
      ]);
      expect(svc.getAliveTeams()).toEqual([]);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 2);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
      const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
      expect(firstStatuses.teamLaunchState).not.toBe('partial_failure');
      expect(secondStatuses.teamLaunchState).not.toBe('partial_failure');
      expect(firstStatuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(firstStatuses.statuses.tom?.launchState).not.toBe('failed_to_start');
      expect(secondStatuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(secondStatuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('recovers mixed Codex/OpenCode launch truth from persisted state after service restart', async () => {
      const teamName = 'mixed-persisted-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-tom'],
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.providerBackendId).toBe('codex-native');
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        laneKind: 'primary',
        runtimeModel: 'gpt-5.4-mini',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('recovers mixed Anthropic/OpenCode launch truth from persisted state after service restart', async () => {
      const teamName = 'mixed-persisted-anthropic-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('runs an exact Anthropic Codex OpenCode lifecycle through stop relaunch and persisted recovery', async () => {
      const teamName = 'mixed-anthropic-codex-opencode-lifecycle-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
        includeCodexPrimary: true,
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        includeCodexPrimary: true,
      });

      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const mixedLaneHarness = svc as unknown as {
        launchMixedSecondaryLaneIfNeeded(run: unknown): Promise<unknown>;
      };

      const firstRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addCodexPrimaryToMixedRun(firstRun);
      firstRun.runId = `run-${teamName}-first`;
      firstRun.child = Object.assign(new EventEmitter(), {
        pid: 64_901,
        kill: () => undefined,
        stdin: { writable: true },
      });
      trackLiveRun(svc, firstRun);

      await mixedLaneHarness.launchMixedSecondaryLaneIfNeeded(firstRun);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const firstStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(firstStatuses.teamLaunchState).toBe('clean_success');
      expect(firstStatuses.expectedMembers).toEqual(['alice', 'cody', 'bob', 'tom']);
      for (const memberName of ['alice', 'cody', 'bob', 'tom']) {
        expect(firstStatuses.statuses[memberName]).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          hardFailure: false,
        });
      }
      await expect(svc.getTeamAgentRuntimeSnapshot(teamName)).resolves.toMatchObject({
        runId: firstRun.runId,
        members: {
          alice: { providerId: 'anthropic', laneKind: 'primary', runtimeModel: 'haiku' },
          cody: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            laneKind: 'primary',
            runtimeModel: 'gpt-5.4-mini',
          },
          bob: {
            providerId: 'opencode',
            laneKind: 'secondary',
            runtimeModel: 'opencode/minimax-m2.5-free',
          },
          tom: {
            providerId: 'opencode',
            laneKind: 'secondary',
            runtimeModel: 'opencode/nemotron-3-super-free',
          },
        },
      });

      await svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });

      const secondRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addCodexPrimaryToMixedRun(secondRun);
      secondRun.runId = `run-${teamName}-second`;
      secondRun.child = Object.assign(new EventEmitter(), {
        pid: 64_911,
        kill: () => undefined,
        stdin: { writable: true },
      });
      trackLiveRun(svc, secondRun);

      await mixedLaneHarness.launchMixedSecondaryLaneIfNeeded(secondRun);
      await waitForCondition(() => adapter.launchInputs.length === 4);
      await waitForCondition(() =>
        secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const relaunchedStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
      expect(relaunchedStatuses.expectedMembers).toEqual(['alice', 'cody', 'bob', 'tom']);
      for (const memberName of ['alice', 'cody', 'bob', 'tom']) {
        expect(relaunchedStatuses.statuses[memberName]).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          hardFailure: false,
        });
      }

      const restartedService = new TeamProvisioningService();
      const recoveredStatuses = await restartedService.getMemberSpawnStatuses(teamName);
      expect(recoveredStatuses.teamLaunchState).toBe('clean_success');
      expect(recoveredStatuses.expectedMembers).toEqual(['alice', 'cody', 'bob', 'tom']);
      const recoveredSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(recoveredSnapshot.members).toMatchObject({
        alice: { providerId: 'anthropic', laneKind: 'primary', runtimeModel: 'haiku' },
        cody: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          laneKind: 'primary',
          runtimeModel: 'gpt-5.4-mini',
        },
        bob: {
          providerId: 'opencode',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          runtimeModel: 'opencode/minimax-m2.5-free',
        },
        tom: {
          providerId: 'opencode',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          runtimeModel: 'opencode/nemotron-3-super-free',
        },
      });
    });

    it('does not resurrect removed OpenCode secondary teammates in mixed Anthropic launch recovery', async () => {
      const teamName = 'mixed-anthropic-removed-opencode-stale-state-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic', removedMembers: ['tom'] });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'stale removed OpenCode lane failure',
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toBeUndefined();

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toBeUndefined();
    });

    it('keeps active suffixed OpenCode secondary teammates in mixed Anthropic recovery', async () => {
      const teamName = 'mixed-anthropic-suffixed-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob', 'tom'],
        extraMembers: [
          {
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob-2',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses.tom).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toBeUndefined();
      expect(runtimeSnapshot.members.tom).toBeUndefined();
      expect(runtimeSnapshot.members['bob-2']).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
    });

    it('ignores stale active OpenCode lane index entries for removed teammates in mixed Anthropic recovery', async () => {
      const teamName = 'mixed-anthropic-removed-stale-lane-index-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob', 'tom'],
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:tom',
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses.tom).toBeUndefined();

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
      expect(runtimeSnapshot.members.tom).toBeUndefined();
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers pure Anthropic status and model metadata from persisted state after service restart', async () => {
      const teamName = 'pure-persisted-anthropic-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'sonnet',
      });
    });

    it('recovers pure Anthropic partial failure from persisted state after service restart', async () => {
      const teamName = 'pure-persisted-anthropic-failure-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Anthropic pane exited before bootstrap',
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'sonnet',
      });
    });

    it('does not resurrect removed pure Anthropic teammates from stale persisted launch state', async () => {
      const teamName = 'pure-anthropic-removed-member-stale-state-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
      await writePureAnthropicTeamLaunchState({
        teamName,
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'stale removed member failure',
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
    });

    it('keeps active suffixed pure Anthropic teammates when the removed base member is stale', async () => {
      const teamName = 'pure-anthropic-suffixed-active-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, {
        removedMembers: ['bob'],
        extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
      });
      await writePureAnthropicTeamLaunchState({
        teamName,
        expectedMembers: ['alice', 'bob-2'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toBeUndefined();
      expect(runtimeSnapshot.members['bob-2']).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'sonnet',
      });
    });

    it('filters removed pure Anthropic teammates from bootstrap-only launch recovery', async () => {
      const teamName = 'pure-anthropic-removed-bootstrap-state-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
      await writeBootstrapState(teamName, [
        {
          name: 'alice',
          status: 'bootstrap_confirmed',
          lastAttemptAt: Date.parse('2026-04-23T10:00:00.000Z'),
          lastObservedAt: Date.parse('2026-04-23T10:00:05.000Z'),
        },
        {
          name: 'bob',
          status: 'failed',
          lastAttemptAt: Date.parse('2026-04-23T10:00:00.000Z'),
          lastObservedAt: Date.parse('2026-04-23T10:00:04.000Z'),
          failureReason: 'stale removed bootstrap failure',
        },
      ]);

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();
    });

    it('recovers pure Anthropic runtime-pending bootstrap from persisted state after service restart', async () => {
      const teamName = 'pure-persisted-anthropic-bootstrap-pending-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('recovers pure Anthropic runtime-pending permission from persisted state after service restart', async () => {
      const teamName = 'pure-persisted-anthropic-permission-pending-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-bob'],
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        runtimeAlive: false,
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
    });

    it('keeps active pure Anthropic starting teammates pending after service restart', async () => {
      const teamName = 'pure-active-anthropic-starting-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.launchPhase).toBe('active');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        hardFailure: false,
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        alive: false,
        runtimeModel: 'sonnet',
      });
    });

    it('fails finished pure Anthropic starting teammates after service restart', async () => {
      const teamName = 'pure-finished-anthropic-never-spawned-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'finished',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.launchPhase).toBe('finished');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason: 'Teammate was never spawned during launch.',
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        alive: false,
        runtimeModel: 'sonnet',
      });
    });

    it('keeps active pure Anthropic missing member state pending after service restart', async () => {
      const teamName = 'pure-active-anthropic-missing-state-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.launchPhase).toBe('active');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        hardFailure: false,
      });
    });

    it('fails finished pure Anthropic missing member state after service restart', async () => {
      const teamName = 'pure-finished-anthropic-missing-state-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'finished',
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.launchPhase).toBe('finished');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason: 'Teammate was never spawned during launch.',
      });
    });

    it('recovers legacy pure Anthropic partial launch marker without leaving missing teammates joining', async () => {
      const teamName = 'legacy-pure-anthropic-partial-marker-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writeLegacyPartialLaunchState({
        teamName,
        expectedMembers: ['alice', 'bob'],
        confirmedMembers: ['alice'],
        missingMembers: ['bob'],
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.launchPhase).toBe('reconciled');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: true,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Legacy partial launch marker reported teammate missing.',
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        alive: false,
        runtimeModel: 'sonnet',
      });
    });

    it('keeps finished pure Anthropic runtime-pending bootstrap teammates pending after service restart', async () => {
      const teamName = 'pure-finished-anthropic-bootstrap-pending-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'finished',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.launchPhase).toBe('finished');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('keeps finished pure Anthropic runtime-pending permission teammates pending after service restart', async () => {
      const teamName = 'pure-finished-anthropic-permission-pending-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'finished',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-bob'],
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.launchPhase).toBe('finished');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        agentToolAccepted: true,
        runtimeAlive: false,
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
    });

    it('recovers mixed Anthropic and Gemini failure with split OpenCode lane truth after service restart', async () => {
      const teamName = 'mixed-persisted-anthropic-gemini-failure-opencode-split-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          reviewer: mixedMemberState({
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'gemini',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Gemini pane exited before bootstrap',
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('recovers mixed Gemini failure and split OpenCode lane truth after service restart', async () => {
      const teamName = 'mixed-persisted-gemini-failure-opencode-split-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { includeGeminiPrimary: true });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          reviewer: mixedMemberState({
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'gemini',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Gemini pane exited before bootstrap',
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('exposes shared OpenCode side-lane runtime memory in the team runtime snapshot', async () => {
      const teamName = 'mixed-opencode-runtime-memory-safe-e2e';
      const sharedHostPid = 24_242;
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc, [[sharedHostPid, 183.9 * 1024 * 1024]]);

      await waitForCondition(async () => {
        const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        return snapshot.members.bob?.alive === true;
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: 183.9 * 1024 * 1024,
      });
      expect(runtimeSnapshot.members.bob.providerBackendId).toBeUndefined();
    });

    it('keeps OpenCode side-lane pid and memory visible after mixed failure recovery', async () => {
      const teamName = 'mixed-gemini-failure-opencode-memory-safe-e2e';
      const sharedHostPid = 31_313;
      const sharedRssBytes = 211.4 * 1024 * 1024;
      await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { includeGeminiPrimary: true });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          reviewer: mixedMemberState({
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'gemini',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Gemini pane exited before bootstrap',
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
          [
            'tom',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/nemotron-3-super-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc, [[sharedHostPid, sharedRssBytes]]);

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: sharedRssBytes,
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        alive: false,
        livenessKind: 'permission_blocked',
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/nemotron-3-super-free',
        rssBytes: sharedRssBytes,
      });
    });

    it('keeps OpenCode side-lane pid and memory visible after Anthropic mixed recovery', async () => {
      const teamName = 'mixed-anthropic-opencode-memory-safe-e2e';
      const sharedHostPid = 41_414;
      const sharedRssBytes = 207.6 * 1024 * 1024;
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
          [
            'tom',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/nemotron-3-super-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc, [[sharedHostPid, sharedRssBytes]]);

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: sharedRssBytes,
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        alive: false,
        livenessKind: 'permission_blocked',
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/nemotron-3-super-free',
        rssBytes: sharedRssBytes,
      });
    });

    it('keeps OpenCode side-lane pid and memory visible after Anthropic and Gemini mixed failure recovery', async () => {
      const teamName = 'mixed-anthropic-gemini-failure-opencode-memory-safe-e2e';
      const sharedHostPid = 51_515;
      const sharedRssBytes = 219.2 * 1024 * 1024;
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          reviewer: mixedMemberState({
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'gemini',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Gemini pane exited before bootstrap',
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['perm-tom'],
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
          [
            'tom',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/nemotron-3-super-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc, [[sharedHostPid, sharedRssBytes]]);

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: sharedRssBytes,
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        alive: false,
        livenessKind: 'permission_blocked',
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/nemotron-3-super-free',
        rssBytes: sharedRssBytes,
      });
    });

    it('infers OpenCode runtime provider from model after restart when provider metadata is missing', async () => {
      const teamName = 'mixed-opencode-model-inference-safe-e2e';
      const sharedHostPid = 24_243;
      await writeMixedTeamConfigWithoutOpenCodeProviderMetadata({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const restartedService = new TeamProvisioningService();
      (restartedService as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(restartedService, [[sharedHostPid, 188.4 * 1024 * 1024]]);

      const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: 188.4 * 1024 * 1024,
      });
      expect(runtimeSnapshot.members.bob.providerBackendId).toBeUndefined();
    });

    it('clears stale never-spawned OpenCode side-lane failures when live runtime metadata proves the member is alive', async () => {
      const teamName = 'mixed-opencode-stale-failure-clears-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              model: 'opencode/minimax-m2.5-free',
              livenessKind: 'runtime_process',
            },
          ],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        hardFailure: false,
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(statuses.statuses.bob.hardFailureReason).toBeUndefined();
      expect(statuses.statuses.bob.error).toBeUndefined();
    });

    it('promotes starting OpenCode side-lane members to runtime-pending when live metadata sees the process', async () => {
      const teamName = 'mixed-opencode-starting-promotes-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              model: 'opencode/minimax-m2.5-free',
              livenessKind: 'runtime_process',
            },
          ],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        livenessSource: 'process',
        hardFailure: false,
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
    });

    it('does not clear definitive OpenCode side-lane failures from unrelated live runtime metadata', async () => {
      const teamName = 'mixed-opencode-definitive-failure-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'OpenCode raw model id "minimax-m2.5-free" was not found.',
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        failedCount: 1,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        hardFailure: true,
        hardFailureReason: 'OpenCode raw model id "minimax-m2.5-free" was not found.',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
    });

    it('runs mixed live secondary OpenCode lanes and preserves primary Codex status', async () => {
      const teamName = 'mixed-live-lanes-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'permission',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      stubLiveOpenCodeRuntimeProcessesForTest(svc, teamName, ['bob']);
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(initialSnapshot).toMatchObject({
        teamName,
        launchPhase: 'active',
        teamLaunchState: 'partial_pending',
      });
      expect(initialSnapshot.members.alice).toMatchObject({
        providerId: 'codex',
        laneKind: 'primary',
        launchState: 'confirmed_alive',
      });
      expect(initialSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        launchState: 'starting',
      });

      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission'
      );

      expect(adapter.launchInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(adapter.launchInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            laneId: 'secondary:opencode:bob',
            model: 'opencode/minimax-m2.5-free',
            expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
          }),
          expect.objectContaining({
            laneId: 'secondary:opencode:tom',
            model: 'opencode/nemotron-3-super-free',
            expectedMembers: [expect.objectContaining({ name: 'tom', providerId: 'opencode' })],
          }),
        ])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        runtimeAlive: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        alive: true,
        providerId: 'codex',
        laneKind: 'primary',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        alive: true,
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        alive: false,
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
      });
    });

    it('waits for mixed OpenCode secondary lane completion during final launch reporting', async () => {
      const teamName = 'mixed-final-reporting-waits-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      let settled = false;
      const completion = (
        svc as unknown as {
          launchMixedSecondaryLaneIfNeeded(
            targetRun: typeof run,
            options: { waitForCompletion: true }
          ): Promise<unknown | null>;
        }
      )
        .launchMixedSecondaryLaneIfNeeded(run, { waitForCompletion: true })
        .finally(() => {
          settled = true;
        });

      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'launching',
        'queued',
      ]);

      adapter.releaseLaunches();
      const snapshot = await completion;

      expect(adapter.launchInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(snapshot).toBeNull();

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.tom).toMatchObject({
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      });
    });

    it('marks a finished OpenCode secondary lane without runtime evidence as retryable failure', async () => {
      const teamName = 'mixed-missing-opencode-evidence-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const svc = new TeamProvisioningService();
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const lane = run.mixedSecondaryLanes.find(
        (candidate: { member: { name: string } }) => candidate.member.name === 'bob'
      );
      expect(lane).toBeTruthy();
      lane.state = 'finished';
      lane.result = null;
      lane.diagnostics = ['synthetic OpenCode launch handoff ended before evidence commit'];

      const snapshot = await (
        svc as unknown as {
          persistLaunchStateSnapshot(
            targetRun: typeof run,
            phase: 'finished'
          ): Promise<PersistedLaunchSnapshotForTest>;
        }
      ).persistLaunchStateSnapshot(run, 'finished');

      expect(snapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'opencode_runtime_evidence_missing',
        runtimeDiagnostic: 'OpenCode secondary lane finished without committed runtime evidence.',
      });
      expect(snapshot.summary).toMatchObject({
        failedCount: 1,
      });
    });

    it('keeps mixed launch pending while Codex primary is still joining and OpenCode lanes are ready', async () => {
      const teamName = 'mixed-codex-starting-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'starting',
        launchState: 'starting',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
    });

    it('keeps Anthropic mixed launch pending while primary is still joining and OpenCode lanes are ready', async () => {
      const teamName = 'mixed-anthropic-starting-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'starting',
        launchState: 'starting',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
    });

    it('keeps Anthropic mixed launch pending while primary awaits permission and OpenCode lanes are ready', async () => {
      const teamName = 'mixed-anthropic-permission-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'online',
        launchState: 'runtime_pending_permission',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-alice'],
        lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        pendingPermissionRequestIds: ['perm-alice'],
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      });
    });

    it('keeps Anthropic primary online while mixed OpenCode lanes split ready and bootstrap pending', async () => {
      const teamName = 'mixed-anthropic-opencode-split-bootstrap-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'launching',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      stubLiveOpenCodeRuntimeProcessesForTest(svc, teamName, ['bob']);
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        alive: true,
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        alive: false,
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('keeps mixed Anthropic launch partial when Gemini primary fails and OpenCode lanes split ready and bootstrap pending', async () => {
      const teamName = 'mixed-anthropic-gemini-failed-opencode-split-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'launching',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      stubLiveOpenCodeRuntimeProcessesForTest(svc, teamName, ['bob']);
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const reviewer = {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      };
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [...run.effectiveMembers, reviewer];
      run.allEffectiveMembers = [
        ...run.effectiveMembers,
        ...run.allEffectiveMembers.filter(
          (member: { providerId?: string }) => member.providerId === 'opencode'
        ),
      ];
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        alive: true,
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneKind: 'secondary',
        alive: false,
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('keeps OpenCode side-lane pid and memory visible during mixed Anthropic launch when Gemini failed and a sibling lane is still bootstrapping', async () => {
      const teamName = 'mixed-anthropic-gemini-bootstrap-memory-safe-e2e';
      const sharedHostPid = 52_525;
      const sharedRssBytes = 221.7 * 1024 * 1024;
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'launching',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const reviewer = {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      };
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [...run.effectiveMembers, reviewer];
      run.allEffectiveMembers = [
        ...run.effectiveMembers,
        ...run.allEffectiveMembers.filter(
          (member: { providerId?: string }) => member.providerId === 'opencode'
        ),
      ];
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
      );

      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
          [
            'tom',
            {
              alive: true,
              metricsPid: sharedHostPid,
              model: 'opencode/nemotron-3-super-free',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc, [[sharedHostPid, sharedRssBytes]]);

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'gemini-2.5-flash',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/minimax-m2.5-free',
        rssBytes: sharedRssBytes,
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        alive: true,
        restartable: false,
        pid: sharedHostPid,
        runtimeModel: 'opencode/nemotron-3-super-free',
        rssBytes: sharedRssBytes,
      });
    });

    it('keeps mixed launch partial when Gemini primary fails and OpenCode lanes split ready and pending', async () => {
      const teamName = 'mixed-gemini-failed-opencode-split-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'permission',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      const reviewer = {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      };
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [...run.effectiveMembers, reviewer];
      run.allEffectiveMembers = [
        ...run.effectiveMembers,
        ...run.allEffectiveMembers.filter(
          (member: { providerId?: string }) => member.providerId === 'opencode'
        ),
      ];
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane exited before bootstrap',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });
    });

    it('keeps Codex primary online when a mixed OpenCode secondary lane fails', async () => {
      const teamName = 'mixed-live-secondary-failure-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'failed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'fake_open_code_launch_failure',
      });
    });

    it('keeps Anthropic primary online when a mixed OpenCode secondary lane fails', async () => {
      const teamName = 'mixed-anthropic-secondary-failure-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'failed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'fake_open_code_launch_failure',
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'haiku',
      });
    });

    it('does not expose removed OpenCode secondary teammates from live mixed Anthropic launch status', async () => {
      const teamName = 'mixed-anthropic-live-removed-secondary-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      removeMixedOpenCodeLaneForTest(run, 'bob');
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      expect(
        adapter.launchInputs.map((input) => input.expectedMembers.map((member) => member.name))
      ).toEqual([['tom']]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
    });

    it('does not re-add removed OpenCode secondary teammates from stale live runtime metadata in mixed Anthropic status', async () => {
      const teamName = 'mixed-anthropic-stale-live-metadata-removed-secondary-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              metricsPid: 44_001,
              model: 'opencode/minimax-m2.5-free',
            },
          ],
          [
            'tom',
            {
              alive: true,
              metricsPid: 44_002,
              model: 'opencode/nemotron-3-super-free',
            },
          ],
        ]);
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      removeMixedOpenCodeLaneForTest(run, 'bob');
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 1);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      expect(
        adapter.launchInputs.map((input) => input.expectedMembers.map((member) => member.name))
      ).toEqual([['tom']]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
    });

    it('does not expose removed pure Anthropic teammates from live launch status', async () => {
      const teamName = 'pure-anthropic-live-removed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
    });

    it('does not re-add removed pure Anthropic teammates from stale live runtime metadata', async () => {
      const teamName = 'pure-anthropic-stale-live-metadata-removed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              model: 'haiku',
            },
          ],
          [
            'bob',
            {
              alive: true,
              model: 'sonnet',
            },
          ],
        ]);
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toBeUndefined();
    });

    it('does not map stale base Anthropic runtime metadata onto an active suffixed Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-stale-base-runtime-suffixed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, {
        removedMembers: ['bob'],
        extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
      });
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob-2'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku' }],
          ['bob', { alive: true, model: 'sonnet' }],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        runtimeAlive: false,
        hardFailure: false,
      });
    });

    it('does not map stale base OpenCode runtime metadata onto an active suffixed teammate in mixed Anthropic recovery', async () => {
      const teamName = 'mixed-anthropic-stale-base-runtime-suffixed-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
        extraMembers: [
          {
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob-2',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku' }],
          ['bob', { alive: true, model: 'opencode/minimax-m2.5-free' }],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        runtimeAlive: false,
        hardFailure: false,
      });
    });

    it('maps suffixed Anthropic runtime metadata onto the canonical pure Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-suffixed-runtime-canonical-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
          ['bob-2', { alive: true, model: 'sonnet', livenessKind: 'runtime_process' }],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        hardFailure: false,
        livenessSource: 'process',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'anthropic',
        alive: true,
        runtimeModel: 'sonnet',
      });
      expect(runtimeSnapshot.members['bob-2']).toBeUndefined();
    });

    it('maps suffixed OpenCode runtime metadata onto the canonical mixed Anthropic teammate', async () => {
      const teamName = 'mixed-anthropic-suffixed-runtime-canonical-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
          [
            'bob-2',
            {
              alive: true,
              model: 'opencode/minimax-m2.5-free',
              livenessKind: 'runtime_process',
            },
          ],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        hardFailure: false,
        livenessSource: 'process',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        alive: true,
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members['bob-2']).toBeUndefined();
    });

    it('maps suffixed lead inbox heartbeat onto the canonical pure Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-suffixed-heartbeat-canonical-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-bob-2-heartbeat',
        },
      ]);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.memberSpawnStatuses.set('bob', {
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      trackLiveRun(svc, run);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        livenessSource: 'heartbeat',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('does not map stale base lead inbox heartbeat onto an active suffixed pure Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-stale-base-heartbeat-suffixed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, {
        removedMembers: ['bob'],
        extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
      });
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob-2'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob',
          text: 'heartbeat',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-stale-bob-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('maps suffixed lead inbox heartbeat onto the canonical mixed Anthropic OpenCode teammate', async () => {
      const teamName = 'mixed-anthropic-suffixed-heartbeat-canonical-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-mixed-bob-2-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.lastHeartbeatAt).toBeUndefined();
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('does not map stale base lead inbox heartbeat onto an active suffixed mixed Anthropic teammate', async () => {
      const teamName = 'mixed-anthropic-stale-base-heartbeat-suffixed-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
        extraMembers: [
          {
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob-2',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob',
          text: 'heartbeat',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-mixed-stale-bob-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('maps suffixed lead inbox bootstrap failure onto the canonical pure Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-suffixed-failure-canonical-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-bob-2-bootstrap-failed',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('does not map stale base lead inbox bootstrap failure onto an active suffixed pure Anthropic teammate', async () => {
      const teamName = 'pure-anthropic-stale-base-failure-suffixed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, {
        removedMembers: ['bob'],
        extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
      });
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob-2'],
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob',
          text: 'Bootstrap failed: unsupported model',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-stale-bob-bootstrap-failed',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('maps suffixed lead inbox bootstrap failure onto the canonical mixed Anthropic OpenCode teammate', async () => {
      const teamName = 'mixed-anthropic-suffixed-failure-canonical-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-mixed-bob-2-bootstrap-failed',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('does not map stale base lead inbox bootstrap failure onto an active suffixed mixed Anthropic teammate', async () => {
      const teamName = 'mixed-anthropic-stale-base-failure-suffixed-opencode-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
        extraMembers: [
          {
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      });
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          'bob-2': mixedMemberState({
            name: 'bob-2',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob-2',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob',
          text: 'Bootstrap failed: unsupported model',
          timestamp: '2026-04-23T10:00:10.000Z',
          messageId: 'msg-mixed-stale-bob-bootstrap-failed',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses['bob-2']).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('ignores stale suffixed lead inbox heartbeat from an older pure Anthropic launch attempt', async () => {
      const teamName = 'pure-anthropic-old-suffixed-heartbeat-current-attempt-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
      const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: staleMessageAt,
          messageId: 'msg-old-bob-2-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('ignores stale suffixed lead inbox bootstrap failure from an older pure Anthropic launch attempt', async () => {
      const teamName = 'pure-anthropic-old-suffixed-failure-current-attempt-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
      const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: staleMessageAt,
          messageId: 'msg-old-bob-2-bootstrap-failed',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('ignores stale suffixed lead inbox heartbeat from an older mixed Anthropic OpenCode launch attempt', async () => {
      const teamName = 'mixed-anthropic-old-suffixed-heartbeat-current-opencode-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
      const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: staleMessageAt,
          messageId: 'msg-mixed-old-bob-2-heartbeat',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('ignores stale suffixed lead inbox bootstrap failure from an older mixed Anthropic OpenCode launch attempt', async () => {
      const teamName = 'mixed-anthropic-old-suffixed-failure-current-opencode-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
      const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: staleMessageAt,
          messageId: 'msg-mixed-old-bob-2-bootstrap-failed',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses newer suffixed heartbeat over older pure Anthropic bootstrap failure during persisted reconcile', async () => {
      const teamName = 'pure-anthropic-newer-heartbeat-over-old-failure-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
      const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
      const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: olderSignalAt,
          messageId: 'msg-old-failure-before-heartbeat',
        },
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: newerSignalAt,
          messageId: 'msg-new-heartbeat-after-failure',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: newerSignalAt,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses newer suffixed bootstrap failure over older pure Anthropic heartbeat during persisted reconcile', async () => {
      const teamName = 'pure-anthropic-newer-failure-over-old-heartbeat-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
      const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
      const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: olderSignalAt,
          messageId: 'msg-old-heartbeat-before-failure',
        },
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: newerSignalAt,
          messageId: 'msg-new-failure-after-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses newer suffixed heartbeat over older mixed Anthropic OpenCode bootstrap failure during persisted reconcile', async () => {
      const teamName = 'mixed-anthropic-newer-heartbeat-over-old-failure-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
      const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
      const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: olderSignalAt,
          messageId: 'msg-mixed-old-failure-before-heartbeat',
        },
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: newerSignalAt,
          messageId: 'msg-mixed-new-heartbeat-after-failure',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.lastHeartbeatAt).toBeUndefined();
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses newer suffixed bootstrap failure over older mixed Anthropic OpenCode heartbeat during persisted reconcile', async () => {
      const teamName = 'mixed-anthropic-newer-failure-over-old-heartbeat-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
      const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
      const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: olderSignalAt,
          messageId: 'msg-mixed-old-heartbeat-before-failure',
        },
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: newerSignalAt,
          messageId: 'msg-mixed-new-failure-after-heartbeat',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses greater same-timestamp heartbeat messageId over pure Anthropic bootstrap failure during persisted reconcile', async () => {
      const teamName = 'pure-anthropic-same-time-heartbeat-wins-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
      const signalAt = new Date(Date.now() - 1_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: signalAt,
          messageId: 'msg-001-same-time-failure',
        },
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: signalAt,
          messageId: 'msg-002-same-time-heartbeat',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: signalAt,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses greater same-timestamp bootstrap failure messageId over pure Anthropic heartbeat during persisted reconcile', async () => {
      const teamName = 'pure-anthropic-same-time-failure-wins-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
      const signalAt = new Date(Date.now() - 1_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: signalAt,
          messageId: 'msg-001-same-time-heartbeat',
        },
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: signalAt,
          messageId: 'msg-002-same-time-failure',
        },
      ]);

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses greater same-timestamp heartbeat messageId over mixed Anthropic OpenCode bootstrap failure during persisted reconcile', async () => {
      const teamName = 'mixed-anthropic-same-time-heartbeat-wins-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
      const signalAt = new Date(Date.now() - 1_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: signalAt,
          messageId: 'msg-mixed-001-same-time-failure',
        },
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: signalAt,
          messageId: 'msg-mixed-002-same-time-heartbeat',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.lastHeartbeatAt).toBeUndefined();
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('uses greater same-timestamp bootstrap failure messageId over mixed Anthropic OpenCode heartbeat during persisted reconcile', async () => {
      const teamName = 'mixed-anthropic-same-time-failure-wins-safe-e2e';
      const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
      const signalAt = new Date(Date.now() - 1_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt,
          }),
        },
      });
      await writeLeadInboxMessages(teamName, [
        {
          from: 'bob-2',
          text: 'heartbeat',
          timestamp: signalAt,
          messageId: 'msg-mixed-001-same-time-heartbeat',
        },
        {
          from: 'bob-2',
          text: 'Bootstrap failed: unsupported model',
          timestamp: signalAt,
          messageId: 'msg-mixed-002-same-time-failure',
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(
        new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('clears false never-spawned pure Anthropic failure when live runtime proves the teammate exists', async () => {
      const teamName = 'pure-anthropic-never-spawned-live-runtime-recovered-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
          ['bob-2', { alive: true, model: 'sonnet', livenessKind: 'runtime_process' }],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        livenessSource: 'process',
        runtimeModel: 'sonnet',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('does not clear explicit pure Anthropic bootstrap failure just because runtime metadata is alive', async () => {
      const teamName = 'pure-anthropic-hard-failure-live-runtime-not-cleared-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Bootstrap failed: unsupported model',
            firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, model: 'haiku' }],
          ['bob-2', { alive: true, model: 'sonnet' }],
        ]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
        runtimeModel: 'sonnet',
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('clears false never-spawned Anthropic primary failure in mixed launch when live runtime is alive', async () => {
      const teamName = 'mixed-anthropic-never-spawned-primary-live-runtime-recovered-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([['alice', { alive: true, model: 'haiku', livenessKind: 'runtime_process' }]]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 1,
        failedCount: 0,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        livenessSource: 'process',
        runtimeModel: 'haiku',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('does not clear explicit Anthropic primary bootstrap failure in mixed launch when runtime metadata is alive', async () => {
      const teamName = 'mixed-anthropic-hard-primary-failure-live-runtime-not-cleared-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'Bootstrap failed: unsupported model',
            firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([['alice', { alive: true, model: 'haiku' }]]);

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        pendingCount: 0,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Bootstrap failed: unsupported model',
        runtimeModel: 'haiku',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('confirms pure Anthropic teammate bootstrap from member transcript when inbox and runtime are silent', async () => {
      const teamName = 'pure-anthropic-transcript-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-transcript-success',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'bob',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "bob".`,
            },
          },
          {
            timestamp: successAt,
            teamName,
            agentName: 'bob',
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'member-briefing-bob',
                  content: `Member briefing for bob on team "${teamName}" (${teamName}).\nTask briefing for bob:\nNo actionable tasks.`,
                  is_error: false,
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
      });
    });

    it('fails pure Anthropic teammate bootstrap from member transcript API error when inbox is silent', async () => {
      const teamName = 'pure-anthropic-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const errorAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-transcript-failure',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'bob',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "bob".`,
            },
          },
          {
            timestamp: errorAt,
            teamName,
            agentName: 'bob',
            type: 'assistant',
            isApiErrorMessage: true,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('confirms Anthropic primary bootstrap from transcript in mixed launch without changing OpenCode teammates', async () => {
      const teamName = 'mixed-anthropic-transcript-primary-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'alice-transcript-success',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'alice',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "alice".`,
            },
          },
          {
            timestamp: successAt,
            teamName,
            agentName: 'alice',
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('fails Anthropic primary bootstrap from transcript in mixed launch without degrading OpenCode teammates', async () => {
      const teamName = 'mixed-anthropic-transcript-primary-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const errorAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'alice-transcript-failure',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'alice',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "alice".`,
            },
          },
          {
            timestamp: errorAt,
            teamName,
            agentName: 'alice',
            type: 'assistant',
            isApiErrorMessage: true,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('confirms pure Anthropic teammate bootstrap from suffixed member transcript agentName', async () => {
      const teamName = 'pure-anthropic-suffixed-transcript-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-2-transcript-success',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'bob-2',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "bob".`,
            },
          },
          {
            timestamp: successAt,
            teamName,
            agentName: 'bob-2',
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `Member briefing for bob on team "${teamName}" (${teamName}).\nTask briefing for bob:\nNo actionable tasks.`,
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('fails pure Anthropic teammate bootstrap from suffixed member transcript API error', async () => {
      const teamName = 'pure-anthropic-suffixed-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const errorAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-2-transcript-failure',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'bob-2',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "bob".`,
            },
          },
          {
            timestamp: errorAt,
            teamName,
            agentName: 'bob-2',
            type: 'assistant',
            isApiErrorMessage: true,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses['bob-2']).toBeUndefined();
    });

    it('confirms suffixed Anthropic primary transcript agentName in mixed launch without changing OpenCode teammates', async () => {
      const teamName = 'mixed-anthropic-suffixed-transcript-primary-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'alice-2-transcript-success',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'alice-2',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "alice".`,
            },
          },
          {
            timestamp: successAt,
            teamName,
            agentName: 'alice-2',
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('fails suffixed Anthropic primary transcript agentName in mixed launch without degrading OpenCode teammates', async () => {
      const teamName = 'mixed-anthropic-suffixed-transcript-primary-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 5_000).toISOString();
      const errorAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'alice-2-transcript-failure',
        records: [
          {
            timestamp: acceptedAt,
            teamName,
            agentName: 'alice-2',
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "alice".`,
            },
          },
          {
            timestamp: errorAt,
            teamName,
            agentName: 'alice-2',
            type: 'assistant',
            isApiErrorMessage: true,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
                },
              ],
            },
          },
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('uses newer pure Anthropic transcript success over older lexically-later transcript failure', async () => {
      const teamName = 'pure-anthropic-newer-transcript-success-wins-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const olderAt = new Date(Date.now() - 5_000).toISOString();
      const newerAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'zz-old-bob-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapFailureTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'bob' }),
        ],
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'aa-new-bob-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapSuccessTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'bob' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: newerAt,
      });
    });

    it('uses newer pure Anthropic transcript failure over older lexically-later transcript success', async () => {
      const teamName = 'pure-anthropic-newer-transcript-failure-wins-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const olderAt = new Date(Date.now() - 5_000).toISOString();
      const newerAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'zz-old-bob-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapSuccessTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'bob' }),
        ],
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'aa-new-bob-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapFailureTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'bob' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('uses newer mixed Anthropic primary transcript success over older lexically-later failure', async () => {
      const teamName = 'mixed-anthropic-newer-transcript-success-wins-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const olderAt = new Date(Date.now() - 5_000).toISOString();
      const newerAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'zz-old-alice-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
          bootstrapFailureTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'alice' }),
        ],
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'aa-new-alice-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
          bootstrapSuccessTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'alice' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: newerAt,
      });
    });

    it('uses newer mixed Anthropic primary transcript failure over older lexically-later success', async () => {
      const teamName = 'mixed-anthropic-newer-transcript-failure-wins-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const olderAt = new Date(Date.now() - 5_000).toISOString();
      const newerAt = new Date(Date.now() - 4_000).toISOString();
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      await writeMixedTeamLaunchState({
        teamName,
        updatedAt: '2026-04-23T10:00:00.000Z',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          tom: mixedMemberState({
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'zz-old-alice-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
          bootstrapSuccessTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'alice' }),
        ],
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'aa-new-alice-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
          bootstrapFailureTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'alice' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('falls back to project-root Anthropic transcript success when member log discovery fails', async () => {
      const teamName = 'pure-anthropic-project-root-transcript-success-fallback-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-project-root-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapSuccessTranscriptRecord({ timestamp: successAt, teamName, memberName: 'bob' }),
        ],
      });
      const svc = new TeamProvisioningService();
      (svc as any).memberLogsFinder = {
        findMemberLogs: async () => {
          throw new Error('fake member log discovery failure');
        },
      };

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
    });

    it('falls back to project-root Anthropic transcript failure when member log discovery fails', async () => {
      const teamName = 'pure-anthropic-project-root-transcript-failure-fallback-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const failureAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-project-root-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
          bootstrapFailureTranscriptRecord({ timestamp: failureAt, teamName, memberName: 'bob' }),
        ],
      });
      const svc = new TeamProvisioningService();
      (svc as any).memberLogsFinder = {
        findMemberLogs: async () => {
          throw new Error('fake member log discovery failure');
        },
      };

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('ignores malformed Anthropic transcript lines and recovers bootstrap success', async () => {
      const teamName = 'pure-anthropic-malformed-transcript-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const successAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeRawMemberTranscript({
        projectPath,
        sessionId: 'bob-malformed-success',
        lines: [
          JSON.stringify(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
          ),
          '{"timestamp": "not complete"',
          JSON.stringify(
            bootstrapSuccessTranscriptRecord({ timestamp: successAt, teamName, memberName: 'bob' })
          ),
          'warning: claude cli emitted a non-json trailer',
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: successAt,
      });
    });

    it('ignores malformed Anthropic transcript lines and recovers bootstrap failure', async () => {
      const teamName = 'pure-anthropic-malformed-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 6_000).toISOString();
      const failureAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      await writePureAnthropicTeamLaunchState({
        teamName,
        launchPhase: 'active',
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            firstSpawnAcceptedAt: acceptedAt,
          }),
        },
      });
      await writeRawMemberTranscript({
        projectPath,
        sessionId: 'bob-malformed-failure',
        lines: [
          JSON.stringify(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
          ),
          'partial-json-line {',
          JSON.stringify(
            bootstrapFailureTranscriptRecord({ timestamp: failureAt, teamName, memberName: 'bob' })
          ),
          'non-json stderr trailer',
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('ignores stale Anthropic transcript success from before the current spawn attempt', async () => {
      const teamName = 'pure-anthropic-stale-transcript-success-safe-e2e';
      const staleAt = new Date(Date.now() - 8_000).toISOString();
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-stale-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
          bootstrapSuccessTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('ignores stale Anthropic transcript failure from before the current spawn attempt', async () => {
      const teamName = 'pure-anthropic-stale-transcript-failure-safe-e2e';
      const staleAt = new Date(Date.now() - 8_000).toISOString();
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-stale-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
          bootstrapFailureTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('ignores invalid-timestamp Anthropic transcript success when filtering a current spawn attempt', async () => {
      const teamName = 'pure-anthropic-invalid-timestamp-success-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-invalid-timestamp-success',
        records: [
          bootstrapTranscriptRecord({ timestamp: 'not-a-date', teamName, memberName: 'bob' }),
          bootstrapSuccessTranscriptRecord({
            timestamp: 'not-a-date',
            teamName,
            memberName: 'bob',
          }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('ignores invalid-timestamp Anthropic transcript failure when filtering a current spawn attempt', async () => {
      const teamName = 'pure-anthropic-invalid-timestamp-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-invalid-timestamp-failure',
        records: [
          bootstrapTranscriptRecord({ timestamp: 'not-a-date', teamName, memberName: 'bob' }),
          bootstrapFailureTranscriptRecord({
            timestamp: 'not-a-date',
            teamName,
            memberName: 'bob',
          }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('ignores unrelated no-agentName Anthropic transcript failure in the same project root', async () => {
      const teamName = 'pure-anthropic-unrelated-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'unrelated-no-agent-failure',
        records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('accepts no-agentName Anthropic transcript failure when the file has matching bootstrap context', async () => {
      const teamName = 'pure-anthropic-contextual-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'bob-contextual-no-agent-failure',
        records: [
          withoutAgentName(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
          ),
          genericTranscriptApiErrorRecord({ timestamp: errorAt }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('ignores unrelated no-agentName Anthropic primary transcript failure in mixed launch', async () => {
      const teamName = 'mixed-anthropic-unrelated-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'mixed-unrelated-no-agent-failure',
        records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('accepts no-agentName Anthropic primary transcript failure in mixed launch with matching context', async () => {
      const teamName = 'mixed-anthropic-contextual-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'mixed-alice-contextual-no-agent-failure',
        records: [
          withoutAgentName(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' })
          ),
          genericTranscriptApiErrorRecord({ timestamp: errorAt }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('accepts attributed pure Anthropic no-agentName transcript failure without bootstrap context', async () => {
      const teamName = 'pure-anthropic-attributed-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      const sessionId = 'bob-attributed-no-agent-failure';
      await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId,
        records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
      });
      const svc = new TeamProvisioningService();
      (svc as any).memberLogsFinder = {
        findMemberLogs: async () => [
          {
            filePath: getMemberTranscriptPath(projectPath, sessionId),
          },
        ],
      };

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('accepts attributed mixed Anthropic no-agentName transcript failure without degrading OpenCode teammates', async () => {
      const teamName = 'mixed-anthropic-attributed-no-agent-transcript-failure-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      const sessionId = 'alice-attributed-no-agent-failure';
      await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId,
        records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
      });
      const svc = new TeamProvisioningService();
      (svc as any).memberLogsFinder = {
        findMemberLogs: async () => [
          {
            filePath: getMemberTranscriptPath(projectPath, sessionId),
          },
        ],
      };

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('maps shared pure Anthropic transcript outcomes to the matching agentName only', async () => {
      const teamName = 'pure-anthropic-shared-transcript-agent-attribution-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const aliceSuccessAt = new Date(Date.now() - 2_500).toISOString();
      const bobFailureAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicPendingMembersFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'shared-agent-attributed-outcomes',
        records: [
          bootstrapTranscriptRecord({
            timestamp: acceptedAt,
            teamName,
            memberName: 'alice',
            agentName: 'alice',
          }),
          bootstrapSuccessTranscriptRecord({
            timestamp: aliceSuccessAt,
            teamName,
            memberName: 'alice',
            agentName: 'alice',
          }),
          bootstrapTranscriptRecord({
            timestamp: acceptedAt,
            teamName,
            memberName: 'bob',
            agentName: 'bob',
          }),
          bootstrapFailureTranscriptRecord({
            timestamp: bobFailureAt,
            teamName,
            memberName: 'bob',
            agentName: 'bob',
          }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: aliceSuccessAt,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
      });
      expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    });

    it('does not apply one anonymous shared Anthropic transcript failure to multiple pending members', async () => {
      const teamName = 'pure-anthropic-shared-anonymous-failure-ambiguous-safe-e2e';
      const acceptedAt = new Date(Date.now() - 4_000).toISOString();
      const errorAt = new Date(Date.now() - 2_000).toISOString();
      await writePureAnthropicPendingMembersFixture({ teamName, projectPath, acceptedAt });
      await writeMemberTranscript({
        projectPath,
        sessionId: 'shared-ambiguous-anonymous-failure',
        records: [
          withoutAgentName(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' })
          ),
          withoutAgentName(
            bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
          ),
          genericTranscriptApiErrorRecord({ timestamp: errorAt }),
        ],
      });

      const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
        hardFailure: false,
      });
    });

    it('marks an Agent tool call without team_name as an ephemeral spawn failure', async () => {
      const teamName = 'agent-missing-team-name-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'waiting',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      (svc as any).captureTeamSpawnEvents(run, [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-bob-missing-team',
          input: { name: 'bob' },
        },
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('missing team_name')
      );
      (console.warn as unknown as { mockClear: () => void }).mockClear();

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: expect.stringContaining('missing team_name'),
      });
      expect(run.memberSpawnToolUseIds.has('tool-bob-missing-team')).toBe(false);
    });

    it('ignores an Agent tool call routed to a different team during launch capture', async () => {
      const teamName = 'agent-wrong-team-capture-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'waiting',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      (svc as any).captureTeamSpawnEvents(run, [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-bob-other-team',
          input: { team_name: 'other-team', name: 'bob' },
        },
      ]);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'starting',
        agentToolAccepted: false,
        hardFailure: false,
      });
      expect(run.memberSpawnToolUseIds.has('tool-bob-other-team')).toBe(false);
    });

    it('marks a valid Agent tool call for this team as spawning and advances to members joining', async () => {
      const teamName = 'agent-valid-spawn-capture-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      const progressEvents: TeamProvisioningProgress[] = [];
      run.progress = {
        ...run.progress,
        state: 'configuring',
        message: 'Preparing launch',
      };
      run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'waiting',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      (svc as any).captureTeamSpawnEvents(run, [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-bob-valid-spawn',
          input: { team_name: teamName, name: 'bob' },
        },
      ]);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(run.memberSpawnToolUseIds.get('tool-bob-valid-spawn')).toBe('bob');
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'assembling',
        message: 'Spawning member bob...',
      });
    });

    it('does not reset an online teammate when a duplicate Agent tool call is captured', async () => {
      const teamName = 'agent-duplicate-online-capture-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      const progressEvents: TeamProvisioningProgress[] = [];
      run.progress = {
        ...run.progress,
        state: 'configuring',
        message: 'Preparing launch',
      };
      run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
      const before = run.memberSpawnStatuses.get('alice');

      (svc as any).captureTeamSpawnEvents(run, [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-alice-duplicate-spawn',
          input: { team_name: teamName, name: 'alice' },
        },
      ]);

      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: before.status,
        launchState: before.launchState,
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      });
      expect(run.memberSpawnToolUseIds.has('tool-alice-duplicate-spawn')).toBe(false);
      expect(run.provisioningOutputParts.join('\n')).toContain(
        'respawn blocked as duplicate - teammate already online'
      );
      expect(progressEvents).toEqual([]);
    });

    it('ignores an Agent tool call without name instead of creating a phantom teammate', async () => {
      const teamName = 'agent-missing-name-capture-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];

      (svc as any).captureTeamSpawnEvents(run, [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-missing-name',
          input: { team_name: teamName },
        },
      ]);

      expect(console.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('missing name')
      );
      (console.warn as unknown as { mockClear: () => void }).mockClear();

      expect(run.memberSpawnStatuses.has('')).toBe(false);
      expect(run.memberSpawnStatuses.has('undefined')).toBe(false);
      expect(run.memberSpawnToolUseIds.has('tool-missing-name')).toBe(false);
    });

    it('moves a spawned teammate to bootstrap-pending when Agent tool result is accepted', async () => {
      const teamName = 'agent-tool-result-accepted-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      run.activeToolCalls.set('tool-bob-result-accepted', {
        memberName: 'bob',
        toolUseId: 'tool-bob-result-accepted',
        toolName: 'Agent',
        preview: 'Spawn teammate bob',
        startedAt: '2026-04-23T10:00:00.000Z',
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-bob-result-accepted', 'bob');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-bob-result-accepted',
        [{ type: 'text', text: 'Agent spawn accepted' }],
        false
      );

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('bob')?.firstSpawnAcceptedAt).toBeTruthy();
      expect(run.memberSpawnToolUseIds.has('tool-bob-result-accepted')).toBe(false);
      expect(run.provisioningOutputParts.join('\n')).toContain(
        'spawn accepted, waiting for teammate check-in'
      );
    });

    it('fails a spawned teammate when Agent tool result returns an error', async () => {
      const teamName = 'agent-tool-result-error-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      const progressEvents: TeamProvisioningProgress[] = [];
      run.progress = {
        ...run.progress,
        state: 'assembling',
        message: 'Members joining',
      };
      run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      run.activeToolCalls.set('tool-bob-result-error', {
        memberName: 'bob',
        toolUseId: 'tool-bob-result-error',
        toolName: 'Agent',
        preview: 'Spawn teammate bob',
        startedAt: '2026-04-23T10:00:00.000Z',
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-bob-result-error', 'bob');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-bob-result-error',
        [{ type: 'text', text: 'spawn denied by runtime' }],
        true
      );

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: expect.stringContaining('spawn denied by runtime'),
      });
      expect(run.memberSpawnToolUseIds.has('tool-bob-result-error')).toBe(false);
      expect(run.provisioningOutputParts.join('\n')).toContain(
        'Teammate "bob" failed to start: spawn denied by runtime'
      );
      expect(progressEvents.at(-1)).toMatchObject({
        state: 'assembling',
        message: 'Failed to start member bob',
      });
    });

    it('restarts a pure Anthropic teammate through the primary runtime without touching siblings', async () => {
      const teamName = 'pure-anthropic-manual-restart-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      let sentRestartMessage = '';
      (svc as any).sendMessageToRun = async (_run: unknown, message: string) => {
        sentRestartMessage = message;
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

      await svc.restartMember(teamName, 'bob');

      expect(sentRestartMessage).toContain('bob');
      expect(sentRestartMessage).toContain(teamName);
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(run.provisioningOutputParts.join('\n')).toContain('manual restart requested from UI');
    });

    it('keeps a pure Anthropic restart pending after Agent accepts the spawn but before heartbeat', async () => {
      const teamName = 'pure-anthropic-restart-accepted-pending-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      (svc as any).sendMessageToRun = async () => undefined;
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

      await svc.restartMember(teamName, 'bob');
      run.activeToolCalls.set('tool-bob-restart-accepted', {
        memberName: 'bob',
        toolUseId: 'tool-bob-restart-accepted',
        toolName: 'Agent',
        preview: 'Restart teammate bob',
        startedAt: '2026-04-23T10:00:00.000Z',
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('tool-bob-restart-accepted', 'bob');

      (svc as any).finishRuntimeToolActivity(
        run,
        'tool-bob-restart-accepted',
        [{ type: 'text', text: 'Agent spawn accepted' }],
        false
      );

      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('fails a pure Anthropic restart cleanly when the lead runtime cannot receive the command', async () => {
      const teamName = 'pure-anthropic-restart-send-failure-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      (svc as any).sendMessageToRun = async () => {
        throw new Error('lead stdin is closed');
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow('lead stdin is closed');

      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'lead stdin is closed',
      });
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects a duplicate pure Anthropic restart while the first restart is still pending', async () => {
      const teamName = 'pure-anthropic-duplicate-restart-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      let sendCount = 0;
      (svc as any).sendMessageToRun = async () => {
        sendCount += 1;
      };
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

      await svc.restartMember(teamName, 'bob');
      const persistedRestartState = JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
      ) as { members: Record<string, { launchState?: string }> };
      expect(persistedRestartState.members.bob?.launchState).toBe('runtime_pending_bootstrap');
      const persistedRestartSummary = JSON.parse(
        await fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-summary.json'), 'utf8')
      ) as { teamName?: string; pendingCount?: number };
      expect(persistedRestartSummary).toMatchObject({ teamName, pendingCount: 1 });
      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'Restart for teammate "bob" is already in progress'
      );

      expect(sendCount).toBe(1);
      expect(run.pendingMemberRestarts.has('bob')).toBe(true);
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });
    });

    it('clears stale Agent tracking for the restarted teammate without clearing sibling tool calls', async () => {
      const teamName = 'pure-anthropic-restart-clears-stale-tool-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      (svc as any).sendMessageToRun = async () => undefined;
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();
      run.activeToolCalls.set('old-bob-tool', {
        memberName: 'bob',
        toolUseId: 'old-bob-tool',
        toolName: 'Agent',
        preview: 'Old bob spawn',
        startedAt: '2026-04-23T09:59:00.000Z',
        state: 'running',
        source: 'runtime',
      });
      run.activeToolCalls.set('alice-tool', {
        memberName: 'alice',
        toolUseId: 'alice-tool',
        toolName: 'Read',
        preview: 'Alice is working',
        startedAt: '2026-04-23T09:59:00.000Z',
        state: 'running',
        source: 'runtime',
      });
      run.memberSpawnToolUseIds.set('old-bob-tool', 'bob');
      run.memberSpawnToolUseIds.set('alice-tool', 'alice');

      await svc.restartMember(teamName, 'bob');

      expect(run.activeToolCalls.has('old-bob-tool')).toBe(false);
      expect(run.activeToolCalls.has('alice-tool')).toBe(true);
      expect(run.memberSpawnToolUseIds.has('old-bob-tool')).toBe(false);
      expect(run.memberSpawnToolUseIds.get('alice-tool')).toBe('alice');
      expect(run.provisioningOutputParts.join('\n')).toContain(
        'cleared stale spawn tool tracking before manual restart'
      );
    });

    it('keeps manual restart state isolated to the targeted team', async () => {
      const firstTeamName = 'pure-anthropic-restart-team-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-restart-team-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);
      (svc as any).sendMessageToRun = async () => undefined;
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

      await svc.restartMember(firstTeamName, 'bob');

      expect(firstRun.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });
      expect(secondRun.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
      const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
      expect(firstStatuses.teamLaunchState).toBe('partial_pending');
      expect(secondStatuses.teamLaunchState).toBe('clean_success');
    });

    it('rejects restart for a removed pure Anthropic teammate without changing sibling statuses', async () => {
      const teamName = 'pure-anthropic-restart-removed-member-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'Member "bob" has been removed'
      );

      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects restart for the team lead without creating a member restart', async () => {
      const teamName = 'pure-anthropic-restart-lead-reject-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.restartMember(teamName, 'team-lead')).rejects.toThrow(
        'Lead restart is not supported from member controls'
      );

      expect(run.pendingMemberRestarts.size).toBe(0);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects restart after a pure Anthropic team was stopped', async () => {
      const teamName = 'pure-anthropic-restart-after-stop-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);

      svc.stopTeam(teamName);

      expect(svc.isTeamAlive(teamName)).toBe(false);
      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        `Team "${teamName}" is not currently running`
      );
      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
    });

    it('stops one live pure Anthropic team without disconnecting another tracked team', async () => {
      const firstTeamName = 'pure-anthropic-stop-team-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-stop-team-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = { kill: () => undefined };
      secondRun.child = { kill: () => undefined };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      svc.stopTeam(firstTeamName);

      expect(svc.isTeamAlive(firstTeamName)).toBe(false);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
      expect(firstRun.cancelRequested).toBe(true);
      expect(secondRun.cancelRequested).toBe(false);
      const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
      expect(secondStatuses.teamLaunchState).toBe('clean_success');
      expect(secondStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(secondStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('keeps pure Anthropic runtime state isolated when one of two teams stops', async () => {
      const stoppedTeamName = 'pure-anthropic-runtime-state-stopped-safe-e2e';
      const liveTeamName = 'pure-anthropic-runtime-state-live-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
      await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
      await writePureAnthropicMembersMeta(stoppedTeamName);
      await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
      await writePureAnthropicTeamMeta(liveTeamName, projectPath);
      await writePureAnthropicMembersMeta(liveTeamName);
      const svc = new TeamProvisioningService();
      const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
      const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
      stoppedRun.child = createProvisioningChildFixture({
        pid: 61101,
        stdin: { writable: true },
      });
      liveRun.child = createProvisioningChildFixture({
        pid: 61201,
        stdin: { writable: true },
      });
      trackLiveRun(svc, stoppedRun);
      trackLiveRun(svc, liveRun);

      expect(await svc.getRuntimeState(stoppedTeamName)).toMatchObject({
        teamName: stoppedTeamName,
        isAlive: true,
        runId: stoppedRun.runId,
        progress: {
          state: 'finalizing',
        },
      });
      expect(await svc.getRuntimeState(liveTeamName)).toMatchObject({
        teamName: liveTeamName,
        isAlive: true,
        runId: liveRun.runId,
        progress: {
          state: 'finalizing',
        },
      });

      await svc.stopTeam(stoppedTeamName);

      expect(await svc.getRuntimeState(stoppedTeamName)).toMatchObject({
        teamName: stoppedTeamName,
        isAlive: false,
        runId: null,
        progress: null,
      });
      expect(await svc.getRuntimeState(liveTeamName)).toMatchObject({
        teamName: liveTeamName,
        isAlive: true,
        runId: liveRun.runId,
        progress: {
          state: 'finalizing',
        },
      });
      expect(svc.getAliveTeams()).toEqual([liveTeamName]);
    });

    it('stops all tracked pure Anthropic teams and clears lead activity', async () => {
      const firstTeamName = 'pure-anthropic-stop-all-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-stop-all-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = createProvisioningChildFixture({
        pid: 62101,
        stdin: { writable: true },
      });
      secondRun.child = createProvisioningChildFixture({
        pid: 62201,
        stdin: { writable: true },
      });
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      expect(svc.getAliveTeams().sort()).toEqual([firstTeamName, secondTeamName].sort());

      svc.stopAllTeams();

      expect(svc.getAliveTeams()).toEqual([]);
      expect(firstRun.cancelRequested).toBe(true);
      expect(secondRun.cancelRequested).toBe(true);
      expect(svc.getLeadActivityState(firstTeamName)).toEqual({
        state: 'offline',
        runId: null,
      });
      expect(svc.getLeadActivityState(secondTeamName)).toEqual({
        state: 'offline',
        runId: null,
      });
    });

    it('sends a user message only to the targeted pure Anthropic team', async () => {
      const firstTeamName = 'pure-anthropic-message-team-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-message-team-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = { stdin: { writable: true } };
      secondRun.child = { stdin: { writable: true } };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);
      const delivered: Array<{ teamName: string; message: string }> = [];
      (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
        delivered.push({ teamName: run.teamName, message });
      };

      await svc.sendMessageToTeam(secondTeamName, 'please review the latest task');

      expect(delivered).toEqual([
        {
          teamName: secondTeamName,
          message: 'please review the latest task',
        },
      ]);
      expect(svc.isTeamAlive(firstTeamName)).toBe(true);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
      expect(firstRun.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(secondRun.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('serializes attachments only into the targeted pure Anthropic lead stdin', async () => {
      const firstTeamName = 'pure-anthropic-attachment-team-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-attachment-team-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      const firstWrites: string[] = [];
      const secondWrites: string[] = [];
      firstRun.child = { stdin: createWritableStdin(firstWrites) };
      secondRun.child = { stdin: createWritableStdin(secondWrites) };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await svc.sendMessageToTeam(secondTeamName, 'review the attached files', [
        {
          filename: 'notes.txt',
          mimeType: 'text/plain',
          data: Buffer.from('line one\nline two', 'utf8').toString('base64'),
        },
        {
          filename: 'brief.pdf',
          mimeType: 'application/pdf',
          data: 'JVBERi0xLjQ=',
        },
        {
          filename: 'screenshot.png',
          mimeType: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      ]);

      expect(firstWrites).toEqual([]);
      expect(secondWrites).toHaveLength(1);
      const payload = JSON.parse(secondWrites[0].trim()) as {
        message: { content: Array<Record<string, unknown>> };
      };
      expect(payload.message.content).toMatchObject([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
        {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: 'line one\nline two' },
          title: 'notes.txt',
        },
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
          title: 'brief.pdf',
        },
        { type: 'text', text: 'review the attached files' },
      ]);
      expect(svc.isTeamAlive(firstTeamName)).toBe(true);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    });

    it('serializes Claude GIF and WebP attachments without marking the team offline', async () => {
      const teamName = 'pure-anthropic-extended-image-mimes-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      const writes: string[] = [];
      run.child = { stdin: createWritableStdin(writes) };
      trackLiveRun(svc, run);

      await svc.sendMessageToTeam(teamName, 'review these browser images', [
        {
          filename: 'clip.gif',
          mimeType: 'image/gif',
          data: 'R0lGODlhAQABAAAAACw=',
        },
        {
          filename: 'clip.webp',
          mimeType: 'image/webp',
          data: 'UklGRiIAAABXRUJQ',
        },
      ]);

      expect(writes).toHaveLength(1);
      const payload = JSON.parse(writes[0].trim()) as {
        message: { content: Array<Record<string, unknown>> };
      };
      expect(payload.message.content).toMatchObject([
        { type: 'image', source: { type: 'base64', media_type: 'image/gif' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp' } },
        { type: 'text', text: 'review these browser images' },
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(true);
    });

    it('routes messages to the current pure Anthropic run after same-team relaunch', async () => {
      const teamName = 'pure-anthropic-message-current-run-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
      const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      const staleWrites: string[] = [];
      const currentWrites: string[] = [];
      staleRun.child = { stdin: createWritableStdin(staleWrites) };
      currentRun.child = { stdin: createWritableStdin(currentWrites) };
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      await svc.sendMessageToTeam(teamName, 'use the latest run only');

      expect(staleWrites).toEqual([]);
      expect(currentWrites).toHaveLength(1);
      const payload = JSON.parse(currentWrites[0].trim()) as {
        message: { content: Array<Record<string, unknown>> };
      };
      expect(payload.message.content).toMatchObject([
        { type: 'text', text: 'use the latest run only' },
      ]);
      expect(svc.getLeadActivityState(teamName)).toEqual({
        state: 'active',
        runId: currentRun.runId,
      });
    });

    it('sends a user message only to the targeted Anthropic and Gemini mixed team', async () => {
      const firstTeamName = 'mixed-anthropic-gemini-message-team-a-safe-e2e';
      const secondTeamName = 'mixed-anthropic-gemini-message-team-b-safe-e2e';
      await writeMixedTeamConfig({
        teamName: firstTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(firstTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(firstTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: secondTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(secondTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(secondTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const svc = new TeamProvisioningService();
      const firstRun = createMixedLiveRun({
        teamName: firstTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const secondRun = createMixedLiveRun({
        teamName: secondTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(firstRun);
      addGeminiPrimaryToMixedRun(secondRun);
      firstRun.child = { stdin: { writable: true } };
      secondRun.child = { stdin: { writable: true } };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);
      const delivered: Array<{ teamName: string; message: string }> = [];
      (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
        delivered.push({ teamName: run.teamName, message });
      };

      await svc.sendMessageToTeam(secondTeamName, 'review mixed launch state');

      expect(delivered).toEqual([
        {
          teamName: secondTeamName,
          message: 'review mixed launch state',
        },
      ]);
      expect(svc.isTeamAlive(firstTeamName)).toBe(true);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
      expect(firstRun.memberSpawnStatuses.get('reviewer')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(secondRun.memberSpawnStatuses.get('reviewer')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('routes messages to the current Anthropic and Gemini mixed run after same-team relaunch', async () => {
      const teamName = 'mixed-anthropic-gemini-message-current-run-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const svc = new TeamProvisioningService();
      const staleRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(staleRun);
      addGeminiPrimaryToMixedRun(currentRun);
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      const staleWrites: string[] = [];
      const currentWrites: string[] = [];
      staleRun.child = { stdin: createWritableStdin(staleWrites) };
      currentRun.child = { stdin: createWritableStdin(currentWrites) };
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      await svc.sendMessageToTeam(teamName, 'use the latest mixed run only');

      expect(staleWrites).toEqual([]);
      expect(currentWrites).toHaveLength(1);
      const payload = JSON.parse(currentWrites[0].trim()) as {
        message: { content: Array<Record<string, unknown>> };
      };
      expect(payload.message.content).toMatchObject([
        { type: 'text', text: 'use the latest mixed run only' },
      ]);
      expect(svc.getLeadActivityState(teamName)).toEqual({
        state: 'active',
        runId: currentRun.runId,
      });
    });

    it('routes direct OpenCode member messages to the current Anthropic and Gemini mixed run after same-team relaunch', async () => {
      const teamName = 'mixed-anthropic-gemini-direct-message-current-run-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const staleRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(staleRun);
      addGeminiPrimaryToMixedRun(currentRun);
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      await markMixedOpenCodeLaneConfirmedForTest(currentRun, 'bob');
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'use current run for direct opencode message',
          messageId: 'msg-current-direct-opencode',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: currentRun.runId,
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'use current run for direct opencode message',
        messageId: 'msg-current-direct-opencode',
      });
      expect(adapter.messageInputs[0]?.runId).not.toBe(staleRun.runId);
    });

    it('surfaces mixed OpenCode side-lane delivery permission blocks through shared approvals', async () => {
      const teamName = 'mixed-opencode-delivery-permission-approval-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('secondary:opencode:bob', [
        {
          providerId: 'opencode',
          requestId: 'perm-bob-delivery',
          sessionId: 'session-bob',
          tool: 'bash',
          title: 'Run pnpm test',
          kind: 'tool',
          raw: { patterns: ['pnpm test'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      run.runId = `run-${teamName}-current`;
      await markMixedOpenCodeLaneConfirmedForTest(run, 'bob');
      trackLiveRun(svc, run);

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'trigger a side-lane permission-blocked delivery',
          messageId: 'msg-mixed-opencode-permission-blocked',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      expect(adapter.permissionListInputs).toEqual([
        {
          teamName,
          laneId: 'secondary:opencode:bob',
          cwd: projectPath,
          memberName: 'bob',
          sessionId: 'session-bob',
        },
      ]);
      const approval = approvalEvents.find(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approval).toMatchObject({
        requestId: `opencode:${run.runId}:perm-bob-delivery`,
        runId: run.runId,
        teamName,
        providerId: 'opencode',
        source: 'bob',
        toolName: 'Bash',
        toolInput: {
          provider: 'opencode',
          providerRequestId: 'perm-bob-delivery',
          command: 'pnpm test',
        },
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          providerRequestId: 'perm-bob-delivery',
        },
      });
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        pendingPermissionRequestIds: ['perm-bob-delivery'],
        runtimeDiagnostic: 'OpenCode runtime is waiting for permission approval',
      });
      await waitForCondition(async () => {
        let persisted: { members?: Record<string, { pendingPermissionRequestIds?: string[] }> };
        try {
          persisted = JSON.parse(
            await fs.readFile(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), 'utf8')
          ) as typeof persisted;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
          }
          throw error;
        }
        return (
          persisted.members?.bob?.pendingPermissionRequestIds?.includes('perm-bob-delivery') ===
          true
        );
      });
    });

    it('persists mixed OpenCode permissions to the matching lane member when persisted keys diverge', async () => {
      const teamName = 'mixed-opencode-delivery-permission-lane-key-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('secondary:opencode:bob', [
        {
          providerId: 'opencode',
          requestId: 'perm-bob-lane-key',
          sessionId: 'session-bob',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      run.runId = `run-${teamName}-current`;
      run.isLaunch = false;
      await markMixedOpenCodeLaneConfirmedForTest(run, 'bob');
      trackLiveRun(svc, run);

      const teamDir = path.join(getTeamsBasePath(), teamName);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'reviewer', 'bob'],
            leadSessionId: 'lead-session',
            launchPhase: 'active',
            members: {
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/old-primary',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'anthropic',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                runtimeRunId: run.runId,
                runtimeSessionId: 'session-primary-bob',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              'secondary:opencode:bob': {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                runtimeRunId: run.runId,
                runtimeSessionId: 'session-bob',
                livenessKind: 'confirmed_bootstrap',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
          })
        )}\n`,
        'utf8'
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'trigger a side-lane permission-blocked delivery with lane-keyed state',
          messageId: 'msg-mixed-opencode-permission-lane-key',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      const approvals = approvalEvents.filter(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approvals).toEqual([
        expect.objectContaining({
          requestId: `opencode:${run.runId}:perm-bob-lane-key`,
          source: 'bob',
        }),
      ]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(teamDir, 'launch-state.json'), 'utf8')
      ) as {
        members?: Record<string, { pendingPermissionRequestIds?: string[] }>;
      };
      expect(persisted.members?.bob?.pendingPermissionRequestIds).toBeUndefined();
      expect(persisted.members?.['secondary:opencode:bob']?.pendingPermissionRequestIds).toEqual([
        'perm-bob-lane-key',
      ]);
    });

    it('refreshes stale mixed OpenCode secondary session evidence before direct delivery when MCP transport changed', async () => {
      const teamName = 'mixed-opencode-secondary-transport-refresh-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      run.runId = `run-${teamName}-current`;
      await markMixedOpenCodeLaneConfirmedForTest(run, 'bob', {
        sessionId: 'oc-session-bob-stale-mixed-transport',
        appMcpTransportHash: 'old-mixed-safe-e2e-transport-hash',
      });
      trackLiveRun(svc, run);

      const transportSpy = vi.spyOn(agentTeamsMcpHttpServer, 'getCurrentHandle').mockReturnValue({
        url: 'http://127.0.0.1:43126/mcp',
        port: 43126,
        child: { pid: 43126 },
        generation: 5,
        urlHash: 'current-mixed-safe-e2e-transport-hash',
        transportEvidence: {
          schemaVersion: 1,
          transport: 'httpStream',
          host: '127.0.0.1',
          port: 43126,
          endpoint: '/mcp',
          url: 'http://127.0.0.1:43126/mcp',
          urlHash: 'current-mixed-safe-e2e-transport-hash',
          generation: 5,
          observedAt: '2026-04-23T10:00:00.000Z',
        },
        diagnostics: [],
      } as any);

      try {
        await expectOpenCodeTrackedPendingDelivery(
          svc.deliverOpenCodeMemberMessage(teamName, {
            memberName: 'bob',
            text: 'refresh stale mixed transport before opencode send',
            messageId: 'msg-mixed-transport-refresh-safe-e2e',
          })
        );
      } finally {
        transportSpy.mockRestore();
      }

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: run.runId,
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        forceSessionRefreshReason:
          'opencode_app_mcp_transport_changed:old-mixed-safe-e2e-transport-hash->current-mixed-safe-e2e-transport-hash',
      });

      const evidence = await readCommittedOpenCodeBootstrapSessionEvidence({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      expect(evidence.sessions[0]).toMatchObject({
        id: 'session-bob',
        appMcpTransportHash: 'current-mixed-safe-e2e-transport-hash',
      });
    });

    it('routes direct OpenCode member messages only to the targeted live mixed OpenCode lane', async () => {
      const firstTeamName = 'mixed-opencode-direct-message-live-team-a-safe-e2e';
      const secondTeamName = 'mixed-opencode-direct-message-live-team-b-safe-e2e';
      await writeMixedTeamConfig({
        teamName: firstTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(firstTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(firstTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: secondTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(secondTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(secondTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const firstRun = createMixedLiveRun({
        teamName: firstTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const secondRun = createMixedLiveRun({
        teamName: secondTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(firstRun);
      addGeminiPrimaryToMixedRun(secondRun);
      firstRun.child = { stdin: { writable: true } };
      secondRun.child = { stdin: { writable: true } };
      await markMixedOpenCodeLaneConfirmedForTest(secondRun, 'bob');
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(secondTeamName, {
          memberName: 'bob',
          text: 'send to the second live mixed opencode lane only',
          messageId: 'msg-live-mixed-opencode-team-b',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: secondRun.runId,
        teamName: secondTeamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'send to the second live mixed opencode lane only',
        messageId: 'msg-live-mixed-opencode-team-b',
      });
      expect(adapter.messageInputs[0]?.runId).not.toBe(firstRun.runId);
      expect(svc.isTeamAlive(firstTeamName)).toBe(true);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    });

    it('routes direct OpenCode member messages to a fresh Anthropic and Gemini mixed relaunch after cancelling an in-flight handoff', async () => {
      const cancelledTeamName = 'mixed-anthropic-gemini-direct-after-cancelled-handoff-safe-e2e';
      const survivingTeamName = 'mixed-anthropic-gemini-direct-survives-cancelled-handoff-safe-e2e';
      await writeMixedTeamConfig({
        teamName: cancelledTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(cancelledTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: survivingTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(survivingTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const survivingRun = createMixedLiveRun({
        teamName: survivingTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(cancelledRun);
      addGeminiPrimaryToMixedRun(survivingRun);
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() =>
        adapter.pendingLaunchInputs.some((input) => input.teamName === cancelledTeamName)
      );

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const freshRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      freshRun.runId = `${cancelledRun.runId}-fresh`;
      freshRun.detectedSessionId = 'lead-session-fresh';
      freshRun.child = { kill: () => undefined };
      addGeminiPrimaryToMixedRun(freshRun);
      trackLiveRun(svc, freshRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
      await waitForCondition(() => adapter.launchInputs.length === 5);
      await waitForCondition(() =>
        freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(cancelledTeamName, {
          memberName: 'bob',
          text: 'send to fresh mixed relaunch after cancelled handoff',
          messageId: 'msg-fresh-mixed-opencode-after-cancelled-handoff',
        })
      );
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(survivingTeamName, {
          memberName: 'tom',
          text: 'send to surviving sibling mixed lane',
          messageId: 'msg-surviving-mixed-opencode-after-cancelled-handoff',
        })
      );

      expect(adapter.messageInputs).toHaveLength(2);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, cancelledTeamName, 'secondary:opencode:bob'),
        teamName: cancelledTeamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'send to fresh mixed relaunch after cancelled handoff',
        messageId: 'msg-fresh-mixed-opencode-after-cancelled-handoff',
      });
      expect(adapter.messageInputs[1]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, survivingTeamName, 'secondary:opencode:tom'),
        teamName: survivingTeamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'send to surviving sibling mixed lane',
        messageId: 'msg-surviving-mixed-opencode-after-cancelled-handoff',
      });
      expect(adapter.messageInputs.map((input) => input.runId)).not.toContain(cancelledRun.runId);
    });

    it('does not deliver direct OpenCode member messages to a cancelled mixed handoff after late launch completion while a sibling stays live', async () => {
      const cancelledTeamName = 'mixed-direct-cancelled-late-completion-safe-e2e';
      const survivingTeamName = 'mixed-direct-sibling-after-cancelled-late-completion-safe-e2e';
      await writeMixedTeamConfig({
        teamName: cancelledTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(cancelledTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: survivingTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(survivingTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const survivingRun = createMixedLiveRun({
        teamName: survivingTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(cancelledRun);
      addGeminiPrimaryToMixedRun(survivingRun);
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() =>
        adapter.pendingLaunchInputs.some((input) => input.teamName === cancelledTeamName)
      );

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(cancelledTeamName, {
          memberName: 'bob',
          text: 'must not reach cancelled mixed handoff after late launch',
          messageId: 'msg-cancelled-mixed-late-launch-direct',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(survivingTeamName, {
          memberName: 'bob',
          text: 'sibling still receives direct message after cancelled launch',
          messageId: 'msg-sibling-after-cancelled-late-launch-direct',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, survivingTeamName, 'secondary:opencode:bob'),
        teamName: survivingTeamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'sibling still receives direct message after cancelled launch',
        messageId: 'msg-sibling-after-cancelled-late-launch-direct',
      });
      expect(adapter.messageInputs[0]?.runId).not.toBe(cancelledRun.runId);
    });

    it('routes direct OpenCode member messages to the alive mixed run when stale provisioning state remains', async () => {
      const teamName = 'mixed-direct-message-stale-provisioning-alive-run-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(currentRun);
      currentRun.runId = `run-${teamName}-current`;
      await markMixedOpenCodeLaneConfirmedForTest(currentRun, 'bob');
      trackLiveRun(svc, currentRun);
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'use alive mixed run despite stale provisioning',
          messageId: 'msg-stale-provisioning-alive-mixed',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: currentRun.runId,
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'use alive mixed run despite stale provisioning',
        messageId: 'msg-stale-provisioning-alive-mixed',
      });
    });

    it('routes direct OpenCode member messages to the current pure OpenCode run after same-team relaunch', async () => {
      const teamName = 'pure-opencode-direct-message-current-run-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const first = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const second = await svc.launchTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'use current pure opencode run only',
          messageId: 'msg-current-pure-opencode',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: second.runId,
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'use current pure opencode run only',
        messageId: 'msg-current-pure-opencode',
      });
      expect(adapter.messageInputs[0]?.runId).not.toBe(first.runId);
    });

    it('delivers pure OpenCode lead inbox messages through the primary runtime lane end-to-end', async () => {
      const teamName = 'pure-opencode-lead-inbox-delivery-safe-e2e';
      const adapter = new VisibleReplyOpenCodeRuntimeAdapter({
        replySource: 'runtime_delivery',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const messageId = 'msg-pure-opencode-lead-inbox';
      const leadInboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', 'team-lead.json');
      await fs.mkdir(path.dirname(leadInboxPath), { recursive: true });
      await fs.writeFile(
        leadInboxPath,
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'team-lead',
              text: 'coordinate this pure opencode team',
              timestamp: '2026-05-08T10:05:00.000Z',
              read: false,
              messageId,
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );

      await expect(
        svc.relayInboxFileToLiveRecipient(teamName, 'team-lead', {
          onlyMessageId: messageId,
          source: 'ui-send',
          deliveryMetadata: {
            replyRecipient: 'user',
            actionMode: 'do',
          },
        })
      ).resolves.toMatchObject({
        kind: 'opencode_member',
        relayed: 1,
        lastDelivery: {
          delivered: true,
          accepted: true,
          responsePending: false,
          responseState: 'responded_visible_message',
          visibleReplyMessageId: `reply-${messageId}`,
        },
      });

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: launch.runId,
        teamName,
        laneId: 'primary',
        memberName: 'team-lead',
        text: 'coordinate this pure opencode team',
        messageId,
        replyRecipient: 'user',
        actionMode: 'do',
      });

      const leadInbox = await readInboxRows(teamName, 'team-lead');
      expect(leadInbox[0]).toMatchObject({
        messageId,
        read: true,
      });
      const userInbox = await readInboxRows(teamName, 'user');
      expect(userInbox[0]).toMatchObject({
        from: 'team-lead',
        to: 'user',
        source: 'runtime_delivery',
        messageId: `reply-${messageId}`,
        relayOfMessageId: messageId,
      });
    });

    it('surfaces pure OpenCode delivery permission blocks as the shared tool approval dialog', async () => {
      const teamName = 'pure-opencode-delivery-permission-approval-safe-e2e';
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-delivery',
          sessionId: null,
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger a permission-blocked delivery',
          messageId: 'msg-pure-opencode-permission-blocked',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      expect(adapter.permissionListInputs).toEqual([
        {
          teamName,
          laneId: 'primary',
          cwd: projectPath,
          memberName: 'alice',
          sessionId: 'session-alice',
        },
      ]);
      const approval = approvalEvents.find(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approval).toMatchObject({
        requestId: `opencode:${launch.runId}:perm-alice-delivery`,
        runId: launch.runId,
        teamName,
        providerId: 'opencode',
        source: 'alice',
        toolName: 'Bash',
        toolInput: {
          provider: 'opencode',
          providerRequestId: 'perm-alice-delivery',
          command: 'git status',
        },
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'alice',
          providerRequestId: 'perm-alice-delivery',
        },
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.statuses.alice?.pendingPermissionRequestIds).toEqual(['perm-alice-delivery']);
    });

    it('keeps other primary OpenCode approvals when a delivery-blocked member syncs permissions', async () => {
      const teamName = 'pure-opencode-delivery-permission-member-scope-safe-e2e';
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter('partial_pending', {
        alice: 'confirmed',
        bob: 'permission',
      });
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-delivery',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: false,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );

      expect(approvalEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: `opencode:${launch.runId}:perm-bob`,
            source: 'bob',
          }),
        ])
      );
      approvalEvents.length = 0;

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger alice permission-blocked delivery',
          messageId: 'msg-pure-opencode-permission-blocked-member-scope',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      expect(approvalEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: `opencode:${launch.runId}:perm-alice-delivery`,
            source: 'alice',
          }),
        ])
      );
      expect(approvalEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            autoResolved: true,
            requestId: `opencode:${launch.runId}:perm-bob`,
            reason: 'runtime_resolved',
          }),
        ])
      );

      await svc.respondToToolApproval(
        teamName,
        launch.runId!,
        `opencode:${launch.runId}:perm-bob`,
        true
      );
      expect(adapter.permissionAnswerInputs).toEqual([
        expect.objectContaining({
          runId: launch.runId,
          teamName,
          laneId: 'primary',
          memberName: 'bob',
          requestId: 'perm-bob',
          decision: 'allow',
        }),
      ]);
    });

    it('does not surface stale OpenCode delivery permissions after the tracked run changes during listing', async () => {
      const teamName = 'pure-opencode-delivery-permission-stale-run-safe-e2e';
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-stale-run',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ]);
      let releaseList!: () => void;
      let markListStarted!: () => void;
      const listStarted = new Promise<void>((resolve) => {
        markListStarted = resolve;
      });
      const releaseListPromise = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      const originalListRuntimePermissions = adapter.listRuntimePermissions.bind(adapter);
      vi.spyOn(adapter, 'listRuntimePermissions').mockImplementation(async (input) => {
        markListStarted();
        await releaseListPromise;
        return originalListRuntimePermissions(input);
      });

      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const delivery = svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'trigger permission listing while the run changes',
        messageId: 'msg-pure-opencode-permission-stale-run',
      });
      await listStarted;
      (svc as any).provisioningRunByTeam.set(teamName, `${launch.runId}-replacement`);
      (svc as any).aliveRunByTeam.set(teamName, `${launch.runId}-replacement`);
      releaseList();

      await expect(delivery).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });
      expect(approvalEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: `opencode:${launch.runId}:perm-alice-stale-run`,
          }),
        ])
      );
    });

    it('does not surface stale OpenCode delivery permissions after the tracked run changes during persisted-state read', async () => {
      const teamName = 'pure-opencode-delivery-permission-stale-read-safe-e2e';
      const adapter = new PermissionBlockedOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-stale-read',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ]);
      const originalListRuntimePermissions = adapter.listRuntimePermissions.bind(adapter);
      let replaceRunOnNextLaunchStateRead = false;
      vi.spyOn(adapter, 'listRuntimePermissions').mockImplementation(async (input) => {
        const result = await originalListRuntimePermissions(input);
        replaceRunOnNextLaunchStateRead = true;
        return result;
      });

      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const launchStateStore = (svc as any).launchStateStore as {
        read(teamName: string): Promise<unknown>;
      };
      const originalRead = launchStateStore.read.bind(launchStateStore);
      vi.spyOn(launchStateStore, 'read').mockImplementation(async (readTeamName) => {
        const snapshot = await originalRead(readTeamName);
        if (replaceRunOnNextLaunchStateRead && readTeamName === teamName) {
          replaceRunOnNextLaunchStateRead = false;
          (svc as any).provisioningRunByTeam.set(teamName, `${launch.runId}-replacement`);
          (svc as any).aliveRunByTeam.set(teamName, `${launch.runId}-replacement`);
        }
        return snapshot;
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger permission listing before the persisted state read changes run',
          messageId: 'msg-pure-opencode-permission-stale-read',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });
      expect(approvalEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: `opencode:${launch.runId}:perm-alice-stale-read`,
          }),
        ])
      );
    });

    it('surfaces OpenCode permissions when inline delivery observe hits a pending request', async () => {
      const teamName = 'pure-opencode-inline-observe-permission-approval-safe-e2e';
      const adapter = new PermissionBlockedInlineObserveOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-inline-observe',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run printf',
          kind: 'tool',
          raw: { patterns: ['printf inline-observe'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger inline observe permission block',
          messageId: 'msg-pure-opencode-inline-observe-permission-blocked',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'watcher',
          inboxTimestamp: '2026-05-08T10:00:00.000Z',
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'reconcile_failed',
      });

      expect(adapter.permissionListInputs).toEqual([
        {
          teamName,
          laneId: 'primary',
          cwd: projectPath,
          memberName: 'alice',
          sessionId: 'session-alice',
        },
      ]);
      expect(adapter.observeInputs).toHaveLength(1);
      expect(adapter.observeInputs[0]).toMatchObject({
        sessionId: 'session-alice',
        runtimePromptMessageId: 'prompt-msg-pure-opencode-inline-observe-permission-blocked',
        prePromptCursor: 'cursor-before-inline-observe-permission',
      });
      const approval = approvalEvents.find(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approval).toMatchObject({
        requestId: `opencode:${launch.runId}:perm-alice-inline-observe`,
        runId: launch.runId,
        teamName,
        providerId: 'opencode',
        source: 'alice',
        toolName: 'Bash',
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'alice',
          providerRequestId: 'perm-alice-inline-observe',
          sessionId: 'session-alice',
        },
      });
    });

    it('does not assign unknown primary-lane OpenCode permission sessions to the delivery target', async () => {
      const teamName = 'pure-opencode-primary-permission-session-scope-safe-e2e';
      const adapter = new PermissionBlockedWithoutSessionOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-delivery',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
        {
          providerId: 'opencode',
          requestId: 'perm-unknown-session',
          sessionId: 'session-charlie',
          tool: 'bash',
          title: 'Run npm test',
          kind: 'tool',
          raw: { patterns: ['npm test'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger a permission-blocked delivery without session evidence',
          messageId: 'msg-pure-opencode-permission-blocked-no-session',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      const approvals = approvalEvents.filter(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approvals.map((event) => event.runtimePermission?.providerRequestId)).toEqual([
        'perm-alice-delivery',
      ]);
      expect(approvals[0]).toMatchObject({
        requestId: `opencode:${launch.runId}:perm-alice-delivery`,
        source: 'alice',
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'alice',
          providerRequestId: 'perm-alice-delivery',
          sessionId: 'session-alice',
        },
      });
    });

    it('uses current OpenCode runtime session evidence when persisted launch state is unavailable', async () => {
      const teamName = 'pure-opencode-primary-permission-runtime-session-map-safe-e2e';
      const adapter = new PermissionBlockedWithoutSessionOpenCodeRuntimeAdapter();
      adapter.setRuntimePermissions('primary', [
        {
          providerId: 'opencode',
          requestId: 'perm-alice-delivery',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
        {
          providerId: 'opencode',
          requestId: 'perm-unknown-session',
          sessionId: 'session-charlie',
          tool: 'bash',
          title: 'Run npm test',
          kind: 'tool',
          raw: { patterns: ['npm test'] },
        },
      ]);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const approvalEvents: ToolApprovalEvent[] = [];
      svc.setToolApprovalEventEmitter((event) => approvalEvents.push(event));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );
      await fs.rm(path.join(getTeamsBasePath(), teamName, 'launch-state.json'), { force: true });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'trigger permission-blocked delivery after launch-state disappeared',
          messageId: 'msg-pure-opencode-permission-runtime-session-map',
        })
      ).resolves.toMatchObject({
        delivered: false,
        responseState: 'permission_blocked',
      });

      expect(adapter.permissionListInputs).toEqual([
        {
          teamName,
          laneId: 'primary',
          cwd: projectPath,
          memberName: 'alice',
          sessionId: undefined,
        },
      ]);
      const approvals = approvalEvents.filter(
        (event): event is ToolApprovalRequest =>
          !('dismissed' in event) && !('autoResolved' in event)
      );
      expect(approvals.map((event) => event.runtimePermission?.providerRequestId)).toEqual([
        'perm-alice-delivery',
      ]);
      expect(approvals[0]).toMatchObject({
        requestId: `opencode:${launch.runId}:perm-alice-delivery`,
        source: 'alice',
        runtimePermission: {
          providerId: 'opencode',
          laneId: 'primary',
          memberName: 'alice',
          providerRequestId: 'perm-alice-delivery',
          sessionId: 'session-alice',
        },
      });
    });

    it('refreshes stale OpenCode session evidence before direct delivery when MCP transport changed', async () => {
      const teamName = 'pure-opencode-direct-message-transport-refresh-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      await writeOpenCodeBootstrapSessionEvidenceForTest({
        teamName,
        laneId: 'primary',
        runId: launch.runId,
        memberName: 'alice',
        sessionId: 'oc-session-alice-stale-transport',
        appMcpTransportHash: 'old-safe-e2e-transport-hash',
      });

      const transportSpy = vi.spyOn(agentTeamsMcpHttpServer, 'getCurrentHandle').mockReturnValue({
        url: 'http://127.0.0.1:43125/mcp',
        port: 43125,
        child: { pid: 43125 },
        generation: 4,
        urlHash: 'current-safe-e2e-transport-hash',
        transportEvidence: {
          schemaVersion: 1,
          transport: 'httpStream',
          host: '127.0.0.1',
          port: 43125,
          endpoint: '/mcp',
          url: 'http://127.0.0.1:43125/mcp',
          urlHash: 'current-safe-e2e-transport-hash',
          generation: 4,
          observedAt: '2026-04-23T10:00:00.000Z',
        },
        diagnostics: [],
      } as any);

      try {
        await expectOpenCodeTrackedPendingDelivery(
          svc.deliverOpenCodeMemberMessage(teamName, {
            memberName: 'alice',
            text: 'refresh stale transport before pure opencode send',
            messageId: 'msg-transport-refresh-safe-e2e',
          })
        );
      } finally {
        transportSpy.mockRestore();
      }

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: launch.runId,
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        forceSessionRefreshReason:
          'opencode_app_mcp_transport_changed:old-safe-e2e-transport-hash->current-safe-e2e-transport-hash',
      });

      const evidence = await readCommittedOpenCodeBootstrapSessionEvidence({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
      });
      expect(evidence.sessions[0]).toMatchObject({
        id: 'session-alice',
        appMcpTransportHash: 'current-safe-e2e-transport-hash',
      });
    });

    it('routes direct OpenCode member messages only to the targeted live pure OpenCode team', async () => {
      const firstTeamName = 'pure-opencode-direct-message-live-team-a-safe-e2e';
      const secondTeamName = 'pure-opencode-direct-message-live-team-b-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const first = await svc.createTeam(
        {
          teamName: firstTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      const second = await svc.createTeam(
        {
          teamName: secondTeamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(secondTeamName, {
          memberName: 'alice',
          text: 'send to the second live pure opencode team only',
          messageId: 'msg-live-pure-opencode-team-b',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: second.runId,
        teamName: secondTeamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'send to the second live pure opencode team only',
        messageId: 'msg-live-pure-opencode-team-b',
      });
      expect(adapter.messageInputs[0]?.runId).not.toBe(first.runId);
      expect(svc.isTeamAlive(firstTeamName)).toBe(true);
      expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    });

    it('routes direct OpenCode member messages to the alive pure OpenCode run when stale provisioning state remains', async () => {
      const teamName = 'pure-opencode-direct-message-stale-provisioning-alive-run-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const current = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'use alive pure opencode run despite stale provisioning',
          messageId: 'msg-stale-provisioning-alive-pure',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: current.runId,
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'use alive pure opencode run despite stale provisioning',
        messageId: 'msg-stale-provisioning-alive-pure',
      });
    });

    it('inherits OpenCode runtime delivery taskRefs end-to-end when the visible reply omits them', async () => {
      const teamName = 'pure-opencode-runtime-delivery-taskrefs-inherit-safe-e2e';
      const taskRef: TaskRef = {
        teamName,
        taskId: 'task-runtime-delivery-1',
        displayId: 'abcd1234',
      };
      const adapter = new VisibleReplyOpenCodeRuntimeAdapter({
        replySource: 'runtime_delivery',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const launch = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'reply about #abcd1234 without manually carrying metadata',
          messageId: 'msg-taskrefs-inherit-e2e',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'manual',
          taskRefs: [taskRef],
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'responded',
        visibleReplyMessageId: 'reply-msg-taskrefs-inherit-e2e',
        visibleReplyCorrelation: 'relayOfMessageId',
      });

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: launch.runId,
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        messageId: 'msg-taskrefs-inherit-e2e',
        taskRefs: [taskRef],
      });

      const userInbox = await readInboxRows(teamName, 'user');
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        from: 'alice',
        to: 'user',
        source: 'runtime_delivery',
        messageId: 'reply-msg-taskrefs-inherit-e2e',
        relayOfMessageId: 'msg-taskrefs-inherit-e2e',
        taskRefs: [taskRef],
      });
    });

    it('does not attach taskRefs end-to-end to explicit non-runtime visible replies', async () => {
      const teamName = 'pure-opencode-runtime-delivery-taskrefs-non-runtime-safe-e2e';
      const taskRef: TaskRef = {
        teamName,
        taskId: 'task-runtime-delivery-2',
        displayId: 'dcba4321',
      };
      const adapter = new VisibleReplyOpenCodeRuntimeAdapter({
        replySource: 'lead_process',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'this reply has a misleading non-runtime source',
          messageId: 'msg-taskrefs-non-runtime-e2e',
          replyRecipient: 'user',
          actionMode: 'ask',
          source: 'manual',
          taskRefs: [taskRef],
        })
      ).resolves.toMatchObject({
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'responded_visible_message',
        reason: 'visible_reply_missing_task_refs',
      });

      const userInbox = await readInboxRows(teamName, 'user');
      expect(userInbox).toHaveLength(1);
      expect(userInbox[0]).toMatchObject({
        from: 'alice',
        to: 'user',
        source: 'lead_process',
        messageId: 'reply-msg-taskrefs-non-runtime-e2e',
        relayOfMessageId: 'msg-taskrefs-non-runtime-e2e',
      });
      expect(userInbox[0]?.taskRefs).toBeUndefined();
    });

    it('delivers direct OpenCode member messages to recovered pure OpenCode lanes after service restart', async () => {
      const teamName = 'pure-opencode-direct-message-recovered-lane-safe-e2e';
      const launchAdapter = new FakeOpenCodeRuntimeAdapter();
      const firstService = new TeamProvisioningService();
      firstService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([launchAdapter]));
      const launch = await firstService.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const messageAdapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([messageAdapter]));

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'message recovered pure opencode lane',
          messageId: 'msg-recovered-pure-opencode',
        })
      );
      expect(messageAdapter.messageInputs).toHaveLength(1);
      expect(messageAdapter.messageInputs[0]).toMatchObject({
        runId: launch.runId,
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'message recovered pure opencode lane',
        messageId: 'msg-recovered-pure-opencode',
      });
      expect(messageAdapter.messageInputs[0]?.runId).toBe(launchAdapter.launchInputs[0]?.runId);
    });

    it('delivers direct OpenCode member messages to recovered pure OpenCode lanes despite stale terminal provisioning state', async () => {
      const teamName = 'pure-opencode-direct-message-recovered-stale-terminal-safe-e2e';
      await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
      await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'message recovered pure lane despite stale terminal state',
          messageId: 'msg-recovered-pure-stale-terminal',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'message recovered pure lane despite stale terminal state',
        messageId: 'msg-recovered-pure-stale-terminal',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages to recovered pure OpenCode lanes when config is missing', async () => {
      const teamName = 'pure-opencode-direct-message-meta-only-recovered-safe-e2e';
      await writeOpenCodeTeamMeta(teamName, projectPath);
      await writeOpenCodeMembersMeta(teamName, {
        members: ['alice'],
        memberCwd: projectPath,
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'message pure opencode recovered from meta only',
          messageId: 'msg-meta-only-pure-opencode',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'message pure opencode recovered from meta only',
        messageId: 'msg-meta-only-pure-opencode',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('keeps recovered pure OpenCode direct messages isolated across teams with the same member name', async () => {
      const activeTeamName = 'pure-opencode-direct-message-cross-team-active-safe-e2e';
      const degradedTeamName = 'pure-opencode-direct-message-cross-team-degraded-safe-e2e';
      const activeProjectPath = path.join(tempDir, 'project-active-pure');
      const degradedProjectPath = path.join(tempDir, 'project-degraded-pure');
      await fs.mkdir(activeProjectPath, { recursive: true });
      await fs.mkdir(degradedProjectPath, { recursive: true });
      await writeOpenCodeTeamMeta(activeTeamName, activeProjectPath);
      await writeOpenCodeMembersMeta(activeTeamName, {
        members: ['alice'],
        memberCwd: activeProjectPath,
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName: activeTeamName,
        laneId: 'primary',
        state: 'active',
      });
      await writeOpenCodeTeamMeta(degradedTeamName, degradedProjectPath);
      await writeOpenCodeMembersMeta(degradedTeamName, {
        members: ['alice'],
        memberCwd: degradedProjectPath,
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName: degradedTeamName,
        laneId: 'primary',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(activeTeamName, {
          memberName: 'alice',
          text: 'message only active pure team',
          messageId: 'msg-cross-team-active-pure',
        })
      );
      await expect(
        svc.deliverOpenCodeMemberMessage(degradedTeamName, {
          memberName: 'alice',
          text: 'must not reach degraded pure team',
          messageId: 'msg-cross-team-degraded-pure',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName: activeTeamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: activeProjectPath,
        text: 'message only active pure team',
        messageId: 'msg-cross-team-active-pure',
      });
    });

    it('does not deliver direct OpenCode member messages to stopped pure OpenCode teams', async () => {
      const teamName = 'pure-opencode-direct-message-stopped-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await svc.stopTeam(teamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      expect((await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).lanes).toEqual({});

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'must not reach stopped pure opencode',
          messageId: 'msg-stopped-pure-opencode',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages while a pure OpenCode stop is in flight', async () => {
      const teamName = 'pure-opencode-direct-message-stop-in-flight-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );
      let releaseStop: () => void = () => undefined;
      const stopRelease = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      adapter.stop = (async (input) => {
        adapter.stopInputs.push(input);
        await stopRelease;
        return {
          runId: input.runId,
          teamName: input.teamName,
          stopped: true,
          members: {},
          warnings: [],
          diagnostics: ['delayed fake stop'],
        };
      }) as typeof adapter.stop;

      const stopPromise = svc.stopTeam(teamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      try {
        await expect(
          svc.deliverOpenCodeMemberMessage(teamName, {
            memberName: 'alice',
            text: 'must not reach pure opencode while stop is in flight',
            messageId: 'msg-pure-opencode-stop-in-flight',
          })
        ).resolves.toMatchObject({
          delivered: false,
          accepted: false,
          responsePending: false,
          responseState: 'not_observed',
          ledgerStatus: 'retry_scheduled',
          laneId: 'primary',
          reason: 'opencode_primary_runtime_not_deliverable',
          diagnostics: ['opencode_primary_runtime_not_deliverable'],
        });
        expect(adapter.messageInputs).toEqual([]);
      } finally {
        releaseStop();
        await stopPromise;
        expect((await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).lanes).toEqual(
          {}
        );
      }
    });

    it('does not deliver direct OpenCode member messages to removed pure OpenCode teammates', async () => {
      const teamName = 'pure-opencode-direct-message-removed-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );
      await writeOpenCodeMembersMeta(teamName, {
        members: ['alice', 'bob'],
        removedMembers: ['alice'],
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'must not reach removed pure alice',
          messageId: 'msg-removed-pure-alice',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      expect(adapter.messageInputs).toEqual([]);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'active pure bob still receives message',
          messageId: 'msg-active-pure-bob',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId: 'primary',
        memberName: 'bob',
        text: 'active pure bob still receives message',
        messageId: 'msg-active-pure-bob',
      });
    });

    it('delivers direct OpenCode member messages to re-added pure OpenCode teammates when meta is active', async () => {
      const teamName = 'pure-opencode-direct-message-readded-safe-e2e';
      await writeOpenCodeTeamConfig({
        teamName,
        projectPath,
        members: ['alice'],
        removedMembers: ['alice'],
      });
      await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 're-added pure alice should receive message',
          messageId: 'msg-readded-pure-alice',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 're-added pure alice should receive message',
        messageId: 'msg-readded-pure-alice',
      });
    });

    it('delivers direct OpenCode member messages to recovered pure lanes with case-insensitive member input after service restart', async () => {
      const teamName = 'pure-opencode-direct-message-case-insensitive-recovered-safe-e2e';
      await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
      await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'ALICE',
          text: 'case-insensitive alice reaches recovered pure lane',
          messageId: 'msg-case-insensitive-recovered-pure-alice',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'alice',
        cwd: projectPath,
        text: 'case-insensitive alice reaches recovered pure lane',
        messageId: 'msg-case-insensitive-recovered-pure-alice',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('does not deliver direct OpenCode member messages when members meta removed a pure teammate but config and lane index are stale active after service restart', async () => {
      const teamName = 'pure-opencode-direct-message-meta-removed-config-stale-safe-e2e';
      await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice', 'bob'] });
      await writeOpenCodeMembersMeta(teamName, {
        members: ['alice', 'bob'],
        removedMembers: ['alice'],
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'active',
        diagnostics: ['stale active primary lane while members meta removed alice'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'meta removed alice must not receive message despite stale active config',
          messageId: 'msg-meta-removed-config-stale-pure-alice',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'active pure bob still receives message despite stale removed sibling',
          messageId: 'msg-meta-removed-config-stale-pure-bob',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'primary',
        memberName: 'bob',
        cwd: projectPath,
        text: 'active pure bob still receives message despite stale removed sibling',
        messageId: 'msg-meta-removed-config-stale-pure-bob',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('does not deliver direct OpenCode member messages to unknown pure OpenCode teammates', async () => {
      const teamName = 'pure-opencode-direct-message-unknown-safe-e2e';
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'ghost',
          text: 'must not reach unknown pure member',
          messageId: 'msg-unknown-pure-opencode',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_is_not_opencode',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages to degraded recovered pure OpenCode primary lanes', async () => {
      const teamName = 'pure-opencode-direct-message-degraded-lane-safe-e2e';
      await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
      await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'must not reach degraded pure opencode lane',
          messageId: 'msg-degraded-pure-opencode',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages to degraded pure OpenCode lanes despite stale terminal provisioning state', async () => {
      const teamName = 'pure-opencode-direct-message-degraded-stale-terminal-safe-e2e';
      await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
      await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'must not reach degraded pure opencode despite stale terminal state',
          messageId: 'msg-degraded-pure-stale-terminal',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages to stopped mixed OpenCode secondary lanes', async () => {
      const teamName = 'mixed-opencode-direct-message-stopped-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run, {
        waitForCompletion: true,
      });
      await waitForCondition(() => adapter.launchInputs.length === 2);

      await svc.stopTeam(teamName);
      await waitForCondition(() => adapter.stopInputs.length === 2);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(async () => {
        const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
        return Object.keys(laneIndex.lanes).length === 0;
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach stopped mixed opencode lane',
          messageId: 'msg-stopped-mixed-opencode',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not scan or deliver orphaned mixed OpenCode lanes after app restart when team is stopped', async () => {
      const teamName = 'mixed-opencode-stopped-orphaned-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
        diagnostics: ['orphaned lane from previous app session'],
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        runId: 'orphaned-opencode-run-bob',
      });
      const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
      await fs.mkdir(inboxDir, { recursive: true });
      await fs.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'bob',
              text: 'must not be delivered while parent team is stopped',
              timestamp: '2026-04-23T10:01:00.000Z',
              read: false,
              messageId: 'msg-stopped-orphaned-lane-bob',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
      });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(restartedService.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(0);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: 'orphaned-opencode-run-bob',
        teamName,
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        reason: 'cleanup',
        force: true,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      await expect(
        restartedService.relayOpenCodeMemberInboxMessages(teamName, 'bob')
      ).resolves.toMatchObject({
        relayed: 0,
        failed: 1,
        lastDelivery: { delivered: false, reason: 'opencode_runtime_not_active' },
      });
      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'direct message must not reach orphaned lane',
          messageId: 'msg-stopped-orphaned-direct-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(adapter.reconcileInputs).toEqual([]);
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not recover missing mixed OpenCode lanes from persisted runtime evidence when parent team is stopped', async () => {
      const teamName = 'mixed-opencode-stopped-missing-lane-recovery-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                runtimePid: 7743,
                runtimeSessionId: 'ses_bob_materialized',
                livenessKind: 'runtime_process_candidate',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending', {
        bob: 'launching',
      });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });
      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not recover stopped parent team',
          messageId: 'msg-stopped-missing-lane-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(adapter.reconcileInputs).toEqual([]);
      expect(adapter.messageInputs).toEqual([]);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('recovers a missing mixed OpenCode lane index from materialized persisted runtime evidence but blocks direct delivery until bootstrap', async () => {
      const teamName = 'mixed-opencode-direct-message-recovers-missing-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob', 'tom'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                runtimePid: 7743,
                runtimeSessionId: 'ses_bob_materialized',
                livenessKind: 'runtime_process_candidate',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              tom: {
                name: 'tom',
                providerId: 'opencode',
                model: 'opencode/nemotron-3-super-free',
                laneId: 'secondary:opencode:tom',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: false,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending', {
        bob: 'launching',
        tom: 'failed',
      });
      await writeAliveProcessRegistry(teamName);
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });
      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'recovered bob receives direct message',
          messageId: 'msg-recovered-missing-lane-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
        diagnostics: [
          'OpenCode runtime bootstrap is not confirmed for bob. Message was saved and will be retried after runtime check-in.',
        ],
      });

      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        reason: 'startup_recovery',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': {
            state: 'active',
          },
        },
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('recovers a missing mixed OpenCode lane index from confirmed-alive persisted runtime evidence before direct delivery', async () => {
      const teamName = 'mixed-opencode-direct-message-recovers-confirmed-missing-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                runtimePid: 7743,
                runtimeSessionId: 'ses_bob_confirmed_materialized',
                livenessKind: 'runtime_process',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
      });
      await writeOpenCodeBootstrapSessionEvidenceForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        runId: null,
        sessionId: 'ses_bob_confirmed_materialized',
      });
      await writeAliveProcessRegistry(teamName);
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });
      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'confirmed alive missing lane recovers',
          messageId: 'msg-recovered-confirmed-missing-lane-bob',
        })
      );

      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        reason: 'startup_recovery',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': {
            state: 'active',
          },
        },
      });
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        text: 'confirmed alive missing lane recovers',
        messageId: 'msg-recovered-confirmed-missing-lane-bob',
      });
    });

    it('recovers a missing mixed OpenCode lane index before watchdog scans unread OpenCode inbox', async () => {
      const teamName = 'mixed-opencode-watchdog-recovers-missing-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob', 'tom'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                runtimePid: 7743,
                runtimeSessionId: 'ses_bob_materialized',
                livenessKind: 'runtime_process_candidate',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              tom: {
                name: 'tom',
                providerId: 'opencode',
                model: 'opencode/nemotron-3-super-free',
                laneId: 'secondary:opencode:tom',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: false,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
      await fs.mkdir(inboxDir, { recursive: true });
      await fs.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'bob',
              text: 'recover this unread OpenCode message',
              timestamp: '2026-04-23T10:01:00.000Z',
              read: false,
              messageId: 'msg-watchdog-recovers-missing-lane-bob',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending', {
        bob: 'launching',
        tom: 'failed',
      });
      await writeAliveProcessRegistry(teamName);
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const scheduledWatchdogJobs: unknown[] = [];
      (restartedService as any).scheduleOpenCodePromptDeliveryWatchdog = (input: unknown): void => {
        scheduledWatchdogJobs.push(input);
      };

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });

      await expect(restartedService.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(1);

      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        reason: 'startup_recovery',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': {
            state: 'active',
          },
        },
      });
      expect(scheduledWatchdogJobs).toEqual([
        expect.objectContaining({
          teamName,
          memberName: 'bob',
          messageId: 'msg-watchdog-recovers-missing-lane-bob',
          delayMs: 500,
        }),
      ]);
    });

    it('recovers a missing mixed OpenCode lane index from committed session evidence before watchdog scans unread inbox', async () => {
      const teamName = 'mixed-opencode-watchdog-recovers-session-evidence-safe-e2e';
      const laneId = 'secondary:opencode:bob';
      const runId = 'session-evidence-opencode-run';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeOpenCodeBootstrapSessionEvidenceForTest({
        teamName,
        laneId,
        runId,
        memberName: 'bob',
        sessionId: 'ses_bob_committed_session_only',
      });
      const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
      await fs.mkdir(inboxDir, { recursive: true });
      await fs.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'bob',
              text: 'recover this unread OpenCode message from committed session evidence',
              timestamp: '2026-04-23T10:01:00.000Z',
              read: false,
              messageId: 'msg-watchdog-recovers-session-evidence-bob',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', { bob: 'confirmed' });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const scheduledWatchdogJobs: unknown[] = [];
      (restartedService as any).scheduleOpenCodePromptDeliveryWatchdog = (input: unknown): void => {
        scheduledWatchdogJobs.push(input);
      };

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });

      await expect(restartedService.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(1);

      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId,
        reason: 'startup_recovery',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            state: 'active',
            diagnostics: expect.arrayContaining([
              'Recovered missing OpenCode runtime lane index from committed session evidence.',
            ]),
          },
        },
      });
      expect(scheduledWatchdogJobs).toEqual([
        expect.objectContaining({
          teamName,
          memberName: 'bob',
          messageId: 'msg-watchdog-recovers-session-evidence-bob',
          delayMs: 500,
        }),
      ]);
    });

    it('does not recover committed OpenCode session evidence when the parent process registry is explicitly stopped', async () => {
      const teamName = 'mixed-opencode-watchdog-stopped-session-evidence-safe-e2e';
      const laneId = 'secondary:opencode:bob';
      const runId = 'stopped-session-evidence-opencode-run';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeOpenCodeBootstrapSessionEvidenceForTest({
        teamName,
        laneId,
        runId,
        memberName: 'bob',
        sessionId: 'ses_bob_stopped_committed_session',
      });
      await writeStoppedProcessRegistry(teamName);
      const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
      await fs.mkdir(inboxDir, { recursive: true });
      await fs.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'bob',
              text: 'must not recover this stopped OpenCode message',
              timestamp: '2026-04-23T10:01:00.000Z',
              read: false,
              messageId: 'msg-watchdog-stopped-session-evidence-bob',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', { bob: 'confirmed' });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(restartedService.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(0);
      expect(adapter.reconcileInputs).toEqual([]);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
    });

    it('recovers one missing mixed OpenCode lane before watchdog scans while sibling lane is active', async () => {
      const teamName = 'mixed-opencode-watchdog-recovers-one-missing-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob', 'tom'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                runtimePid: 7743,
                runtimeSessionId: 'ses_bob_materialized',
                livenessKind: 'runtime_process_candidate',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              tom: {
                name: 'tom',
                providerId: 'opencode',
                model: 'opencode/nemotron-3-super-free',
                laneId: 'secondary:opencode:tom',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                runtimePid: 7750,
                runtimeSessionId: 'ses_tom_active',
                livenessKind: 'runtime_process',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:tom',
      });
      const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
      await fs.mkdir(inboxDir, { recursive: true });
      await fs.writeFile(
        path.join(inboxDir, 'bob.json'),
        `${JSON.stringify(
          [
            {
              from: 'user',
              to: 'bob',
              text: 'recover only bob while tom stays active',
              timestamp: '2026-04-23T10:01:00.000Z',
              read: false,
              messageId: 'msg-watchdog-recovers-one-missing-lane-bob',
            },
          ],
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending', {
        bob: 'launching',
        tom: 'confirmed',
      });
      await writeAliveProcessRegistry(teamName);
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const scheduledWatchdogJobs: unknown[] = [];
      (restartedService as any).scheduleOpenCodePromptDeliveryWatchdog = (input: unknown): void => {
        scheduledWatchdogJobs.push(input);
      };

      await expect(restartedService.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(1);

      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        reason: 'startup_recovery',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': {
            state: 'active',
          },
          'secondary:opencode:tom': {
            state: 'active',
          },
        },
      });
      expect(scheduledWatchdogJobs).toEqual([
        expect.objectContaining({
          teamName,
          memberName: 'bob',
          messageId: 'msg-watchdog-recovers-one-missing-lane-bob',
          delayMs: 500,
        }),
      ]);
    });

    it('does not recover a missing mixed OpenCode lane index from liveness-only persisted metadata', async () => {
      const teamName = 'mixed-opencode-direct-message-liveness-only-missing-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, 'launch-state.json'),
        `${JSON.stringify(
          createPersistedLaunchSnapshot({
            teamName,
            expectedMembers: ['alice', 'bob'],
            leadSessionId: 'lead-session',
            launchPhase: 'reconciled',
            members: {
              alice: {
                name: 'alice',
                providerId: 'codex',
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: 'codex',
                launchState: 'confirmed_alive',
                agentToolAccepted: true,
                runtimeAlive: true,
                bootstrapConfirmed: true,
                hardFailure: false,
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
              bob: {
                name: 'bob',
                providerId: 'opencode',
                model: 'opencode/minimax-m2.5-free',
                laneId: 'secondary:opencode:bob',
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
                launchState: 'failed_to_start',
                agentToolAccepted: true,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'OpenCode bridge reported member launch failure',
                livenessKind: 'runtime_process_candidate',
                pidSource: 'opencode_bridge',
                lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
              },
            },
            updatedAt: '2026-04-23T10:00:00.000Z',
          }),
          null,
          2
        )}\n`,
        'utf8'
      );
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending', {
        bob: 'launching',
      });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not recover from liveness-only stale metadata',
          messageId: 'msg-liveness-only-missing-lane-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(adapter.reconcileInputs).toEqual([]);
      expect(adapter.messageInputs).toEqual([]);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({ lanes: {} });
    });

    it('does not deliver direct OpenCode member messages to one detached mixed lane while its sibling lane stays live', async () => {
      const teamName = 'mixed-opencode-direct-message-one-detached-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        runId: adapter.launchInputs.find((input) => input.laneId === 'secondary:opencode:bob')
          ?.runId,
        teamName,
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach the detached mixed bob lane',
          messageId: 'msg-one-detached-mixed-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'active mixed tom lane still receives direct message',
          messageId: 'msg-one-detached-mixed-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, teamName, 'secondary:opencode:tom'),
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'active mixed tom lane still receives direct message',
        messageId: 'msg-one-detached-mixed-tom',
      });
    });

    it('delivers direct OpenCode member messages to live mixed lanes with case-insensitive member input', async () => {
      const teamName = 'mixed-opencode-direct-message-live-case-insensitive-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'BOB',
          text: 'case-insensitive bob reaches live mixed lane',
          messageId: 'msg-live-case-insensitive-mixed-bob',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, teamName, 'secondary:opencode:bob'),
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'case-insensitive bob reaches live mixed lane',
        messageId: 'msg-live-case-insensitive-mixed-bob',
      });
    });

    it('does not let stale active lane index resurrect direct OpenCode messages to a detached mixed lane', async () => {
      const teamName = 'mixed-opencode-direct-message-detached-stale-index-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
        diagnostics: ['stale active lane index entry'],
      });

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'stale active lane index must not revive detached bob',
          messageId: 'msg-detached-stale-index-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'live tom still receives message despite stale bob index',
          messageId: 'msg-detached-stale-index-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, teamName, 'secondary:opencode:tom'),
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'live tom still receives message despite stale bob index',
        messageId: 'msg-detached-stale-index-tom',
      });
    });

    it('delivers direct OpenCode member messages to a reattached mixed lane after detach rejected stale delivery', async () => {
      const teamName = 'mixed-opencode-direct-message-reattached-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'detached bob must not receive message before reattach',
          messageId: 'msg-detached-before-reattach-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);

      await svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob', { reason: 'member_updated' });

      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name).sort()
      ).toEqual(['bob', 'tom']);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'reattached bob receives direct message',
          messageId: 'msg-reattached-mixed-bob',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, teamName, 'secondary:opencode:bob'),
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'reattached bob receives direct message',
        messageId: 'msg-reattached-mixed-bob',
      });
    });

    it('keeps direct OpenCode member messages scoped when detaching one of two mixed teams with the same member name', async () => {
      const firstTeamName = 'mixed-opencode-direct-detach-cross-team-a-safe-e2e';
      const secondTeamName = 'mixed-opencode-direct-detach-cross-team-b-safe-e2e';
      await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
      await writeTeamMeta(firstTeamName, projectPath);
      await writeMembersMeta(firstTeamName);
      await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
      await writeTeamMeta(secondTeamName, projectPath);
      await writeMembersMeta(secondTeamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = { kill: () => undefined };
      secondRun.child = { kill: () => undefined };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
      await waitForCondition(() => adapter.launchInputs.length === 4);
      await waitForCondition(() =>
        firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(() =>
        secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(secondTeamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        teamName: secondTeamName,
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        firstRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['bob', 'tom']);
      expect(
        secondRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(firstTeamName, {
          memberName: 'bob',
          text: 'first team bob still receives direct message',
          messageId: 'msg-cross-team-detach-first-bob',
        })
      );
      await expect(
        svc.deliverOpenCodeMemberMessage(secondTeamName, {
          memberName: 'bob',
          text: 'second team detached bob must not receive direct message',
          messageId: 'msg-cross-team-detach-second-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(secondTeamName, {
          memberName: 'tom',
          text: 'second team tom still receives direct message',
          messageId: 'msg-cross-team-detach-second-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(2);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, firstTeamName, 'secondary:opencode:bob'),
        teamName: firstTeamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'first team bob still receives direct message',
        messageId: 'msg-cross-team-detach-first-bob',
      });
      expect(adapter.messageInputs[1]).toMatchObject({
        runId: latestOpenCodeLaunchRunId(adapter, secondTeamName, 'secondary:opencode:tom'),
        teamName: secondTeamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'second team tom still receives direct message',
        messageId: 'msg-cross-team-detach-second-tom',
      });
    });

    it('does not deliver direct OpenCode member messages while mixed OpenCode stop is in flight', async () => {
      const teamName = 'mixed-opencode-direct-message-stop-in-flight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined };
      trackLiveRun(svc, run);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(run, {
        waitForCompletion: true,
      });
      await waitForCondition(() => adapter.launchInputs.length === 2);
      let releaseStop: () => void = () => undefined;
      const stopRelease = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      adapter.stop = (async (input) => {
        adapter.stopInputs.push(input);
        await stopRelease;
        return {
          runId: input.runId,
          teamName: input.teamName,
          stopped: true,
          members: {},
          warnings: [],
          diagnostics: ['delayed fake stop'],
        };
      }) as typeof adapter.stop;

      const stopPromise = svc.stopTeam(teamName);
      await waitForCondition(() => adapter.stopInputs.length === 1);
      try {
        await expect(
          svc.deliverOpenCodeMemberMessage(teamName, {
            memberName: 'bob',
            text: 'must not reach mixed opencode while stop is in flight',
            messageId: 'msg-mixed-opencode-stop-in-flight',
          })
        ).resolves.toEqual({
          delivered: false,
          reason: 'opencode_runtime_not_active',
        });
        expect(adapter.messageInputs).toEqual([]);
      } finally {
        releaseStop();
        await stopPromise;
        await waitForCondition(() => adapter.stopInputs.length === 2);
        await waitForCondition(() => !svc.isTeamAlive(teamName));
      }
    });

    it('delivers direct OpenCode member messages to recovered mixed OpenCode secondary lanes after service restart', async () => {
      const teamName = 'mixed-opencode-direct-message-recovered-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'message recovered mixed opencode lane',
          messageId: 'msg-recovered-mixed-opencode',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'message recovered mixed opencode lane',
        messageId: 'msg-recovered-mixed-opencode',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages after recovering a missing mixed lane from committed session evidence', async () => {
      const teamName = 'mixed-opencode-direct-message-committed-session-recovery-safe-e2e';
      const laneId = 'secondary:opencode:bob';
      const runId = 'committed-session-direct-opencode-run';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeOpenCodeBootstrapSessionEvidenceForTest({
        teamName,
        laneId,
        runId,
        memberName: 'bob',
        sessionId: 'ses_bob_direct_committed_session',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', { bob: 'confirmed' });
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'message recovered from committed session evidence',
          messageId: 'msg-recovered-committed-session-mixed-opencode',
        })
      );
      expect(adapter.reconcileInputs).toHaveLength(1);
      expect(adapter.reconcileInputs[0]).toMatchObject({
        teamName,
        laneId,
        reason: 'startup_recovery',
      });
      expect(adapter.reconcileInputs[0]?.runId).toEqual(expect.any(String));
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId,
        teamName,
        laneId,
        memberName: 'bob',
        cwd: projectPath,
        text: 'message recovered from committed session evidence',
        messageId: 'msg-recovered-committed-session-mixed-opencode',
      });
    });

    it('does not deliver direct OpenCode member messages to a removed mixed teammate despite stale active lane index after service restart', async () => {
      const teamName = 'mixed-opencode-direct-message-removed-stale-index-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, removedMembers: ['bob'] });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { removedMembers: ['bob'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
        diagnostics: ['stale removed bob lane index entry'],
      });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:tom',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'removed bob must not receive message despite stale active lane index',
          messageId: 'msg-removed-stale-index-mixed-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'active tom still receives message despite removed bob stale index',
          messageId: 'msg-removed-stale-index-mixed-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'active tom still receives message despite removed bob stale index',
        messageId: 'msg-removed-stale-index-mixed-tom',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('does not deliver direct OpenCode member messages when members meta removed a mixed teammate but config and lane index are stale active after service restart', async () => {
      const teamName = 'mixed-opencode-direct-message-meta-removed-config-stale-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { removedMembers: ['bob'] });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
        diagnostics: ['stale active lane index while members meta removed bob'],
      });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:tom',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'meta removed bob must not receive message despite stale active config',
          messageId: 'msg-meta-removed-config-stale-mixed-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'active tom still receives message despite stale removed sibling',
          messageId: 'msg-meta-removed-config-stale-mixed-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'active tom still receives message despite stale removed sibling',
        messageId: 'msg-meta-removed-config-stale-mixed-tom',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('does not let an orphan active mixed OpenCode lane index entry create a direct message recipient after service restart', async () => {
      const teamName = 'mixed-opencode-direct-message-orphan-lane-index-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:ghost',
        state: 'active',
        diagnostics: ['orphan active lane index entry without roster member'],
      });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:tom',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'ghost',
          text: 'orphan active lane index must not create ghost recipient',
          messageId: 'msg-orphan-lane-index-ghost',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_is_not_opencode',
      });
      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'active tom still receives message despite orphan sibling lane',
          messageId: 'msg-orphan-lane-index-tom',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'active tom still receives message despite orphan sibling lane',
        messageId: 'msg-orphan-lane-index-tom',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages to recovered mixed lanes with case-insensitive member input after service restart', async () => {
      const teamName = 'mixed-opencode-direct-message-case-insensitive-recovered-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'BOB',
          text: 'case-insensitive bob reaches recovered mixed lane',
          messageId: 'msg-case-insensitive-recovered-mixed-bob',
        })
      );

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'case-insensitive bob reaches recovered mixed lane',
        messageId: 'msg-case-insensitive-recovered-mixed-bob',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages after a removed mixed teammate is reattached with a stale active lane index', async () => {
      const teamName = 'mixed-opencode-direct-message-removed-reattached-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, removedMembers: ['bob'] });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { removedMembers: ['bob'] });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
        diagnostics: ['stale active lane index while bob was removed'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'removed bob must not receive message before reattach',
          messageId: 'msg-removed-before-reattach-mixed-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      expect(adapter.messageInputs).toEqual([]);

      await writeMixedTeamConfig({ teamName, projectPath });
      await writeMembersMeta(teamName);

      await expectOpenCodeTrackedPendingDelivery(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'reattached bob receives message after removed state is cleared',
          messageId: 'msg-removed-reattached-mixed-bob',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'reattached bob receives message after removed state is cleared',
        messageId: 'msg-removed-reattached-mixed-bob',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages to recovered mixed OpenCode lanes despite stale terminal provisioning state', async () => {
      const teamName = 'mixed-opencode-direct-message-recovered-stale-terminal-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'message recovered mixed lane despite stale terminal state',
          messageId: 'msg-recovered-mixed-stale-terminal',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'message recovered mixed lane despite stale terminal state',
        messageId: 'msg-recovered-mixed-stale-terminal',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('delivers direct OpenCode member messages to recovered mixed OpenCode lanes when config is missing', async () => {
      const teamName = 'mixed-opencode-direct-message-meta-only-recovered-safe-e2e';
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { memberCwd: projectPath });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName,
        laneId: 'secondary:opencode:bob',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'message mixed opencode recovered from meta only',
          messageId: 'msg-meta-only-mixed-opencode',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 'message mixed opencode recovered from meta only',
        messageId: 'msg-meta-only-mixed-opencode',
      });
      expect(adapter.messageInputs[0]?.runId).toBeUndefined();
    });

    it('keeps recovered mixed OpenCode direct messages isolated across teams with the same member name', async () => {
      const activeTeamName = 'mixed-opencode-direct-message-cross-team-active-safe-e2e';
      const degradedTeamName = 'mixed-opencode-direct-message-cross-team-degraded-safe-e2e';
      const activeProjectPath = path.join(tempDir, 'project-active-mixed');
      const degradedProjectPath = path.join(tempDir, 'project-degraded-mixed');
      await fs.mkdir(activeProjectPath, { recursive: true });
      await fs.mkdir(degradedProjectPath, { recursive: true });
      await writeTeamMeta(activeTeamName, activeProjectPath);
      await writeMembersMeta(activeTeamName, { memberCwd: activeProjectPath });
      await upsertActiveOpenCodeRuntimeLaneForTest({
        teamName: activeTeamName,
        laneId: 'secondary:opencode:bob',
      });
      await writeTeamMeta(degradedTeamName, degradedProjectPath);
      await writeMembersMeta(degradedTeamName, { memberCwd: degradedProjectPath });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName: degradedTeamName,
        laneId: 'secondary:opencode:bob',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(activeTeamName, {
          memberName: 'bob',
          text: 'message only active mixed team',
          messageId: 'msg-cross-team-active-mixed',
        })
      );
      await expect(
        svc.deliverOpenCodeMemberMessage(degradedTeamName, {
          memberName: 'bob',
          text: 'must not reach degraded mixed team',
          messageId: 'msg-cross-team-degraded-mixed',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });

      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        teamName: activeTeamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: activeProjectPath,
        text: 'message only active mixed team',
        messageId: 'msg-cross-team-active-mixed',
      });
    });

    it('does not deliver direct OpenCode member messages to degraded recovered mixed OpenCode lanes', async () => {
      const teamName = 'mixed-opencode-direct-message-degraded-lane-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const restartedService = new TeamProvisioningService();
      restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await expect(
        restartedService.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach degraded mixed opencode lane',
          messageId: 'msg-degraded-mixed-opencode',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages to degraded mixed OpenCode lanes despite stale terminal provisioning state', async () => {
      const teamName = 'mixed-opencode-direct-message-degraded-stale-terminal-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'degraded',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach degraded mixed opencode despite stale terminal state',
          messageId: 'msg-degraded-mixed-stale-terminal',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    });

    it('does not deliver direct OpenCode member messages to removed Anthropic and Gemini mixed teammates', async () => {
      const teamName = 'mixed-anthropic-gemini-direct-message-removed-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      await markMixedOpenCodeLaneConfirmedForTest(run, 'tom');
      trackLiveRun(svc, run);

      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach removed bob',
          messageId: 'msg-removed-bob',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'recipient_removed',
      });
      expect(adapter.messageInputs).toEqual([]);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'tom',
          text: 'active tom still receives direct opencode message',
          messageId: 'msg-active-tom',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: run.runId,
        teamName,
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        cwd: projectPath,
        text: 'active tom still receives direct opencode message',
        messageId: 'msg-active-tom',
      });
    });

    it('delivers direct OpenCode member messages to re-added Anthropic and Gemini mixed teammates when meta is active', async () => {
      const teamName = 'mixed-anthropic-gemini-direct-message-readded-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
        removedMembers: ['bob'],
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      await markMixedOpenCodeLaneConfirmedForTest(run, 'bob');
      trackLiveRun(svc, run);

      await expectOpenCodeTrackedPendingDelivery(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 're-added bob should receive direct opencode message',
          messageId: 'msg-readded-bob',
        })
      );
      expect(adapter.messageInputs).toHaveLength(1);
      expect(adapter.messageInputs[0]).toMatchObject({
        runId: run.runId,
        teamName,
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: projectPath,
        text: 're-added bob should receive direct opencode message',
        messageId: 'msg-readded-bob',
      });
    });

    it('stops the current Anthropic and Gemini mixed run instead of a stale same-team run', async () => {
      const teamName = 'mixed-anthropic-gemini-stop-current-run-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const staleRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(staleRun);
      addGeminiPrimaryToMixedRun(currentRun);
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      let staleKillCount = 0;
      let currentKillCount = 0;
      staleRun.child = createProvisioningChildFixture({
        pid: 64901,
        onDirectKill: () => {
          staleKillCount += 1;
        },
        stdin: { writable: true },
      });
      currentRun.child = createProvisioningChildFixture({
        pid: 64902,
        onDirectKill: () => {
          currentKillCount += 1;
        },
        stdin: { writable: true },
      });
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(currentRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      const killTracker = trackProcessKillsForPids([64901, 64902]);
      try {
        await svc.stopTeam(teamName);

        await waitForCondition(() => adapter.stopInputs.length === 1);
        expectProcessKillCount(killTracker.killedPids, 64901, 0);
        expectProcessKillCount(killTracker.killedPids, 64902, 1);
        expectDirectChildKillCount(staleKillCount, 0);
        expectDirectChildKillCount(currentKillCount, 0);
        expect(staleRun.cancelRequested).toBe(false);
        expect(currentRun.cancelRequested).toBe(true);
        expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
          'secondary:opencode:bob',
        ]);
        expect(await svc.getRuntimeState(teamName)).toMatchObject({
          teamName,
          isAlive: false,
          runId: null,
          progress: null,
        });
      } finally {
        killTracker.restore();
      }
    });

    it('cancels a stale Anthropic and Gemini mixed run without stopping current OpenCode lanes', async () => {
      const teamName = 'mixed-anthropic-gemini-cancel-stale-run-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const staleRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(staleRun);
      addGeminiPrimaryToMixedRun(currentRun);
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      let staleKillCount = 0;
      let currentKillCount = 0;
      staleRun.child = createProvisioningChildFixture({
        pid: 65001,
        onDirectKill: () => {
          staleKillCount += 1;
        },
        stdin: { writable: true },
      });
      currentRun.child = createProvisioningChildFixture({
        pid: 65002,
        onDirectKill: () => {
          currentKillCount += 1;
        },
        stdin: createWritableStdin([]),
      });
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(currentRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      const killTracker = trackProcessKillsForPids([65001, 65002]);
      try {
        await svc.cancelProvisioning(staleRun.runId);

        expectProcessKillCount(killTracker.killedPids, 65001, 1);
        expectProcessKillCount(killTracker.killedPids, 65002, 0);
        expectDirectChildKillCount(staleKillCount, 0);
        expectDirectChildKillCount(currentKillCount, 0);
        expect(staleRun.cancelRequested).toBe(true);
        expect(currentRun.cancelRequested).toBe(false);
        expect(adapter.stopInputs).toEqual([]);
        expect(svc.isTeamAlive(teamName)).toBe(true);
        expect(await svc.getRuntimeState(teamName)).toMatchObject({
          teamName,
          isAlive: true,
          runId: currentRun.runId,
        });

        adapter.releaseLaunches();
        await waitForCondition(() => adapter.launchInputs.length === 2);
        await waitForCondition(() =>
          currentRun.mixedSecondaryLanes.every(
            (lane: { state: string }) => lane.state === 'finished'
          )
        );

        const statuses = await svc.getMemberSpawnStatuses(teamName);
        expect(statuses.teamLaunchState).toBe('clean_success');
        expect(statuses.statuses.reviewer).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
          hardFailure: false,
        });
        expect(statuses.statuses.bob).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
          hardFailure: false,
        });
        expect(statuses.statuses.tom).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
          hardFailure: false,
        });
      } finally {
        killTracker.restore();
      }
    });

    it('stops the current pure Anthropic run instead of a stale same-team run', async () => {
      const teamName = 'pure-anthropic-stop-current-run-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
      const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      let staleKillCount = 0;
      let currentKillCount = 0;
      staleRun.child = createProvisioningChildFixture({
        pid: 63101,
        onDirectKill: () => {
          staleKillCount += 1;
        },
        stdin: { writable: true },
      });
      currentRun.child = createProvisioningChildFixture({
        pid: 63102,
        onDirectKill: () => {
          currentKillCount += 1;
        },
        stdin: { writable: true },
      });
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      expect(await svc.getRuntimeState(teamName)).toMatchObject({
        teamName,
        isAlive: true,
        runId: currentRun.runId,
      });

      const killTracker = trackProcessKillsForPids([63101, 63102]);
      try {
        await svc.stopTeam(teamName);

        expectProcessKillCount(killTracker.killedPids, 63101, 0);
        expectProcessKillCount(killTracker.killedPids, 63102, 1);
        expectDirectChildKillCount(staleKillCount, 0);
        expectDirectChildKillCount(currentKillCount, 0);
        expect(staleRun.cancelRequested).toBe(false);
        expect(currentRun.cancelRequested).toBe(true);
        expect(await svc.getRuntimeState(teamName)).toMatchObject({
          teamName,
          isAlive: false,
          runId: null,
          progress: null,
        });
      } finally {
        killTracker.restore();
      }
    });

    it('cancels a stale pure Anthropic run without stopping the current same-team run', async () => {
      const teamName = 'pure-anthropic-cancel-stale-run-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
      const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      let staleKillCount = 0;
      let currentKillCount = 0;
      staleRun.child = createProvisioningChildFixture({
        pid: 63301,
        onDirectKill: () => {
          staleKillCount += 1;
        },
        stdin: { writable: true },
      });
      currentRun.child = createProvisioningChildFixture({
        pid: 63302,
        onDirectKill: () => {
          currentKillCount += 1;
        },
        stdin: createWritableStdin([]),
      });
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      const killTracker = trackProcessKillsForPids([63301, 63302]);
      try {
        await svc.cancelProvisioning(staleRun.runId);

        expectProcessKillCount(killTracker.killedPids, 63301, 1);
        expectProcessKillCount(killTracker.killedPids, 63302, 0);
        expectDirectChildKillCount(staleKillCount, 0);
        expectDirectChildKillCount(currentKillCount, 0);
        expect(staleRun.cancelRequested).toBe(true);
        expect(currentRun.cancelRequested).toBe(false);
        expect(svc.isTeamAlive(teamName)).toBe(true);
        expect(await svc.getRuntimeState(teamName)).toMatchObject({
          teamName,
          isAlive: true,
          runId: currentRun.runId,
        });

        await svc.sendMessageToTeam(teamName, 'current run still receives messages');
      } finally {
        killTracker.restore();
      }
    });

    it('cancels the current pure Anthropic run without resurrecting a stale same-team run', async () => {
      const teamName = 'pure-anthropic-cancel-current-no-stale-resurrect-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
      const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
      staleRun.runId = `run-${teamName}-stale`;
      currentRun.runId = `run-${teamName}-current`;
      let staleKillCount = 0;
      let currentKillCount = 0;
      staleRun.child = createProvisioningChildFixture({
        pid: 63501,
        onDirectKill: () => {
          staleKillCount += 1;
        },
        stdin: { writable: true },
      });
      currentRun.child = createProvisioningChildFixture({
        pid: 63502,
        onDirectKill: () => {
          currentKillCount += 1;
        },
        stdin: createWritableStdin([]),
      });
      trackLiveRun(svc, staleRun);
      trackLiveRun(svc, currentRun);

      const killTracker = trackProcessKillsForPids([63501, 63502]);
      try {
        await svc.cancelProvisioning(currentRun.runId);

        expectProcessKillCount(killTracker.killedPids, 63501, 0);
        expectProcessKillCount(killTracker.killedPids, 63502, 1);
        expectDirectChildKillCount(staleKillCount, 0);
        expectDirectChildKillCount(currentKillCount, 0);
        expect(staleRun.cancelRequested).toBe(false);
        expect(currentRun.cancelRequested).toBe(true);
        expect(svc.isTeamAlive(teamName)).toBe(false);
        expect(await svc.getRuntimeState(teamName)).toMatchObject({
          teamName,
          isAlive: false,
          runId: null,
          progress: null,
        });
        await expect(svc.sendMessageToTeam(teamName, 'must not hit stale run')).rejects.toThrow(
          `No active process for team "${teamName}"`
        );
      } finally {
        killTracker.restore();
      }
    });

    it('refreshes runtime snapshot cache after same-team pure Anthropic relaunch', async () => {
      const teamName = 'pure-anthropic-runtime-cache-relaunch-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
      staleRun.runId = `run-${teamName}-stale`;
      staleRun.child = { pid: 64101, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, staleRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64102, model: 'haiku-stale' }],
          ['bob', { alive: true, pid: 64103, model: 'sonnet-stale' }],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const staleSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(staleSnapshot).toMatchObject({
        runId: staleRun.runId,
        members: {
          'team-lead': { pid: 64101, rssBytes: 64_101_000 },
          alice: { pid: 64102, rssBytes: 64_102_000, runtimeModel: 'haiku-stale' },
          bob: { pid: 64103, rssBytes: 64_103_000, runtimeModel: 'sonnet-stale' },
        },
      });

      const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
      currentRun.runId = `run-${teamName}-current`;
      currentRun.child = { pid: 64201, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, currentRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64202, model: 'haiku-current' }],
          ['bob', { alive: true, pid: 64203, model: 'sonnet-current' }],
        ]);

      const currentSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(currentSnapshot).toMatchObject({
        runId: currentRun.runId,
        members: {
          'team-lead': { pid: 64201, rssBytes: 64_201_000 },
          alice: { pid: 64202, rssBytes: 64_202_000, runtimeModel: 'haiku-current' },
          bob: { pid: 64203, rssBytes: 64_203_000, runtimeModel: 'sonnet-current' },
        },
      });
    });

    it('does not reuse stopped pure Anthropic runtime cache after relaunch', async () => {
      const teamName = 'pure-anthropic-runtime-cache-stop-relaunch-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName, projectPath });
      firstRun.runId = `run-${teamName}-first`;
      firstRun.child = createProvisioningChildFixture({
        pid: 64501,
        stdin: { writable: true },
      });
      trackLiveRun(svc, firstRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64502, model: 'haiku-before-stop' }],
          ['bob', { alive: true, pid: 64503, model: 'sonnet-before-stop' }],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const beforeStop = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(beforeStop).toMatchObject({
        runId: firstRun.runId,
        members: {
          'team-lead': { pid: 64501, rssBytes: 64_501_000 },
          alice: { pid: 64502, rssBytes: 64_502_000, runtimeModel: 'haiku-before-stop' },
        },
      });

      await svc.stopTeam(teamName);

      const secondRun = createPureAnthropicLiveRun({ teamName, projectPath });
      secondRun.runId = `run-${teamName}-second`;
      secondRun.child = { pid: 64601, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64602, model: 'haiku-after-relaunch' }],
          ['bob', { alive: true, pid: 64603, model: 'sonnet-after-relaunch' }],
        ]);

      const afterRelaunch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterRelaunch).toMatchObject({
        runId: secondRun.runId,
        members: {
          'team-lead': { pid: 64601, rssBytes: 64_601_000 },
          alice: { pid: 64602, rssBytes: 64_602_000, runtimeModel: 'haiku-after-relaunch' },
          bob: { pid: 64603, rssBytes: 64_603_000, runtimeModel: 'sonnet-after-relaunch' },
        },
      });
    });

    it('keeps runtime snapshot on current Anthropic provider while stale Codex relaunch metadata remains', async () => {
      const teamName = 'provider-switch-codex-anthropic-runtime-card-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({ teamName, projectPath });
      firstRun.runId = `run-${teamName}-codex`;
      firstRun.child = { pid: 64611, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      const beforeSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(beforeSwitch).toMatchObject({
        runId: firstRun.runId,
        providerBackendId: 'codex-native',
        members: {
          'team-lead': { runtimeModel: 'gpt-5.4' },
          alice: { providerId: 'codex', runtimeModel: 'gpt-5.4-mini' },
          bob: { providerId: 'opencode', runtimeModel: 'opencode/minimax-m2.5-free' },
        },
      });

      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      secondRun.runId = `run-${teamName}-anthropic`;
      secondRun.request.model = 'haiku';
      secondRun.request.effort = 'low';
      secondRun.launchIdentity = {
        ...secondRun.launchIdentity,
        providerId: 'anthropic',
        providerBackendId: null,
        selectedModel: 'haiku',
        resolvedLaunchModel: 'haiku',
        catalogId: 'haiku',
        selectedEffort: 'low',
        resolvedEffort: 'low',
      };
      secondRun.child = { pid: 64621, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        members: {
          'team-lead': { runtimeModel: 'haiku' },
          alice: { providerId: 'anthropic', runtimeModel: 'haiku' },
          bob: { providerId: 'opencode', runtimeModel: 'opencode/minimax-m2.5-free' },
          tom: { providerId: 'opencode', runtimeModel: 'opencode/nemotron-3-super-free' },
        },
      });
      expect(afterSwitch.providerBackendId).toBeUndefined();
      expect(afterSwitch.members.alice.providerBackendId).toBeUndefined();
    });

    it('ignores stale Codex live metadata model for the current Anthropic provider snapshot', async () => {
      const teamName = 'provider-switch-anthropic-stale-live-codex-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({ teamName, projectPath });
      firstRun.runId = `run-${teamName}-codex`;
      firstRun.child = { pid: 64651, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      const beforeSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(beforeSwitch.members.alice).toMatchObject({
        providerId: 'codex',
        runtimeModel: 'gpt-5.4-mini',
      });

      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      secondRun.runId = `run-${teamName}-anthropic`;
      secondRun.child = { pid: 64661, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64662,
              providerId: 'codex',
              model: 'gpt-5.4-mini',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        members: {
          'team-lead': { runtimeModel: 'sonnet' },
          alice: {
            providerId: 'anthropic',
            runtimeModel: 'haiku',
            pid: 64662,
            rssBytes: 64_662_000,
          },
        },
      });
      expect(afterSwitch.providerBackendId).toBeUndefined();
      expect(afterSwitch.members.alice.providerBackendId).toBeUndefined();
    });

    it('ignores stale Codex live provider evidence even when the live model cannot be inferred', async () => {
      const teamName = 'provider-switch-anthropic-stale-live-codex-unknown-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({ teamName, projectPath });
      firstRun.runId = `run-${teamName}-codex`;
      firstRun.child = { pid: 64711, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      secondRun.runId = `run-${teamName}-anthropic`;
      secondRun.child = { pid: 64721, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64722,
              providerId: 'codex',
              model: 'legacy-enterprise-custom-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        members: {
          alice: {
            providerId: 'anthropic',
            runtimeModel: 'haiku',
            pid: 64722,
            rssBytes: 64_722_000,
          },
        },
      });
      expect(afterSwitch.members.alice.providerBackendId).toBeUndefined();
    });

    it('keeps matching-provider custom live models that cannot be inferred', async () => {
      const teamName = 'provider-switch-anthropic-live-custom-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64731, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64732,
              providerId: 'anthropic',
              model: 'enterprise-custom-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'enterprise-custom-model',
        pid: 64732,
        rssBytes: 64_732_000,
      });
      expect(snapshot.members.alice.providerBackendId).toBeUndefined();
    });

    it('ignores a live Codex model even when stale metadata claims the current Anthropic provider', async () => {
      const teamName = 'provider-switch-anthropic-conflicting-live-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64801, kill: () => undefined, stdin: { writable: true } };
      delete run.effectiveMembers[0].providerId;
      delete run.allEffectiveMembers[0].providerId;
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64802,
              providerId: 'anthropic',
              model: 'gpt-5.4-mini',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
        pid: 64802,
        rssBytes: 64_802_000,
      });
      expect(snapshot.members.alice.providerBackendId).toBeUndefined();
    });

    it('ignores stale Codex live provider evidence for a current OpenCode side-lane unknown model', async () => {
      const teamName = 'provider-switch-opencode-stale-live-codex-unknown-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64761, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              pid: 64762,
              providerId: 'codex',
              model: 'legacy-enterprise-custom-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        runtimeModel: 'opencode/minimax-m2.5-free',
        pid: 64762,
        rssBytes: 64_762_000,
      });
      expect(snapshot.members.bob.providerBackendId).toBeUndefined();
    });

    it('keeps matching OpenCode custom live models that cannot be inferred', async () => {
      const teamName = 'provider-switch-opencode-live-custom-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64771, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob',
            {
              alive: true,
              pid: 64772,
              providerId: 'opencode',
              model: 'local-custom-opencode-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        runtimeModel: 'local-custom-opencode-model',
        pid: 64772,
        rssBytes: 64_772_000,
      });
      expect(snapshot.members.bob.providerBackendId).toBeUndefined();
    });

    it('ignores stale Codex live provider evidence for a current Gemini teammate unknown model', async () => {
      const teamName = 'provider-switch-gemini-stale-live-codex-unknown-model-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64781, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'reviewer',
            {
              alive: true,
              pid: 64782,
              providerId: 'codex',
              model: 'legacy-enterprise-custom-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        runtimeModel: 'gemini-2.5-flash',
        pid: 64782,
        rssBytes: 64_782_000,
      });
      expect(snapshot.members.reviewer.providerBackendId).toBeUndefined();
    });

    it('keeps matching Gemini custom live models that cannot be inferred', async () => {
      const teamName = 'provider-switch-gemini-live-custom-model-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      run.runId = `run-${teamName}-anthropic`;
      run.child = { pid: 64791, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'reviewer',
            {
              alive: true,
              pid: 64792,
              providerId: 'gemini',
              model: 'enterprise-custom-gemini-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.members.reviewer).toMatchObject({
        providerId: 'gemini',
        runtimeModel: 'enterprise-custom-gemini-model',
        pid: 64792,
        rssBytes: 64_792_000,
      });
      expect(snapshot.members.reviewer.providerBackendId).toBeUndefined();
    });

    it('drops stale Codex launch-state backend when the current active run is Anthropic', async () => {
      const teamName = 'provider-switch-anthropic-stale-launch-state-backend-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            name: 'alice',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        },
      });
      const svc = new TeamProvisioningService();

      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      TeamConfigReader.invalidateTeam(teamName);
      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      currentRun.runId = `run-${teamName}-anthropic`;
      currentRun.child = { pid: 64671, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, currentRun);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: currentRun.runId,
        members: {
          alice: {
            providerId: 'anthropic',
            runtimeModel: 'haiku',
          },
        },
      });
      expect(snapshot.providerBackendId).toBeUndefined();
      expect(snapshot.members.alice.providerBackendId).toBeUndefined();
    });

    it('restores Codex backend on current Codex relaunch while stale Anthropic metadata remains', async () => {
      const teamName = 'provider-switch-anthropic-codex-runtime-card-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      firstRun.runId = `run-${teamName}-anthropic`;
      firstRun.child = { pid: 64631, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      const beforeSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(beforeSwitch.runId).toBe(firstRun.runId);
      expect(beforeSwitch.providerBackendId).toBeUndefined();
      expect(beforeSwitch.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });

      await writeMixedTeamConfig({ teamName, projectPath });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({ teamName, projectPath });
      secondRun.runId = `run-${teamName}-codex`;
      secondRun.child = { pid: 64641, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        providerBackendId: 'codex-native',
        members: {
          'team-lead': { runtimeModel: 'gpt-5.4' },
          alice: { providerId: 'codex', runtimeModel: 'gpt-5.4-mini' },
          bob: { providerId: 'opencode', runtimeModel: 'opencode/minimax-m2.5-free' },
          tom: { providerId: 'opencode', runtimeModel: 'opencode/nemotron-3-super-free' },
        },
      });
    });

    it('ignores stale Anthropic live metadata model for the current Codex provider snapshot', async () => {
      const teamName = 'provider-switch-codex-stale-live-anthropic-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      firstRun.runId = `run-${teamName}-anthropic`;
      firstRun.child = { pid: 64681, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      const beforeSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(beforeSwitch.members.alice).toMatchObject({
        providerId: 'anthropic',
        runtimeModel: 'haiku',
      });

      await writeMixedTeamConfig({ teamName, projectPath });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({ teamName, projectPath });
      secondRun.runId = `run-${teamName}-codex`;
      secondRun.child = { pid: 64691, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64692,
              providerId: 'anthropic',
              model: 'haiku',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        providerBackendId: 'codex-native',
        members: {
          'team-lead': { runtimeModel: 'gpt-5.4' },
          alice: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            runtimeModel: 'gpt-5.4-mini',
            pid: 64692,
            rssBytes: 64_692_000,
          },
        },
      });
    });

    it('ignores stale Anthropic live provider evidence with an unknown model for the current Codex snapshot', async () => {
      const teamName = 'provider-switch-codex-stale-live-anthropic-unknown-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();

      const firstRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      firstRun.runId = `run-${teamName}-anthropic`;
      firstRun.child = { pid: 64741, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);

      await writeMixedTeamConfig({ teamName, projectPath });
      TeamConfigReader.invalidateTeam(teamName);
      const secondRun = createMixedLiveRun({ teamName, projectPath });
      secondRun.runId = `run-${teamName}-codex`;
      secondRun.child = { pid: 64751, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64752,
              providerId: 'anthropic',
              model: 'legacy-enterprise-custom-model',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const afterSwitch = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(afterSwitch).toMatchObject({
        runId: secondRun.runId,
        providerBackendId: 'codex-native',
        members: {
          alice: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            runtimeModel: 'gpt-5.4-mini',
            pid: 64752,
            rssBytes: 64_752_000,
          },
        },
      });
    });

    it('ignores a live Anthropic model even when stale metadata claims the current Codex provider', async () => {
      const teamName = 'provider-switch-codex-conflicting-live-model-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const svc = new TeamProvisioningService();

      const run = createMixedLiveRun({ teamName, projectPath });
      run.runId = `run-${teamName}-codex`;
      run.child = { pid: 64811, kill: () => undefined, stdin: { writable: true } };
      delete run.effectiveMembers[0].providerId;
      delete run.allEffectiveMembers[0].providerId;
      trackLiveRun(svc, run);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'alice',
            {
              alive: true,
              pid: 64812,
              providerId: 'codex',
              model: 'haiku',
            },
          ],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot).toMatchObject({
        runId: run.runId,
        providerBackendId: 'codex-native',
        members: {
          alice: {
            providerId: 'codex',
            providerBackendId: 'codex-native',
            runtimeModel: 'gpt-5.4-mini',
            pid: 64812,
            rssBytes: 64_812_000,
          },
        },
      });
    });

    it('refreshes runtime snapshot cache after same-team Anthropic and Gemini mixed relaunch', async () => {
      const teamName = 'mixed-anthropic-gemini-runtime-cache-relaunch-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const svc = new TeamProvisioningService();
      const staleRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(staleRun);
      staleRun.runId = `run-${teamName}-stale`;
      staleRun.child = { pid: 64701, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, staleRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64702, model: 'haiku-stale' }],
          ['reviewer', { alive: true, pid: 64703, model: 'gemini-stale' }],
          ['bob', { alive: true, pid: 64704, model: 'opencode/minimax-stale' }],
          ['tom', { alive: true, pid: 64705, model: 'opencode/nemotron-stale' }],
        ]);
      stubRuntimeUsageStatsByPid(svc);

      const staleSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(staleSnapshot).toMatchObject({
        runId: staleRun.runId,
        members: {
          'team-lead': { pid: 64701, rssBytes: 64_701_000 },
          alice: { pid: 64702, rssBytes: 64_702_000, runtimeModel: 'haiku-stale' },
          reviewer: { pid: 64703, rssBytes: 64_703_000, runtimeModel: 'gemini-stale' },
          bob: { pid: 64704, rssBytes: 64_704_000, runtimeModel: 'opencode/minimax-stale' },
          tom: { pid: 64705, rssBytes: 64_705_000, runtimeModel: 'opencode/nemotron-stale' },
        },
      });

      const currentRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(currentRun);
      currentRun.runId = `run-${teamName}-current`;
      currentRun.child = { pid: 64801, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, currentRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          ['alice', { alive: true, pid: 64802, model: 'haiku-current' }],
          ['reviewer', { alive: true, pid: 64803, model: 'gemini-current' }],
          ['bob', { alive: true, pid: 64804, model: 'opencode/minimax-current' }],
          ['tom', { alive: true, pid: 64805, model: 'opencode/nemotron-current' }],
        ]);

      const currentSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(currentSnapshot).toMatchObject({
        runId: currentRun.runId,
        members: {
          'team-lead': { pid: 64801, rssBytes: 64_801_000 },
          alice: { pid: 64802, rssBytes: 64_802_000, runtimeModel: 'haiku-current' },
          reviewer: { pid: 64803, rssBytes: 64_803_000, runtimeModel: 'gemini-current' },
          bob: { pid: 64804, rssBytes: 64_804_000, runtimeModel: 'opencode/minimax-current' },
          tom: { pid: 64805, rssBytes: 64_805_000, runtimeModel: 'opencode/nemotron-current' },
        },
      });
    });

    it('rejects messages to a stopped pure Anthropic team while another team remains sendable', async () => {
      const stoppedTeamName = 'pure-anthropic-message-stopped-safe-e2e';
      const liveTeamName = 'pure-anthropic-message-live-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
      await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
      await writePureAnthropicMembersMeta(stoppedTeamName);
      await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
      await writePureAnthropicTeamMeta(liveTeamName, projectPath);
      await writePureAnthropicMembersMeta(liveTeamName);
      const svc = new TeamProvisioningService();
      const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
      const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
      stoppedRun.child = { kill: () => undefined, stdin: { writable: true } };
      liveRun.child = { stdin: { writable: true } };
      trackLiveRun(svc, stoppedRun);
      trackLiveRun(svc, liveRun);
      const delivered: Array<{ teamName: string; message: string }> = [];
      (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
        delivered.push({ teamName: run.teamName, message });
      };

      await svc.stopTeam(stoppedTeamName);

      await expect(svc.sendMessageToTeam(stoppedTeamName, 'should not send')).rejects.toThrow(
        `No active process for team "${stoppedTeamName}"`
      );
      await svc.sendMessageToTeam(liveTeamName, 'still alive');

      expect(delivered).toEqual([{ teamName: liveTeamName, message: 'still alive' }]);
      expect(svc.isTeamAlive(stoppedTeamName)).toBe(false);
      expect(svc.isTeamAlive(liveTeamName)).toBe(true);
    });

    it('rejects messages when a pure Anthropic team stdin is not writable without marking it dead', async () => {
      const teamName = 'pure-anthropic-message-stdin-closed-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.child = { stdin: { writable: false } };
      trackLiveRun(svc, run);

      await expect(svc.sendMessageToTeam(teamName, 'will fail')).rejects.toThrow(
        `Team "${teamName}" process stdin is not writable`
      );

      expect(svc.isTeamAlive(teamName)).toBe(true);
      expect(run.cancelRequested).toBe(false);
      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('keeps runtime pid and memory snapshots isolated across two pure Anthropic teams', async () => {
      const firstTeamName = 'pure-anthropic-runtime-snapshot-a-safe-e2e';
      const secondTeamName = 'pure-anthropic-runtime-snapshot-b-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
      await writePureAnthropicTeamMeta(firstTeamName, projectPath);
      await writePureAnthropicMembersMeta(firstTeamName);
      await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
      await writePureAnthropicTeamMeta(secondTeamName, projectPath);
      await writePureAnthropicMembersMeta(secondTeamName);
      const svc = new TeamProvisioningService();
      const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
      firstRun.child = { pid: 50101, kill: () => undefined, stdin: { writable: true } };
      secondRun.child = { pid: 50201, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async (teamName: string) =>
        new Map(
          teamName === firstTeamName
            ? [
                ['alice', { alive: true, pid: 50102, model: 'haiku-runtime' }],
                ['bob', { alive: true, pid: 50103, model: 'sonnet-runtime' }],
              ]
            : [
                ['alice', { alive: true, pid: 50202, model: 'haiku-runtime' }],
                ['bob', { alive: true, pid: 50203, model: 'sonnet-runtime' }],
              ]
        );
      stubRuntimeUsageStatsByPid(svc);

      const firstSnapshot = await svc.getTeamAgentRuntimeSnapshot(firstTeamName);
      const secondSnapshot = await svc.getTeamAgentRuntimeSnapshot(secondTeamName);

      expect(firstSnapshot.members['team-lead']).toMatchObject({
        alive: true,
        pid: 50101,
        rssBytes: 50_101_000,
        runtimeModel: 'sonnet',
      });
      expect(firstSnapshot.members.alice).toMatchObject({
        alive: true,
        pid: 50102,
        rssBytes: 50_102_000,
        providerId: 'anthropic',
        runtimeModel: 'haiku-runtime',
      });
      expect(firstSnapshot.members.bob).toMatchObject({
        alive: true,
        pid: 50103,
        rssBytes: 50_103_000,
        providerId: 'anthropic',
        runtimeModel: 'sonnet-runtime',
      });
      expect(secondSnapshot.members['team-lead']).toMatchObject({
        alive: true,
        pid: 50201,
        rssBytes: 50_201_000,
        runtimeModel: 'sonnet',
      });
      expect(secondSnapshot.members.alice).toMatchObject({
        alive: true,
        pid: 50202,
        rssBytes: 50_202_000,
        providerId: 'anthropic',
        runtimeModel: 'haiku-runtime',
      });
      expect(secondSnapshot.members.bob).toMatchObject({
        alive: true,
        pid: 50203,
        rssBytes: 50_203_000,
        providerId: 'anthropic',
        runtimeModel: 'sonnet-runtime',
      });
    });

    it('clears cached runtime pid and memory after stopping one pure Anthropic team', async () => {
      const stoppedTeamName = 'pure-anthropic-runtime-cache-stopped-safe-e2e';
      const liveTeamName = 'pure-anthropic-runtime-cache-live-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
      await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
      await writePureAnthropicMembersMeta(stoppedTeamName);
      await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
      await writePureAnthropicTeamMeta(liveTeamName, projectPath);
      await writePureAnthropicMembersMeta(liveTeamName);
      const svc = new TeamProvisioningService();
      const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
      const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
      stoppedRun.child = createProvisioningChildFixture({
        pid: 60101,
        stdin: { writable: true },
      });
      liveRun.child = { pid: 60201, kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, stoppedRun);
      trackLiveRun(svc, liveRun);
      (svc as any).getLiveTeamAgentRuntimeMetadata = async (teamName: string) => {
        if (!svc.isTeamAlive(teamName)) {
          return new Map();
        }
        return new Map(
          teamName === stoppedTeamName
            ? [
                ['alice', { alive: true, pid: 60102, model: 'haiku-runtime' }],
                ['bob', { alive: true, pid: 60103, model: 'sonnet-runtime' }],
              ]
            : [
                ['alice', { alive: true, pid: 60202, model: 'haiku-runtime' }],
                ['bob', { alive: true, pid: 60203, model: 'sonnet-runtime' }],
              ]
        );
      };
      stubRuntimeUsageStatsByPid(svc);

      const beforeStop = await svc.getTeamAgentRuntimeSnapshot(stoppedTeamName);
      expect(beforeStop.members['team-lead']).toMatchObject({
        alive: true,
        pid: 60101,
        rssBytes: 60_101_000,
      });

      await svc.stopTeam(stoppedTeamName);

      const stoppedSnapshot = await svc.getTeamAgentRuntimeSnapshot(stoppedTeamName);
      const liveSnapshot = await svc.getTeamAgentRuntimeSnapshot(liveTeamName);
      expect(stoppedSnapshot.members['team-lead']).toMatchObject({ alive: false });
      expect(stoppedSnapshot.members['team-lead']?.pid).toBeUndefined();
      expect(stoppedSnapshot.members.alice).toMatchObject({ alive: false });
      expect(stoppedSnapshot.members.alice?.pid).toBeUndefined();
      expect(liveSnapshot.members['team-lead']).toMatchObject({
        alive: true,
        pid: 60201,
        rssBytes: 60_201_000,
      });
      expect(liveSnapshot.members.alice).toMatchObject({
        alive: true,
        pid: 60202,
        rssBytes: 60_202_000,
      });
    });

    it('reports lead activity as active for a live team and offline after stop', async () => {
      const teamName = 'pure-anthropic-lead-activity-stop-safe-e2e';
      await writePureAnthropicTeamConfig({ teamName, projectPath });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.child = { kill: () => undefined, stdin: { writable: true } };
      trackLiveRun(svc, run);

      expect(svc.getLeadActivityState(teamName)).toEqual({
        state: 'active',
        runId: run.runId,
      });

      svc.stopTeam(teamName);

      expect(svc.getLeadActivityState(teamName)).toEqual({
        state: 'offline',
        runId: null,
      });
    });

    it('treats a suffixed registered live agent as the expected teammate during launch audit', async () => {
      const teamName = 'agent-audit-suffixed-registered-safe-e2e';
      await writePureAnthropicTeamConfigWithMembers({
        teamName,
        projectPath,
        members: ['alice', 'bob-2'],
      });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'spawning',
        launchState: 'starting',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: new Date().toISOString(),
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
        new Map([
          [
            'bob-2',
            {
              alive: true,
              model: 'sonnet',
            },
          ],
        ]);

      await (svc as any).auditMemberSpawnStatuses(run);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        livenessSource: 'process',
        hardFailure: false,
      });
    });

    it('does not finalize a suffixed registered agent as missing during launch finalization', async () => {
      const teamName = 'agent-finalize-suffixed-registered-safe-e2e';
      await writePureAnthropicTeamConfigWithMembers({
        teamName,
        projectPath,
        members: ['alice', 'bob-2'],
      });
      await writePureAnthropicTeamMeta(teamName, projectPath);
      await writePureAnthropicMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createPureAnthropicLiveRun({ teamName, projectPath });
      run.expectedMembers = ['alice', 'bob'];
      run.memberSpawnStatuses.set('bob', {
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).finalizeMissingRegisteredMembersAsFailed(run);

      expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        hardFailure: false,
      });
    });

    it('keeps OpenCode secondary lanes online when the primary Codex member failed to spawn', async () => {
      const teamName = 'mixed-primary-failure-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Codex native runtime unavailable',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Codex native runtime unavailable',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('keeps OpenCode secondary lanes online when the primary Anthropic member failed to spawn', async () => {
      const teamName = 'mixed-anthropic-primary-failure-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        failedCount: 1,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: false,
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('keeps OpenCode secondary lanes online when Anthropic and Gemini primary members both failed', async () => {
      const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-ready-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [
        ...(run.effectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      run.allEffectiveMembers = [
        ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
      );
      await waitForCondition(
        () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
      );

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 2,
        failedCount: 2,
      });
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('detaches one OpenCode secondary lane after Anthropic and Gemini primary members both failed', async () => {
      const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-detach-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [
        ...(run.effectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      run.allEffectiveMembers = [
        ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'tom']);
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('restarts one OpenCode secondary lane after Anthropic and Gemini primary members both failed', async () => {
      const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-restart-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [
        ...(run.effectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      run.allEffectiveMembers = [
        ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      trackLiveRun(svc, run);
      run.memberSpawnStatuses.set('alice', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });
      run.memberSpawnStatuses.set('reviewer', {
        status: 'error',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
      });

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      adapter.setLaunchResult('partial_pending', { bob: 'permission' });

      await svc.restartMember(teamName, 'bob');

      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'relaunch',
      });
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Anthropic pane exited before bootstrap',
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'Gemini pane failed to start',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('fails mixed OpenCode secondary lanes clearly when the runtime adapter is not registered', async () => {
      const teamName = 'mixed-missing-opencode-adapter-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const svc = new TeamProvisioningService();
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(snapshot).toMatchObject({
        teamName,
        teamLaunchState: 'partial_failure',
      });
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'finished',
        'finished',
      ]);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'opencode_runtime_adapter_missing',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'opencode_runtime_adapter_missing',
      });
    });

    it('keeps Anthropic primary online when OpenCode secondary adapter is not registered', async () => {
      const teamName = 'mixed-anthropic-missing-opencode-adapter-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const svc = new TeamProvisioningService();
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(snapshot).toMatchObject({
        teamName,
        teamLaunchState: 'partial_failure',
      });
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'finished',
        'finished',
      ]);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'opencode_runtime_adapter_missing',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'opencode_runtime_adapter_missing',
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        alive: true,
        runtimeModel: 'haiku',
      });
    });

    it('restarts one mixed OpenCode secondary lane without touching other live teammates', async () => {
      const teamName = 'mixed-opencode-manual-restart-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      adapter.setLaunchResult('partial_pending', { bob: 'permission' });

      await svc.restartMember(teamName, 'bob');

      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'relaunch',
      });
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('restarts one Anthropic mixed OpenCode secondary lane without touching other live teammates', async () => {
      const teamName = 'mixed-anthropic-opencode-manual-restart-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      adapter.setLaunchResult('partial_pending', { bob: 'permission' });

      await svc.restartMember(teamName, 'bob');

      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'relaunch',
      });
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        providerId: 'anthropic',
        laneKind: 'primary',
        runtimeModel: 'haiku',
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        runtimeModel: 'opencode/minimax-m2.5-free',
      });
      expect(runtimeSnapshot.members.tom).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        runtimeModel: 'opencode/nemotron-3-super-free',
      });
    });

    it('restarts only the targeted mixed OpenCode secondary lane when two teams share member names', async () => {
      const firstTeamName = 'mixed-opencode-restart-cross-team-a-safe-e2e';
      const secondTeamName = 'mixed-opencode-restart-cross-team-b-safe-e2e';
      await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
      await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
      await waitForCondition(() => adapter.launchInputs.length === 4);
      await waitForCondition(() =>
        firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(() =>
        secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      adapter.setLaunchResult('partial_pending', { bob: 'permission' });

      await svc.restartMember(secondTeamName, 'bob');

      await waitForCondition(() => adapter.launchInputs.length === 5);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        teamName: secondTeamName,
        laneId: 'secondary:opencode:bob',
        reason: 'relaunch',
      });
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        teamName: secondTeamName,
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });

      const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
      const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
      expect(firstStatuses.teamLaunchState).toBe('clean_success');
      expect(firstStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(secondStatuses.teamLaunchState).toBe('partial_pending');
      expect(secondStatuses.statuses.bob).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-bob'],
        hardFailure: false,
      });
      expect(secondStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('detaches one mixed OpenCode secondary lane and keeps remaining teammates launchable', async () => {
      const teamName = 'mixed-opencode-detach-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('detaches only the targeted mixed OpenCode secondary lane when two teams share member names', async () => {
      const firstTeamName = 'mixed-opencode-detach-cross-team-a-safe-e2e';
      const secondTeamName = 'mixed-opencode-detach-cross-team-b-safe-e2e';
      await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
      await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
      const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
      trackLiveRun(svc, firstRun);
      trackLiveRun(svc, secondRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
      await waitForCondition(() => adapter.launchInputs.length === 4);
      await waitForCondition(() =>
        firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      await waitForCondition(() =>
        secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(secondTeamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        teamName: secondTeamName,
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        firstRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['bob', 'tom']);
      expect(
        secondRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);

      const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
      const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
      expect(firstStatuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
      expect(firstStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(secondStatuses.expectedMembers).toEqual(['alice', 'tom']);
      expect(secondStatuses.statuses.bob).toBeUndefined();
      expect(secondStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('detaches one Anthropic mixed OpenCode secondary lane and keeps remaining teammates launchable', async () => {
      const teamName = 'mixed-anthropic-opencode-detach-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'cleanup',
      });
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['tom']);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
      expect(statuses.statuses.bob).toBeUndefined();
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('reattaches a newly added mixed OpenCode teammate without relaunching existing lanes', async () => {
      const teamName = 'mixed-opencode-add-member-reattach-safe-e2e';
      const eve = {
        name: 'eve',
        providerId: 'opencode' as const,
        model: 'opencode/big-pickle',
      };
      await writeMixedTeamConfig({ teamName, projectPath, extraMembers: [eve] });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { extraMembers: [eve] });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
        eve: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.reattachOpenCodeOwnedMemberLane(teamName, 'eve', { reason: 'member_added' });

      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(adapter.stopInputs).toHaveLength(0);
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:eve',
        expectedMembers: [expect.objectContaining({ name: 'eve', providerId: 'opencode' })],
      });
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name).sort()
      ).toEqual(['bob', 'eve', 'tom']);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).toEqual(
        expect.arrayContaining(['alice', 'bob', 'tom', 'eve'])
      );
      expect(statuses.statuses.eve).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.eve).toMatchObject({
        providerId: 'opencode',
        laneId: 'secondary:opencode:eve',
        laneKind: 'secondary',
        runtimeModel: 'opencode/big-pickle',
      });
    });

    it('fresh relaunches a failed mixed OpenCode teammate without runtime evidence', async () => {
      const teamName = 'mixed-opencode-fresh-relaunch-no-runtime-evidence-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.mixedSecondaryLanes = run.mixedSecondaryLanes.filter(
        (lane: { member: { name: string } }) => lane.member.name !== 'bob'
      );
      run.memberSpawnStatuses.set('bob', {
        status: 'error',
        launchState: 'failed_to_start',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'File lock timeout: lanes.json',
        error: 'File lock timeout: lanes.json',
        agentToolAccepted: false,
        updatedAt: '2026-04-24T12:00:00.000Z',
      } as never);
      trackLiveRun(svc, run);

      await svc.restartMember(teamName, 'bob');

      await waitForCondition(() => adapter.launchInputs.length === 1);
      expect(adapter.stopInputs).toHaveLength(0);
      expect(adapter.launchInputs[0]).toMatchObject({
        teamName,
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });
      const bobLane = run.mixedSecondaryLanes.find(
        (lane: { member: { name: string } }) => lane.member.name === 'bob'
      );
      expect(bobLane).toMatchObject({
        laneId: 'secondary:opencode:bob',
        diagnostics: expect.arrayContaining([
          'controlled_reattach:manual_restart',
          'fresh_relaunch:no_runtime_evidence',
        ]),
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects duplicate fresh relaunch while a mixed OpenCode lane is queued', async () => {
      const teamName = 'mixed-opencode-fresh-relaunch-queued-reject-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'Restart for teammate "bob" is already in progress'
      );

      expect(adapter.launchInputs).toHaveLength(0);
      expect(adapter.stopInputs).toHaveLength(0);
      expect(
        run.mixedSecondaryLanes.find(
          (lane: { member: { name: string } }) => lane.member.name === 'bob'
        )
      ).toMatchObject({
        state: 'queued',
      });
    });

    it('reattaches an existing mixed OpenCode teammate after member update without changing siblings', async () => {
      const teamName = 'mixed-opencode-update-member-reattach-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob', { reason: 'member_updated' });

      await waitForCondition(() => adapter.launchInputs.length === 3);
      expect(adapter.stopInputs).toHaveLength(1);
      expect(adapter.stopInputs[0]).toMatchObject({
        laneId: 'secondary:opencode:bob',
        reason: 'relaunch',
      });
      expect(adapter.launchInputs.at(-1)).toMatchObject({
        laneId: 'secondary:opencode:bob',
        expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects controlled OpenCode reattach for a primary-runtime teammate without dispatching lanes', async () => {
      const teamName = 'mixed-opencode-reattach-primary-reject-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.reattachOpenCodeOwnedMemberLane(teamName, 'alice')).rejects.toThrow(
        'Controlled reattach is only supported for OpenCode-owned members'
      );

      expect(adapter.launchInputs).toHaveLength(0);
      expect(adapter.stopInputs).toHaveLength(0);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('rejects controlled OpenCode reattach for a removed teammate without launching a stale lane', async () => {
      const teamName = 'mixed-opencode-reattach-removed-reject-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { removedMembers: ['bob'] });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob')).rejects.toThrow(
        'Member "bob" has been removed'
      );

      expect(adapter.launchInputs).toHaveLength(0);
      expect(adapter.stopInputs).toHaveLength(0);
      expect(
        run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
      ).toEqual(['bob', 'tom']);
    });

    it('rejects mixed OpenCode secondary restart when the runtime adapter is missing', async () => {
      const teamName = 'mixed-opencode-restart-missing-adapter-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      const svc = new TeamProvisioningService();
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
        'OpenCode runtime adapter is not available for controlled lane reattach.'
      );

      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'queued',
        'queued',
      ]);
      expect(run.pendingMemberRestarts.has('bob')).toBe(false);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('bob')).toBeUndefined();
    });

    it('detaches a stale mixed OpenCode teammate that no longer has a runtime lane', async () => {
      const teamName = 'mixed-opencode-detach-stale-member-safe-e2e';
      const eve = {
        name: 'eve',
        providerId: 'opencode' as const,
        model: 'opencode/big-pickle',
      };
      await writeMixedTeamConfig({ teamName, projectPath, extraMembers: [eve] });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName, { extraMembers: [eve] });
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      run.allEffectiveMembers.push({
        name: 'eve',
        role: 'Developer',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      });
      run.request.members = run.allEffectiveMembers;
      trackLiveRun(svc, run);

      await svc.detachOpenCodeOwnedMemberLane(teamName, 'eve');

      expect(adapter.stopInputs).toHaveLength(0);
      expect(run.allEffectiveMembers.map((member: { name: string }) => member.name)).not.toContain(
        'eve'
      );
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).not.toContain('eve');
      expect(statuses.statuses.eve).toBeUndefined();
      expect(statuses.statuses.bob).toBeDefined();
      expect(statuses.statuses.tom).toBeDefined();
    });

    it('shows mixed OpenCode secondary lanes as spawning while runtime adapter launch is in flight', async () => {
      const teamName = 'mixed-live-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(initialSnapshot.teamLaunchState).toBe('partial_pending');
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      const inFlightStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(inFlightStatuses.teamLaunchState).toBe('partial_pending');
      expect(inFlightStatuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 2,
        failedCount: 0,
      });
      expect(inFlightStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(inFlightStatuses.statuses.bob).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });
      expect(inFlightStatuses.statuses.tom).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });

      adapter.releaseLaunches();

      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      const finalStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(finalStatuses.teamLaunchState).toBe('clean_success');
      expect(finalStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(finalStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('shows Anthropic mixed OpenCode secondary lanes as spawning while runtime adapter launch is in flight', async () => {
      const teamName = 'mixed-anthropic-live-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(initialSnapshot.teamLaunchState).toBe('partial_pending');
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      const inFlightStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(inFlightStatuses.teamLaunchState).toBe('partial_pending');
      expect(inFlightStatuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 2,
        failedCount: 0,
      });
      expect(inFlightStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(inFlightStatuses.statuses.bob).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });
      expect(inFlightStatuses.statuses.tom).toMatchObject({
        status: 'spawning',
        launchState: 'starting',
        hardFailure: false,
      });

      adapter.releaseLaunches();

      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );
      const finalStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(finalStatuses.teamLaunchState).toBe('clean_success');
      expect(finalStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(finalStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(finalStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('does not double-dispatch mixed OpenCode secondary lanes when launch handoff is retried in flight', async () => {
      const teamName = 'mixed-retry-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstLaneRunIds = run.mixedSecondaryLanes.map(
        (lane: { runId: string | null }) => lane.runId
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(adapter.pendingLaunchInputs).toHaveLength(1);
      expect(adapter.launchInputs).toHaveLength(0);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'launching',
        'queued',
      ]);
      expect(run.mixedSecondaryLanes.map((lane: { runId: string | null }) => lane.runId)).toEqual(
        firstLaneRunIds
      );

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(adapter.launchInputs).toHaveLength(2);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('does not double-dispatch Anthropic mixed OpenCode secondary lanes when launch handoff is retried in flight', async () => {
      const teamName = 'mixed-anthropic-retry-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
      const firstLaneRunIds = run.mixedSecondaryLanes.map(
        (lane: { runId: string | null }) => lane.runId
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(adapter.pendingLaunchInputs).toHaveLength(1);
      expect(adapter.launchInputs).toHaveLength(0);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'launching',
        'queued',
      ]);
      expect(run.mixedSecondaryLanes.map((lane: { runId: string | null }) => lane.runId)).toEqual(
        firstLaneRunIds
      );

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 2);
      await waitForCondition(() =>
        run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(adapter.launchInputs).toHaveLength(2);
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
    });

    it('does not dispatch mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
      const teamName = 'mixed-cancel-before-handoff-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);
      run.cancelRequested = true;
      run.processKilled = true;

      const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(snapshot).toBeNull();
      expect(adapter.pendingLaunchInputs).toHaveLength(0);
      expect(adapter.launchInputs).toHaveLength(0);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'queued',
        'queued',
      ]);
    });

    it('does not dispatch Anthropic mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
      const teamName = 'mixed-anthropic-cancel-before-handoff-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);
      run.cancelRequested = true;
      run.processKilled = true;

      const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(snapshot).toBeNull();
      expect(adapter.pendingLaunchInputs).toHaveLength(0);
      expect(adapter.launchInputs).toHaveLength(0);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'queued',
        'queued',
      ]);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('does not dispatch Anthropic and Gemini mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
      const teamName = 'mixed-anthropic-gemini-cancel-before-handoff-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      trackLiveRun(svc, run);
      run.cancelRequested = true;
      run.processKilled = true;

      const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

      expect(snapshot).toBeNull();
      expect(adapter.pendingLaunchInputs).toHaveLength(0);
      expect(adapter.launchInputs).toHaveLength(0);
      expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
        'queued',
        'queued',
      ]);
      expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(run.memberSpawnStatuses.get('reviewer')).toMatchObject({
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('does not resurrect a stopped mixed launch when in-flight OpenCode lanes finish late', async () => {
      const teamName = 'mixed-stop-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);

      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('does not resurrect a stopped Anthropic mixed launch when in-flight OpenCode lanes finish late', async () => {
      const teamName = 'mixed-anthropic-stop-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);

      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('does not resurrect a stopped Anthropic and Gemini mixed launch when in-flight OpenCode lanes finish late', async () => {
      const teamName = 'mixed-anthropic-gemini-stop-inflight-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [
        ...(run.effectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      run.allEffectiveMembers = [
        ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
        {
          name: 'reviewer',
          role: 'Reviewer',
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
        },
      ];
      run.memberSpawnStatuses.set('reviewer', {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
        lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
        livenessSource: 'heartbeat',
      });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);

      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(svc.isTeamAlive(teamName)).toBe(false);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('stops one mixed in-flight launch without stopping another mixed team', async () => {
      const stoppedTeamName = 'mixed-stop-one-of-two-inflight-safe-e2e';
      const survivingTeamName = 'mixed-survives-other-stop-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName: stoppedTeamName, projectPath });
      await writeTeamMeta(stoppedTeamName, projectPath);
      await writeMembersMeta(stoppedTeamName);
      await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
      await writeTeamMeta(survivingTeamName, projectPath);
      await writeMembersMeta(survivingTeamName);
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const stoppedRun = createMixedLiveRun({ teamName: stoppedTeamName, projectPath });
      const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
      stoppedRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, stoppedRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(stoppedRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() =>
        adapter.pendingLaunchInputs.some((input) => input.teamName === stoppedTeamName)
      );

      svc.stopTeam(stoppedTeamName);

      await waitForCondition(
        () => adapter.stopInputs.filter((input) => input.teamName === stoppedTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
      expect(svc.isTeamAlive(stoppedTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const stoppedStatuses = await svc.getMemberSpawnStatuses(stoppedTeamName);
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(stoppedStatuses.teamLaunchState).not.toBe('clean_success');
      expect(stoppedStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(stoppedStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('does not let a stopped run late result overwrite newer mixed launch truth', async () => {
      const teamName = 'mixed-late-old-result-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const oldRun = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, oldRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'codex',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['new-perm-bob'],
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'new run explicit failure',
          }),
        },
      });

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['new-perm-bob'],
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailureReason: 'new run explicit failure',
      });
    });

    it('does not let a stopped Anthropic run late result overwrite newer mixed launch truth', async () => {
      const teamName = 'mixed-anthropic-late-old-result-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const oldRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, oldRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['new-perm-bob'],
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'new Anthropic run explicit failure',
          }),
        },
      });

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['new-perm-bob'],
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailureReason: 'new Anthropic run explicit failure',
      });
    });

    it('does not let a stopped Anthropic and Gemini run late result overwrite newer mixed launch truth', async () => {
      const teamName = 'mixed-anthropic-gemini-late-old-result-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const oldRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const reviewer = {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      };
      oldRun.expectedMembers = ['alice', 'reviewer'];
      oldRun.effectiveMembers = [...oldRun.effectiveMembers, reviewer];
      oldRun.allEffectiveMembers = [
        ...oldRun.effectiveMembers,
        ...oldRun.allEffectiveMembers.filter(
          (member: { providerId?: string }) => member.providerId === 'opencode'
        ),
      ];
      oldRun.memberSpawnStatuses.set('reviewer', {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
        lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
        livenessSource: 'heartbeat',
      });
      trackLiveRun(svc, oldRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      await writeMixedTeamLaunchState({
        teamName,
        members: {
          alice: mixedMemberState({
            providerId: 'anthropic',
            model: 'haiku',
            laneId: 'primary',
            laneKind: 'primary',
            laneOwnerProviderId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          reviewer: mixedMemberState({
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            laneId: 'primary:gemini:reviewer',
            laneKind: 'primary',
            laneOwnerProviderId: 'gemini',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
          bob: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'runtime_pending_permission',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            pendingPermissionRequestIds: ['new-perm-bob'],
          }),
          tom: mixedMemberState({
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            laneId: 'secondary:opencode:tom',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'new Anthropic and Gemini run explicit failure',
          }),
        },
      });

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['new-perm-bob'],
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailureReason: 'new Anthropic and Gemini run explicit failure',
      });
    });

    it('does not degrade stopped mixed launch lanes when in-flight OpenCode launch errors late', async () => {
      const teamName = 'mixed-stop-late-error-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter('late fake bridge failure');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('does not degrade stopped Anthropic mixed launch lanes when in-flight OpenCode launch errors late', async () => {
      const teamName = 'mixed-anthropic-stop-late-error-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake Anthropic bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('does not degrade stopped Anthropic and Gemini mixed launch lanes when in-flight OpenCode launch errors late', async () => {
      const teamName = 'mixed-anthropic-gemini-stop-late-error-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake Anthropic and Gemini bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const reviewer = {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      };
      run.expectedMembers = ['alice', 'reviewer'];
      run.effectiveMembers = [...run.effectiveMembers, reviewer];
      run.allEffectiveMembers = [
        ...run.effectiveMembers,
        ...run.allEffectiveMembers.filter(
          (member: { providerId?: string }) => member.providerId === 'opencode'
        ),
      ];
      run.memberSpawnStatuses.set('reviewer', {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
        lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
        lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:00:00.000Z',
        livenessSource: 'heartbeat',
      });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      svc.stopTeam(teamName);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('stops mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
      const teamName = 'mixed-cancel-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('stops Anthropic mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
      const teamName = 'mixed-anthropic-cancel-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('stops Anthropic and Gemini mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
      const teamName = 'mixed-anthropic-gemini-cancel-inflight-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('clean_success');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    });

    it('allows fresh Anthropic and Gemini mixed OpenCode lanes after cancel cancelled in-flight handoff', async () => {
      const teamName = 'mixed-anthropic-gemini-fresh-after-cancelled-handoff-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(cancelledRun);
      trackLiveRun(svc, cancelledRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(() => adapter.stopInputs.length === 1);
      expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
      ]);
      expect(svc.isTeamAlive(teamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 1);

      const cancelledStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
      expect(cancelledStatuses.statuses.alice).toMatchObject({ hardFailure: false });
      expect(cancelledStatuses.statuses.reviewer).toMatchObject({ hardFailure: false });
      expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');

      const freshRun = createMixedLiveRun({
        teamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      freshRun.runId = `${cancelledRun.runId}-fresh`;
      freshRun.detectedSessionId = 'lead-session-fresh';
      addGeminiPrimaryToMixedRun(freshRun);
      trackLiveRun(svc, freshRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const freshStatuses = await svc.getMemberSpawnStatuses(teamName);
      expect(freshStatuses.teamLaunchState).toBe('clean_success');
      expect(freshStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(freshStatuses.statuses.reviewer).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(freshStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(freshStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('cancels one mixed in-flight launch without cancelling another mixed team', async () => {
      const cancelledTeamName = 'mixed-cancel-one-of-two-inflight-safe-e2e';
      const survivingTeamName = 'mixed-survives-other-cancel-inflight-safe-e2e';
      await writeMixedTeamConfig({ teamName: cancelledTeamName, projectPath });
      await writeTeamMeta(cancelledTeamName, projectPath);
      await writeMembersMeta(cancelledTeamName);
      await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
      await writeTeamMeta(survivingTeamName, projectPath);
      await writeMembersMeta(survivingTeamName);
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
      const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() =>
        adapter.pendingLaunchInputs.some((input) => input.teamName === cancelledTeamName)
      );

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
      expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('cancels one Anthropic and Gemini mixed in-flight launch without cancelling another mixed team', async () => {
      const cancelledTeamName = 'mixed-anthropic-gemini-cancel-one-inflight-safe-e2e';
      const survivingTeamName = 'mixed-anthropic-gemini-survives-cancel-safe-e2e';
      await writeMixedTeamConfig({
        teamName: cancelledTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(cancelledTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: survivingTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(survivingTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const survivingRun = createMixedLiveRun({
        teamName: survivingTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(cancelledRun);
      addGeminiPrimaryToMixedRun(survivingRun);
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
      expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
      expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
      expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
      expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.reviewer).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('allows a cancelled mixed team to relaunch OpenCode secondary lanes without disturbing its surviving sibling', async () => {
      const cancelledTeamName = 'mixed-cancel-one-then-relaunch-safe-e2e';
      const survivingTeamName = 'mixed-survives-cancel-while-sibling-relaunches-safe-e2e';
      await writeMixedTeamConfig({ teamName: cancelledTeamName, projectPath });
      await writeTeamMeta(cancelledTeamName, projectPath);
      await writeMembersMeta(cancelledTeamName);
      await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
      await writeTeamMeta(survivingTeamName, projectPath);
      await writeMembersMeta(survivingTeamName);
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
      const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const freshRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
      freshRun.runId = `${cancelledRun.runId}-fresh`;
      freshRun.detectedSessionId = 'lead-session-fresh';
      freshRun.child = { kill: () => undefined };
      trackLiveRun(svc, freshRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
      await waitForCondition(() => adapter.launchInputs.length === 5);
      await waitForCondition(() =>
        freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const relaunchedStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
      expect(relaunchedStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(relaunchedStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('allows a cancelled Anthropic and Gemini mixed team to relaunch while its sibling stays online', async () => {
      const cancelledTeamName = 'mixed-anthropic-gemini-cancel-one-then-relaunch-safe-e2e';
      const survivingTeamName = 'mixed-anthropic-gemini-survives-sibling-relaunch-safe-e2e';
      await writeMixedTeamConfig({
        teamName: cancelledTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(cancelledTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeMixedTeamConfig({
        teamName: survivingTeamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(survivingTeamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const cancelledRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      const survivingRun = createMixedLiveRun({
        teamName: survivingTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      addGeminiPrimaryToMixedRun(cancelledRun);
      addGeminiPrimaryToMixedRun(survivingRun);
      cancelledRun.child = { kill: () => undefined };
      survivingRun.child = { kill: () => undefined };
      trackLiveRun(svc, cancelledRun);
      trackLiveRun(svc, survivingRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
      await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

      await svc.cancelProvisioning(cancelledRun.runId);

      await waitForCondition(
        () =>
          adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 1
      );
      expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.launchInputs.length === 3);
      await waitForCondition(() =>
        survivingRun.mixedSecondaryLanes.every(
          (lane: { state: string }) => lane.state === 'finished'
        )
      );

      const freshRun = createMixedLiveRun({
        teamName: cancelledTeamName,
        projectPath,
        primaryProviderId: 'anthropic',
      });
      freshRun.runId = `${cancelledRun.runId}-fresh`;
      freshRun.detectedSessionId = 'lead-session-fresh';
      freshRun.child = { kill: () => undefined };
      addGeminiPrimaryToMixedRun(freshRun);
      trackLiveRun(svc, freshRun);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
      await waitForCondition(() => adapter.launchInputs.length === 5);
      await waitForCondition(() =>
        freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
      );

      const relaunchedStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
      const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
      expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
      expect(relaunchedStatuses.statuses.reviewer).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(relaunchedStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(relaunchedStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.teamLaunchState).toBe('clean_success');
      expect(survivingStatuses.statuses.reviewer).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(survivingStatuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
    });

    it('does not degrade mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
      const teamName = 'mixed-cancel-late-error-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake cancel bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('does not degrade Anthropic mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
      const teamName = 'mixed-anthropic-cancel-late-error-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake Anthropic cancel bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('does not degrade Anthropic and Gemini mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
      const teamName = 'mixed-anthropic-gemini-cancel-late-error-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
        'late fake Anthropic and Gemini cancel bridge failure'
      );
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
      const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
      addGeminiPrimaryToMixedRun(run);
      trackLiveRun(svc, run);

      await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
      await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);

      await svc.cancelProvisioning(run.runId);
      await waitForCondition(() => adapter.stopInputs.length === 1);

      adapter.releaseLaunches();
      await waitForCondition(() => adapter.rejectedLaunchCount === 1);

      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {},
      });
      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(statuses.teamLaunchState).not.toBe('partial_failure');
      expect(statuses.statuses.alice).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.reviewer).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom).toMatchObject({
        hardFailure: false,
      });
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    });

    it('degrades stale active mixed OpenCode lanes when lane state is missing on disk', async () => {
      const teamName = 'mixed-stale-lanes-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });

      const svc = new TeamProvisioningService();
      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(statuses.teamLaunchState).toBe('partial_failure');
      expect(statuses.expectedMembers).toEqual(expect.arrayContaining(['alice', 'bob', 'tom']));
      expect(statuses.statuses.bob).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: expect.stringContaining('no lane state exists on disk'),
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        error: expect.stringContaining('no lane state exists on disk'),
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'degraded' },
          'secondary:opencode:tom': { state: 'degraded' },
        },
      });
    });

    it('recovers stale active mixed OpenCode lanes from runtime reconcile before degrading them', async () => {
      const teamName = 'mixed-runtime-recover-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'confirmed',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers stale active mixed OpenCode lanes into ready and permission-pending states before degrading them', async () => {
      const teamName = 'mixed-runtime-recover-split-permission-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'permission',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const statuses = await svc.getMemberSpawnStatuses(teamName);
      expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers stale active mixed OpenCode lanes into ready and bootstrap-pending states before degrading them', async () => {
      const teamName = 'mixed-runtime-recover-split-bootstrap-safe-e2e';
      await writeMixedTeamConfig({ teamName, projectPath });
      await writeTeamMeta(teamName, projectPath);
      await writeMembersMeta(teamName);
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'launching',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 2,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers stale active Anthropic and Gemini configured OpenCode lanes into ready and permission-pending states before degrading them', async () => {
      const teamName =
        'mixed-anthropic-gemini-configured-runtime-recover-split-permission-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'permission',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 3,
        failedCount: 0,
      });
      expect(statuses.expectedMembers).toEqual(
        expect.arrayContaining(['alice', 'reviewer', 'bob', 'tom'])
      );
      expect(statuses.statuses.alice?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.reviewer?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_permission',
        hardFailure: false,
        pendingPermissionRequestIds: ['perm-tom'],
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers stale active Anthropic and Gemini configured OpenCode lanes into ready and bootstrap-pending states before degrading them', async () => {
      const teamName = 'mixed-anthropic-gemini-configured-runtime-recover-split-bootstrap-safe-e2e';
      await writeMixedTeamConfig({
        teamName,
        projectPath,
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
      await writeMembersMeta(teamName, {
        includeGeminiPrimary: true,
        primaryProviderId: 'anthropic',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      });
      const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
        bob: 'confirmed',
        tom: 'launching',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const statuses = await svc.getMemberSpawnStatuses(teamName);

      expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
        'secondary:opencode:bob',
        'secondary:opencode:tom',
      ]);
      expect(statuses.teamLaunchState).toBe('partial_pending');
      expect(statuses.summary).toMatchObject({
        confirmedCount: 1,
        pendingCount: 3,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      });
      expect(statuses.expectedMembers).toEqual(
        expect.arrayContaining(['alice', 'reviewer', 'bob', 'tom'])
      );
      expect(statuses.statuses.alice?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.reviewer?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(statuses.statuses.tom).toMatchObject({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      });
      expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
      expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      });
    });

    it('recovers pure OpenCode launch statuses from disk after service restart', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter();
      const firstService = new TeamProvisioningService();
      firstService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await firstService.createTeam(
        {
          teamName: 'restart-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [
            { name: 'alice', role: 'Developer', providerId: 'opencode' },
            { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          ],
        },
        () => undefined
      );

      const restartedService = new TeamProvisioningService();
      const statuses = await restartedService.getMemberSpawnStatuses('restart-opencode-safe-e2e');

      expect(statuses).toMatchObject({
        source: 'persisted',
        teamLaunchState: 'clean_success',
      });
      expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
      expect(statuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
      });
      expect(statuses.statuses.bob).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
      });
    });

    it('relaunches an OpenCode team after a failed runtime adapter launch and replaces stale failures', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'failed-then-relaunch-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const failedStatuses = await svc.getMemberSpawnStatuses(
        'failed-then-relaunch-opencode-safe-e2e'
      );
      expect(failedStatuses.teamLaunchState).toBe('partial_failure');
      expect(failedStatuses.statuses.alice).toMatchObject({
        status: 'error',
        hardFailure: true,
      });

      adapter.setLaunchResult('clean_success');

      await svc.launchTeam(
        {
          teamName: 'failed-then-relaunch-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      const relaunchedStatuses = await svc.getMemberSpawnStatuses(
        'failed-then-relaunch-opencode-safe-e2e'
      );
      expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
      expect(relaunchedStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        hardFailure: false,
      });
      expect(relaunchedStatuses.statuses.alice?.hardFailureReason).toBeUndefined();
    });

    it('relaunches an OpenCode team after permission-pending stop and clears pending permissions', async () => {
      const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending');
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      await svc.createTeam(
        {
          teamName: 'pending-then-relaunch-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: false,
          members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
        },
        () => undefined
      );

      const pendingStatuses = await svc.getMemberSpawnStatuses(
        'pending-then-relaunch-opencode-safe-e2e'
      );
      expect(pendingStatuses.statuses.alice).toMatchObject({
        launchState: 'runtime_pending_permission',
        pendingPermissionRequestIds: ['perm-alice'],
      });

      svc.stopTeam('pending-then-relaunch-opencode-safe-e2e');
      await waitForCondition(() => adapter.stopInputs.length === 1);
      adapter.setLaunchResult('clean_success');

      await svc.launchTeam(
        {
          teamName: 'pending-then-relaunch-opencode-safe-e2e',
          cwd: projectPath,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          skipPermissions: true,
        },
        () => undefined
      );

      const relaunchedStatuses = await svc.getMemberSpawnStatuses(
        'pending-then-relaunch-opencode-safe-e2e'
      );
      expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
      expect(relaunchedStatuses.statuses.alice).toMatchObject({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      });
      expect(relaunchedStatuses.statuses.alice?.pendingPermissionRequestIds).toBeUndefined();
    });
  },
  LAUNCH_MATRIX_SAFE_E2E_TIMEOUT_MS
);

type FakeMemberOutcome = 'confirmed' | 'permission' | 'launching' | 'failed';
type MixedPrimaryProviderId = 'anthropic' | 'codex';

class FakeOpenCodeRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  readonly launchInputs: TeamRuntimeLaunchInput[] = [];
  readonly messageInputs: OpenCodeTeamRuntimeMessageInput[] = [];
  readonly permissionAnswerInputs: TeamRuntimePermissionAnswerInput[] = [];
  readonly permissionListInputs: Array<{
    teamName: string;
    laneId: string;
    cwd: string;
    memberName?: string;
    sessionId?: string | null;
  }> = [];
  readonly reconcileInputs: TeamRuntimeReconcileInput[] = [];
  readonly stopInputs: TeamRuntimeStopInput[] = [];
  private readonly runtimePermissionsByLane = new Map<string, TeamRuntimePendingPermission[]>();
  private nextPrimaryLaunchError: { message: string; remaining: number } | null = null;
  private nextPrimaryMemberOutcomes: {
    outcomes: Record<string, FakeMemberOutcome>;
    remaining: number;
  } | null = null;
  private nextPrimaryLaunchGate: {
    entered: () => void;
    released: Promise<void>;
  } | null = null;
  private nextLaneStopGate: {
    laneId: string;
    entered: () => void;
    released: Promise<void>;
  } | null = null;

  constructor(
    private launchState: TeamRuntimeLaunchResult['teamLaunchState'] = 'clean_success',
    private memberOutcomes: Record<string, FakeMemberOutcome> = {}
  ) {}

  setLaunchResult(
    launchState: TeamRuntimeLaunchResult['teamLaunchState'],
    memberOutcomes: Record<string, FakeMemberOutcome> = {}
  ): void {
    this.launchState = launchState;
    this.memberOutcomes = memberOutcomes;
  }

  setRuntimePermissions(laneId: string, permissions: TeamRuntimePendingPermission[]): void {
    this.runtimePermissionsByLane.set(laneId, permissions);
  }

  failNextPrimaryLaunch(message: string, times = 1): void {
    this.nextPrimaryLaunchError = { message, remaining: Math.max(1, times) };
  }

  setNextPrimaryMemberOutcomes(outcomes: Record<string, FakeMemberOutcome>, times = 1): void {
    this.nextPrimaryMemberOutcomes = { outcomes, remaining: Math.max(1, times) };
  }

  holdNextPrimaryLaunch(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextPrimaryLaunchGate = { entered: markEntered, released };
    return { entered, release };
  }

  holdNextLaneStop(laneId: string): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextLaneStopGate = { laneId, entered: markEntered, released };
    return { entered, release };
  }

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    return {
      ok: true,
      providerId: 'opencode',
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    };
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.launchInputs.push(input);
    if (input.laneId === 'primary' && this.nextPrimaryLaunchGate) {
      const gate = this.nextPrimaryLaunchGate;
      this.nextPrimaryLaunchGate = null;
      gate.entered();
      await gate.released;
    }
    if (input.laneId === 'primary' && this.nextPrimaryLaunchError) {
      const failure = this.nextPrimaryLaunchError;
      failure.remaining -= 1;
      if (failure.remaining === 0) {
        this.nextPrimaryLaunchError = null;
      }
      throw new Error(failure.message);
    }
    const launchMemberOutcomes = { ...this.memberOutcomes };
    if (input.laneId === 'primary' && this.nextPrimaryMemberOutcomes) {
      const override = this.nextPrimaryMemberOutcomes;
      Object.assign(launchMemberOutcomes, override.outcomes);
      override.remaining -= 1;
      if (override.remaining === 0) {
        this.nextPrimaryMemberOutcomes = null;
      }
    }
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished',
      teamLaunchState: this.aggregateLaunchState(input.expectedMembers, launchMemberOutcomes),
      members: Object.fromEntries(
        input.expectedMembers.map((member, index) => [
          member.name,
          this.buildMemberEvidence(member, index, launchMemberOutcomes),
        ])
      ),
      warnings: [],
      diagnostics:
        this.launchState === 'partial_failure'
          ? ['fake OpenCode launch failed']
          : this.launchState === 'partial_pending'
            ? ['fake OpenCode launch awaiting permission']
            : ['fake OpenCode launch ready'],
    };
  }

  async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    this.messageInputs.push(input);
    return {
      ok: true,
      providerId: 'opencode',
      memberName: input.memberName,
      sessionId: `session-${input.memberName}`,
      runtimePromptMessageId: input.messageId
        ? `prompt-${input.messageId}`
        : `prompt-${input.memberName}-${this.messageInputs.length}`,
      runtimePid: 12_000 + this.messageInputs.length,
      diagnostics: [],
    };
  }

  async answerRuntimePermission(
    input: TeamRuntimePermissionAnswerInput
  ): Promise<TeamRuntimeLaunchResult> {
    this.permissionAnswerInputs.push(input);
    this.memberOutcomes = {
      ...this.memberOutcomes,
      [input.memberName]: input.decision === 'allow' ? 'confirmed' : 'failed',
    };
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished',
      teamLaunchState: this.aggregateLaunchState(input.expectedMembers),
      members: Object.fromEntries(
        input.expectedMembers.map((member, index) => [
          member.name,
          this.buildMemberEvidence(member, index),
        ])
      ),
      warnings: [],
      diagnostics: ['fake OpenCode permission answer'],
    };
  }

  async listRuntimePermissions(
    input: TeamRuntimePermissionListInput
  ): Promise<TeamRuntimePermissionListResult> {
    const laneId = input.laneId ?? 'primary';
    const cwd = input.cwd ?? '';
    this.permissionListInputs.push({
      teamName: input.teamName,
      laneId,
      cwd,
      memberName: input.memberName,
      sessionId: input.sessionId,
    });
    return {
      permissions: [...(this.runtimePermissionsByLane.get(laneId) ?? [])],
      diagnostics: [],
    };
  }

  async reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult> {
    this.reconcileInputs.push(input);
    const members = Object.fromEntries(
      input.expectedMembers.map((member, index) => [
        member.name,
        this.buildMemberEvidence(member, index),
      ])
    );
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'reconciled',
      teamLaunchState: this.aggregateLaunchState(input.expectedMembers),
      members,
      snapshot: null,
      warnings: [],
      diagnostics: ['fake reconcile'],
    };
  }

  async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    this.stopInputs.push(input);
    const stopGate = this.nextLaneStopGate;
    if (stopGate !== null && stopGate.laneId === input.laneId) {
      this.nextLaneStopGate = null;
      stopGate.entered();
      await stopGate.released;
    }
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['fake stop'],
    };
  }

  private defaultOutcome(): FakeMemberOutcome {
    if (this.launchState === 'partial_failure') {
      return 'failed';
    }
    if (this.launchState === 'partial_pending') {
      return 'permission';
    }
    return 'confirmed';
  }

  private buildMemberEvidence(
    member: Pick<TeamRuntimeMemberSpec, 'name'>,
    index: number,
    memberOutcomes = this.memberOutcomes
  ): TeamRuntimeMemberLaunchEvidence {
    const outcome = memberOutcomes[member.name] ?? this.defaultOutcome();
    const failed = outcome === 'failed';
    const permissionPending = outcome === 'permission';
    const bootstrapPending = outcome === 'launching';
    const livenessKind = failed
      ? 'not_found'
      : permissionPending
        ? 'permission_blocked'
        : bootstrapPending
          ? 'runtime_process_candidate'
          : 'confirmed_bootstrap';
    const runtimeDiagnostic = permissionPending
      ? 'OpenCode runtime is waiting for permission approval'
      : bootstrapPending
        ? 'OpenCode runtime pid reported by bridge without local process verification'
        : undefined;
    return {
      memberName: member.name,
      providerId: 'opencode',
      launchState: failed
        ? 'failed_to_start'
        : permissionPending
          ? 'runtime_pending_permission'
          : bootstrapPending
            ? 'runtime_pending_bootstrap'
            : 'confirmed_alive',
      agentToolAccepted: !failed,
      runtimeAlive: !failed && !permissionPending && !bootstrapPending,
      bootstrapConfirmed: !failed && !permissionPending && !bootstrapPending,
      hardFailure: failed,
      hardFailureReason: failed ? 'fake_open_code_launch_failure' : undefined,
      pendingPermissionRequestIds: permissionPending ? [`perm-${member.name}`] : undefined,
      pendingPermissions: permissionPending
        ? [
            {
              providerId: 'opencode',
              requestId: `perm-${member.name}`,
              sessionId: `session-${member.name}`,
              tool: 'bash',
              title: `Run git status for ${member.name}`,
              kind: 'tool',
              raw: {
                requestID: `perm-${member.name}`,
                sessionID: `session-${member.name}`,
                tool: 'bash',
                title: `Run git status for ${member.name}`,
                kind: 'tool',
                patterns: ['git status'],
              },
            },
          ]
        : undefined,
      sessionId: failed ? undefined : `session-${member.name}`,
      runtimePid: failed ? undefined : 10_000 + index,
      livenessKind,
      pidSource: failed ? undefined : 'opencode_bridge',
      runtimeDiagnostic,
      diagnostics: failed
        ? ['fake OpenCode launch failure']
        : permissionPending
          ? ['fake OpenCode launch awaiting permission']
          : bootstrapPending
            ? ['fake OpenCode launch awaiting bootstrap']
            : ['fake OpenCode launch ready'],
    };
  }

  private aggregateLaunchState(
    members: readonly Pick<TeamRuntimeMemberSpec, 'name'>[],
    memberOutcomes = this.memberOutcomes
  ): TeamRuntimeLaunchResult['teamLaunchState'] {
    const outcomes = members.map((member) => memberOutcomes[member.name] ?? this.defaultOutcome());
    if (outcomes.some((outcome) => outcome === 'failed')) {
      return 'partial_failure';
    }
    if (outcomes.some((outcome) => outcome === 'permission' || outcome === 'launching')) {
      return 'partial_pending';
    }
    return 'clean_success';
  }
}

class VisibleReplyOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  constructor(private readonly options: { replySource: InboxMessage['source'] }) {
    super();
  }

  override async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    const result = await super.sendMessageToMember(input);
    const relayOfMessageId = input.messageId?.trim() || `message-${this.messageInputs.length}`;
    const replyRecipient = input.replyRecipient?.trim() || 'user';
    const replyMessageId = `reply-${relayOfMessageId}`;
    const inboxPath = path.join(
      getTeamsBasePath(),
      input.teamName,
      'inboxes',
      `${replyRecipient}.json`
    );
    const rows: InboxMessage[] = await readInboxRows(input.teamName, replyRecipient).catch(
      () => []
    );
    rows.push({
      from: input.memberName,
      to: replyRecipient,
      text: `Visible reply for ${relayOfMessageId}`,
      summary: 'visible reply',
      timestamp: '2026-05-08T10:00:00.000Z',
      read: false,
      messageId: replyMessageId,
      relayOfMessageId,
      source: this.options.replySource,
    });
    await fs.mkdir(path.dirname(inboxPath), { recursive: true });
    await fs.writeFile(inboxPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

    return {
      ...result,
      responseObservation: {
        state: 'responded_visible_message',
        deliveredUserMessageId: `delivered-${relayOfMessageId}`,
        assistantMessageId: `assistant-${relayOfMessageId}`,
        toolCallNames: ['message_send'],
        visibleMessageToolCallId: `call-${relayOfMessageId}`,
        visibleReplyMessageId: replyMessageId,
        visibleReplyCorrelation: 'relayOfMessageId',
        latestAssistantPreview: null,
        reason: 'visible_message_sent',
      },
    };
  }
}

class PermissionBlockedOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  override async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    this.messageInputs.push(input);
    return {
      ok: false,
      providerId: 'opencode',
      memberName: input.memberName,
      sessionId: `session-${input.memberName}`,
      responseObservation: {
        state: 'permission_blocked',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'OpenCode session has 1 pending permission request(s)',
      },
      diagnostics: ['OpenCode API error', 'OpenCode session has 1 pending permission request(s)'],
    };
  }
}

class PermissionBlockedWithoutSessionOpenCodeRuntimeAdapter extends PermissionBlockedOpenCodeRuntimeAdapter {
  override async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    const result = await super.sendMessageToMember(input);
    return {
      ...result,
      sessionId: undefined,
    };
  }
}

class PermissionBlockedInlineObserveOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly observeInputs: Array<
    OpenCodeTeamRuntimeMessageInput & { prePromptCursor?: string | null }
  > = [];

  override async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    this.messageInputs.push(input);
    return {
      ok: true,
      providerId: 'opencode',
      memberName: input.memberName,
      sessionId: `session-${input.memberName}`,
      runtimePromptMessageId: `prompt-${input.messageId ?? input.memberName}`,
      prePromptCursor: 'cursor-before-inline-observe-permission',
      responseObservation: {
        state: 'tool_error',
        deliveredUserMessageId: `delivered-${input.messageId ?? input.memberName}`,
        assistantMessageId: `assistant-${input.messageId ?? input.memberName}`,
        toolCallNames: ['agent-teams_message_send'],
        visibleMessageToolCallId: `call-${input.messageId ?? input.memberName}`,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'message_send_tool_error_without_visible_reply_proof',
      },
      diagnostics: ['OpenCode tool failed without output'],
    };
  }

  async observeMessageDelivery(
    input: OpenCodeTeamRuntimeMessageInput & { prePromptCursor?: string | null }
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    this.observeInputs.push(input);
    throw new Error('OpenCode session has 1 pending permission request(s)');
  }
}

class BootstrapCheckingOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly bootstrapCheckins: { memberName: string; runId: string; state: string }[] = [];

  constructor(private readonly svc: TeamProvisioningService) {
    super();
  }

  override async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    const firstMember = input.expectedMembers[0];
    if (!firstMember) {
      return super.launch(input);
    }

    const ack = await this.svc.recordOpenCodeRuntimeBootstrapCheckin({
      teamName: input.teamName,
      runId: input.runId,
      memberName: firstMember.name,
      runtimeSessionId: `session-${firstMember.name}`,
      observedAt: new Date().toISOString(),
    });
    this.bootstrapCheckins.push({
      memberName: firstMember.name,
      runId: input.runId,
      state: ack.state,
    });

    return super.launch(input);
  }
}

class BlockingOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly pendingLaunchInputs: TeamRuntimeLaunchInput[] = [];
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  override async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.pendingLaunchInputs.push(input);
    await this.gate;
    return super.launch(input);
  }

  releaseLaunches(): void {
    this.releaseGate?.();
  }
}

function latestOpenCodeLaunchRunId(
  adapter: { readonly launchInputs: readonly TeamRuntimeLaunchInput[] },
  teamName: string,
  laneId: string
): string {
  const launchInput = [...adapter.launchInputs]
    .reverse()
    .find((input) => input.teamName === teamName && input.laneId === laneId);
  expect(launchInput?.runId).toBeTruthy();
  return launchInput!.runId;
}

class BlockingStopOpenCodeRuntimeAdapter extends BlockingOpenCodeRuntimeAdapter {
  private releaseStopGate: (() => void) | null = null;
  private readonly stopGate = new Promise<void>((resolve) => {
    this.releaseStopGate = resolve;
  });

  override async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    this.stopInputs.push(input);
    await this.stopGate;
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['fake delayed stop'],
    };
  }

  releaseStops(): void {
    this.releaseStopGate?.();
  }
}

class RejectingThenBlockingStopOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  private rejectOldStopGate: (() => void) | null = null;
  private readonly oldStopGate = new Promise<void>((resolve) => {
    this.rejectOldStopGate = resolve;
  });
  private releaseReplacementStopGate: (() => void) | null = null;
  private readonly replacementStopGate = new Promise<void>((resolve) => {
    this.releaseReplacementStopGate = resolve;
  });

  constructor(private readonly oldStopErrorMessage: string) {
    super();
  }

  override async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    this.stopInputs.push(input);
    if (this.stopInputs.length === 1) {
      await this.oldStopGate;
      throw new Error(this.oldStopErrorMessage);
    }
    await this.replacementStopGate;
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['fake exact replacement stop'],
    };
  }

  rejectOldStop(): void {
    this.rejectOldStopGate?.();
  }

  releaseReplacementStop(): void {
    this.releaseReplacementStopGate?.();
  }
}

class RejectingBlockingOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly pendingLaunchInputs: TeamRuntimeLaunchInput[] = [];
  rejectedLaunchCount = 0;
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  constructor(private readonly errorMessage: string) {
    super();
  }

  override async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.pendingLaunchInputs.push(input);
    await this.gate;
    this.rejectedLaunchCount += 1;
    throw new Error(this.errorMessage);
  }

  releaseLaunches(): void {
    this.releaseGate?.();
  }
}

async function upsertActiveOpenCodeRuntimeLaneForTest(input: {
  teamName: string;
  laneId: string;
  runId?: string | null;
  diagnostics?: string[];
}): Promise<void> {
  const runId = input.runId ?? null;
  await upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: getTeamsBasePath(),
    teamName: input.teamName,
    laneId: input.laneId,
    state: 'active',
    diagnostics: input.diagnostics,
  });
  await setOpenCodeRuntimeActiveRunManifest({
    teamsBasePath: getTeamsBasePath(),
    teamName: input.teamName,
    laneId: input.laneId,
    runId,
  });
  await writeOpenCodeBootstrapSessionEvidenceForTest({
    teamName: input.teamName,
    laneId: input.laneId,
    runId,
  });
}

async function writeOpenCodeBootstrapSessionEvidenceForTest(input: {
  teamName: string;
  laneId: string;
  runId?: string | null;
  memberName?: string;
  sessionId?: string;
  appMcpTransportHash?: string;
}): Promise<void> {
  const runId = input.runId ?? null;
  const descriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
    (candidate) => candidate.schemaName === 'opencode.sessionStore'
  );
  if (!descriptor) {
    throw new Error('OpenCode session store descriptor missing');
  }
  const manifestPath = getOpenCodeRuntimeManifestPath(
    getTeamsBasePath(),
    input.teamName,
    input.laneId
  );
  const runtimeDirectory = path.dirname(manifestPath);
  await fs.mkdir(runtimeDirectory, { recursive: true });
  const memberName = input.memberName ?? input.laneId.split(':').at(-1) ?? input.laneId;
  const writer = new RuntimeStoreBatchWriter(
    runtimeDirectory,
    createRuntimeStoreManifestStore({
      filePath: manifestPath,
      teamName: input.teamName,
    }),
    createRuntimeStoreReceiptStore({
      filePath: path.join(runtimeDirectory, 'opencode-runtime-receipts.json'),
    }),
    {
      clock: () => new Date('2026-04-23T10:00:00.000Z'),
      batchIdFactory: () => `batch-${input.teamName}-${input.laneId}`,
      receiptIdFactory: () => `receipt-${input.teamName}-${input.laneId}`,
    }
  );
  await writer.writeBatch({
    teamName: input.teamName,
    runId,
    capabilitySnapshotId: null,
    behaviorFingerprint: null,
    reason: 'launch_checkpoint',
    writes: [
      {
        descriptor,
        data: {
          sessions: [
            {
              id: input.sessionId ?? `ses-${input.teamName}-${input.laneId}`,
              teamName: input.teamName,
              memberName,
              laneId: input.laneId,
              runId,
              observedAt: '2026-04-23T10:00:00.000Z',
              source: 'runtime_bootstrap_checkin',
              ...(input.appMcpTransportHash
                ? { appMcpTransportHash: input.appMcpTransportHash }
                : {}),
            },
          ],
        },
      },
    ],
  });
}

async function waitForCondition(
  assertion: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await assertion()).toBe(true);
}

async function removeTempDirWithRetries(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function createMixedLiveRun(input: {
  teamName: string;
  projectPath: string;
  primaryProviderId?: MixedPrimaryProviderId;
}): any {
  const now = '2026-04-23T10:00:00.000Z';
  const freshHeartbeatAt = new Date().toISOString();
  const primary = getMixedPrimaryFixture(input.primaryProviderId);
  return {
    runId: `run-${input.teamName}`,
    teamName: input.teamName,
    startedAt: now,
    detectedSessionId: 'lead-session',
    isLaunch: true,
    provisioningComplete: false,
    processKilled: false,
    cancelRequested: false,
    leadActivityState: 'active',
    request: {
      teamName: input.teamName,
      cwd: input.projectPath,
      providerId: primary.providerId,
      providerBackendId: primary.providerBackendId,
      model: primary.leadModel,
      skipPermissions: false,
      members: [],
    },
    progress: {
      state: 'finalizing',
      message: 'Finishing launch - waiting for secondary runtime lanes',
      updatedAt: now,
      assistantOutput: null,
    },
    onProgress: () => undefined,
    launchIdentity: {
      providerId: primary.providerId,
      providerBackendId: primary.providerBackendId ?? null,
      selectedModel: primary.leadModel,
      selectedModelKind: 'explicit',
      resolvedLaunchModel: primary.leadModel,
      catalogId: primary.leadModel,
      catalogSource: 'bundled',
      catalogFetchedAt: now,
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
      selectedFastMode: null,
      resolvedFastMode: null,
      fastResolutionReason: null,
    },
    expectedMembers: ['alice'],
    effectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: primary.providerId,
        providerBackendId: primary.providerBackendId,
        model: primary.memberModel,
      },
    ],
    allEffectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: primary.providerId,
        providerBackendId: primary.providerBackendId,
        model: primary.memberModel,
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
      },
      {
        name: 'tom',
        role: 'Developer',
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
      },
    ],
    memberSpawnStatuses: new Map([
      [
        'alice',
        {
          status: 'online',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: freshHeartbeatAt,
          lastRuntimeAliveAt: now,
          lastEvaluatedAt: now,
          updatedAt: now,
          livenessSource: 'heartbeat',
        },
      ],
    ]),
    mixedSecondaryLanes: [
      {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        member: {
          name: 'bob',
          role: 'Developer',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
      {
        laneId: 'secondary:opencode:tom',
        providerId: 'opencode',
        member: {
          name: 'tom',
          role: 'Developer',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ],
    memberSpawnToolUseIds: new Map(),
    pendingMemberRestarts: new Map(),
    pendingApprovals: new Map(),
    memberSpawnLeadInboxCursorByMember: new Map(),
    provisioningOutputParts: [],
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    activeToolCalls: new Map(),
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    mcpConfigPath: null,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
  };
}

async function markMixedOpenCodeLaneConfirmedForTest(
  run: any,
  memberName: string,
  options: {
    sessionId?: string;
    appMcpTransportHash?: string;
  } = {}
): Promise<void> {
  const now = '2026-04-23T10:00:00.000Z';
  const laneId = `secondary:opencode:${memberName}`;
  const sessionId = options.sessionId ?? `session-${memberName}`;
  const lane = run.mixedSecondaryLanes?.find((candidate: any) => candidate.laneId === laneId);
  if (!lane) {
    throw new Error(`Missing mixed OpenCode lane fixture for ${memberName}`);
  }
  lane.runId = run.runId;
  lane.state = 'active';
  lane.result = {
    runId: run.runId,
    teamName: run.teamName,
    launchPhase: 'reconciled',
    teamLaunchState: 'clean_success',
    members: {
      [memberName]: {
        memberName,
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        sessionId,
        runtimePid: 10_000,
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'opencode_bridge',
        diagnostics: ['fake OpenCode launch ready'],
        lastEvaluatedAt: now,
      },
    },
    warnings: [],
    diagnostics: ['fake OpenCode launch ready'],
  };
  await writeOpenCodeBootstrapSessionEvidenceForTest({
    teamName: run.teamName,
    laneId,
    runId: run.runId,
    memberName,
    sessionId,
    appMcpTransportHash: options.appMcpTransportHash,
  });
}

function removeMixedOpenCodeLaneForTest(run: any, memberName: string): void {
  run.allEffectiveMembers = (run.allEffectiveMembers ?? []).filter(
    (member: { name?: string }) => member.name !== memberName
  );
  run.mixedSecondaryLanes = (run.mixedSecondaryLanes ?? []).filter(
    (lane: { member?: { name?: string } }) => lane.member?.name !== memberName
  );
}

function addGeminiPrimaryToMixedRun(run: any): void {
  const now = '2026-04-23T10:00:00.000Z';
  const freshHeartbeatAt = new Date().toISOString();
  const reviewer = {
    name: 'reviewer',
    role: 'Reviewer',
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
  };
  run.expectedMembers = Array.from(new Set([...(run.expectedMembers ?? []), 'reviewer']));
  run.effectiveMembers = [...(run.effectiveMembers ?? []), reviewer];
  run.allEffectiveMembers = [
    ...run.effectiveMembers,
    ...((run.allEffectiveMembers ?? []) as Array<Record<string, unknown>>).filter(
      (member) => member.providerId === 'opencode'
    ),
  ];
  run.memberSpawnStatuses.set('reviewer', {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastHeartbeatAt: freshHeartbeatAt,
    lastRuntimeAliveAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
    livenessSource: 'heartbeat',
  });
}

function addCodexPrimaryToMixedRun(run: ReturnType<typeof createMixedLiveRun>): void {
  const now = '2026-04-23T10:00:00.000Z';
  const freshHeartbeatAt = new Date().toISOString();
  const cody = {
    name: 'cody',
    role: 'Developer',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.4-mini',
  };
  run.expectedMembers = Array.from(new Set([...(run.expectedMembers ?? []), 'cody']));
  run.effectiveMembers = [...(run.effectiveMembers ?? []), cody];
  run.allEffectiveMembers = [
    ...run.effectiveMembers,
    ...((run.allEffectiveMembers ?? []) as Array<Record<string, unknown>>).filter(
      (member) => member.providerId === 'opencode'
    ),
  ];
  run.memberSpawnStatuses.set('cody', {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastHeartbeatAt: freshHeartbeatAt,
    lastRuntimeAliveAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
    livenessSource: 'heartbeat',
  });
}

function createPureAnthropicLiveRun(input: { teamName: string; projectPath: string }): any {
  const now = '2026-04-23T10:00:00.000Z';
  const freshHeartbeatAt = new Date().toISOString();
  const memberStatus = {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastHeartbeatAt: freshHeartbeatAt,
    lastRuntimeAliveAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
    livenessSource: 'heartbeat',
  };
  return {
    ...createMixedLiveRun({
      teamName: input.teamName,
      projectPath: input.projectPath,
      primaryProviderId: 'anthropic',
    }),
    request: {
      teamName: input.teamName,
      cwd: input.projectPath,
      providerId: 'anthropic',
      model: 'sonnet',
      skipPermissions: false,
      members: [],
    },
    expectedMembers: ['alice', 'bob'],
    effectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'anthropic',
        model: 'haiku',
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'anthropic',
        model: 'sonnet',
      },
    ],
    allEffectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'anthropic',
        model: 'haiku',
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'anthropic',
        model: 'sonnet',
      },
    ],
    memberSpawnStatuses: new Map([
      ['alice', { ...memberStatus }],
      ['bob', { ...memberStatus }],
    ]),
    mixedSecondaryLanes: [],
  };
}

function trackLiveRun(svc: TeamProvisioningService, run: any): void {
  (svc as any).runs.set(run.runId, run);
  (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
  (svc as any).aliveRunByTeam.set(run.teamName, run.runId);
}

async function writeAliveProcessRegistry(teamName: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'processes.json'),
    `${JSON.stringify(
      [
        {
          id: 'lead-process',
          label: 'Team Lead',
          pid: process.pid,
          registeredAt: '2026-04-23T10:00:00.000Z',
        },
      ],
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeStoppedProcessRegistry(teamName: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'processes.json'),
    `${JSON.stringify(
      [
        {
          id: 'lead-process',
          label: 'Team Lead',
          pid: 987_654,
          registeredAt: '2026-04-23T10:00:00.000Z',
          stoppedAt: '2026-04-23T10:05:00.000Z',
        },
      ],
      null,
      2
    )}\n`,
    'utf8'
  );
}

function expectDirectChildKillCount(actual: number, expected: number): void {
  expect(actual).toBe(expected);
}

function trackProcessKillsForPids(pids: readonly number[]): {
  killedPids: number[];
  restore: () => void;
} {
  const targetPids = new Set(pids);
  const killedPids: number[] = [];
  const spy = vi.spyOn(process, 'kill').mockImplementation(((
    pid: number | string,
    signal?: number | string
  ) => {
    const numericPid = Number(pid);
    if (targetPids.has(numericPid) && signal !== 0) {
      killedPids.push(numericPid);
    }
    return true;
  }) as typeof process.kill);
  return {
    killedPids,
    restore: () => spy.mockRestore(),
  };
}

function expectProcessKillCount(
  killedPids: readonly number[],
  pid: number,
  expected: number
): void {
  const actual = killedPids.filter((killedPid) => killedPid === pid).length;
  // Windows uses taskkill.exe for process-tree termination, so process.kill is not called.
  expect(actual).toBe(process.platform === 'win32' ? 0 : expected);
}

function injectStaleTerminalProvisioningRun(
  svc: TeamProvisioningService,
  teamName: string,
  runId: string
): void {
  const timestamp = '2026-04-23T10:00:00.000Z';
  (svc as any).provisioningRunByTeam.set(teamName, runId);
  (svc as any).runtimeAdapterProgressByRunId.set(runId, {
    runId,
    teamName,
    state: 'failed',
    message: 'stale provisioning failure',
    startedAt: timestamp,
    updatedAt: timestamp,
  } satisfies TeamProvisioningProgress);
}

function createWritableStdin(writes: string[]): {
  writable: true;
  write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
} {
  return {
    writable: true,
    write: (chunk, callback) => {
      writes.push(chunk);
      callback?.();
      return true;
    },
  };
}

async function writeOpenCodeTeamConfig(input: {
  teamName: string;
  projectPath: string;
  members: string[];
  removedMembers?: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const removedMembers = new Set(input.removedMembers ?? []);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
          },
          ...input.members.map((name) => ({
            name,
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
            ...(removedMembers.has(name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeAnthropicTeamConfig(input: {
  teamName: string;
  projectPath: string;
  members: string[];
}): Promise<string> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const config = {
    name: input.teamName,
    projectPath: input.projectPath,
    color: 'blue',
    members: [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'anthropic',
        model: 'sonnet',
      },
      ...input.members.map((name) => ({
        name,
        role: 'Developer',
        providerId: 'anthropic',
        model: name === 'alice' ? 'haiku' : 'sonnet',
      })),
    ],
  };
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(path.join(teamDir, 'config.json'), raw, 'utf8');
  return raw;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeFakeClaudeCli(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, 'fake-bin');
  const cliPath = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const providerIndex = args.lastIndexOf('--provider');
const provider = providerIndex >= 0 ? args[providerIndex + 1] : 'anthropic';

function hasCommand(...parts) {
  return parts.every((part) => args.includes(part));
}

function modelCatalog(providerId) {
  const base = {
    schemaVersion: 1,
    providerId,
    source: 'runtime',
    status: 'ready',
    fetchedAt: '2026-05-13T00:00:00.000Z',
    staleAt: '2026-05-13T01:00:00.000Z',
    diagnostics: {
      configReadState: 'ready',
      appServerState: 'healthy',
    },
  };
  if (providerId === 'anthropic') {
    return {
      ...base,
      defaultModelId: 'sonnet',
      defaultLaunchModel: 'sonnet',
      models: [
        {
          id: 'sonnet',
          launchModel: 'sonnet',
          displayName: 'Sonnet',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          supportsFastMode: false,
        },
        {
          id: 'haiku',
          launchModel: 'haiku',
          displayName: 'Haiku',
          supportedReasoningEfforts: ['low', 'medium'],
          defaultReasoningEffort: 'medium',
          supportsFastMode: false,
        },
      ],
    };
  }
  return {
    ...base,
    defaultModelId: 'gpt-5.5',
    defaultLaunchModel: 'gpt-5.5',
    models: [
      {
        id: 'gpt-5.5',
        launchModel: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ],
  };
}

if (hasCommand('model', 'list')) {
  const catalog = modelCatalog(provider);
  console.log(JSON.stringify({
    schemaVersion: 1,
    providers: {
      [provider]: {
        defaultModel: catalog.defaultLaunchModel,
        models: catalog.models.map((model) => ({ id: model.launchModel, label: model.displayName })),
      },
    },
  }));
  process.exit(0);
}

if (hasCommand('runtime', 'status')) {
  const catalog = modelCatalog(provider);
  console.log(JSON.stringify({
    providers: {
      [provider]: {
        providerId: provider,
        displayName: provider,
        supported: true,
        authenticated: true,
        authMethod: 'test',
        verificationState: 'verified',
        models: catalog.models.map((model) => model.launchModel),
        modelCatalog: catalog,
        runtimeCapabilities: {
          modelCatalog: { dynamic: false, source: 'runtime' },
          reasoningEffort: {
            supported: true,
            values: ['low', 'medium', 'high'],
            configPassthrough: true,
          },
          fastMode: {
            supported: true,
            available: false,
            reason: 'test runtime',
            source: 'runtime',
          },
        },
        canLoginFromUi: false,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: {},
        },
      },
    },
  }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true }));
`;
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(cliPath, script, 'utf8');
  if (process.platform !== 'win32') {
    await fs.chmod(cliPath, 0o755);
  }
  return cliPath;
}

function createBlockedWorkspaceTrustCoordinator(input: {
  errorMessage: string;
  evidence?: string[];
  rawTail?: string;
}) {
  const planArgsOnly = vi.fn(
    async (_request: Parameters<WorkspaceTrustCoordinator['planArgsOnly']>[0]) => ({
      launchArgPatches: [],
    })
  );
  const planFull = vi.fn(async (request: Parameters<WorkspaceTrustCoordinator['planFull']>[0]) => ({
    providers: request.providers,
    workspaces: request.workspaces,
    launchArgPatches: [],
  }));
  const execute = vi.fn(async (_plan: WorkspaceTrustExecutionPlan) => ({
    id: 'claude-pty-workspace-trust',
    provider: 'claude' as const,
    status: 'blocked' as const,
    workspaceIds: ['workspace-trust-1'],
    errorCode: 'workspace_trust_preflight_not_confirmed',
    errorMessage: input.errorMessage,
    evidence: input.evidence ?? ['workspace trust was not confirmed'],
    ...(input.rawTail ? { rawTail: input.rawTail } : {}),
  }));
  const coordinator: WorkspaceTrustCoordinator = { planArgsOnly, planFull, execute };

  return {
    coordinator,
    planArgsOnly,
    planFull,
    execute,
  };
}

async function readLatestLaunchFailureManifest(teamName: string): Promise<Record<string, any>> {
  const latestPath = path.join(
    getTeamsBasePath(),
    teamName,
    'launch-failure-artifacts',
    'latest.json'
  );
  await waitForCondition(async () => {
    try {
      await fs.access(latestPath);
      return true;
    } catch {
      return false;
    }
  });
  const latest = JSON.parse(await fs.readFile(latestPath, 'utf8')) as { manifestPath?: string };
  expect(latest.manifestPath).toEqual(expect.any(String));
  return JSON.parse(await fs.readFile(latest.manifestPath!, 'utf8')) as Record<string, any>;
}

function snapshotWorkspaceTrustTestEnv(): Partial<
  Record<WorkspaceTrustTestEnvName, string | undefined>
> {
  return Object.fromEntries(
    WORKSPACE_TRUST_TEST_ENV_NAMES.map((name) => [name, process.env[name]])
  ) as Partial<Record<WorkspaceTrustTestEnvName, string | undefined>>;
}

function restoreOptionalEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function restoreWorkspaceTrustTestEnv(
  snapshot: Partial<Record<WorkspaceTrustTestEnvName, string | undefined>>
): void {
  for (const name of WORKSPACE_TRUST_TEST_ENV_NAMES) {
    restoreOptionalEnvValue(name, snapshot[name]);
  }
}

function forceWorkspaceTrustPreflightEnv(): void {
  process.env.AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT = '1';
  process.env.AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY = '1';
  process.env.AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS = '1';
  process.env.AGENT_TEAMS_WORKSPACE_TRUST_RETRY = '0';
}

async function writeOpenCodeMembersMeta(
  teamName: string,
  options: {
    members: string[];
    removedMembers?: string[];
    memberCwd?: string;
  }
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const removedMembers = new Set(options.removedMembers ?? []);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        members: options.members.map((name) => ({
          name,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
          ...(removedMembers.has(name) ? { removedAt: 1_777_000_000_000 } : {}),
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeOpenCodeTeamMeta(teamName: string, projectPath: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamConfig(input: {
  teamName: string;
  projectPath: string;
}): Promise<void> {
  await writePureAnthropicTeamConfigWithMembers({
    ...input,
    members: ['alice', 'bob'],
  });
}

async function writePureAnthropicTeamConfigWithMembers(input: {
  teamName: string;
  projectPath: string;
  members: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: 'anthropic',
        model: 'sonnet',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'anthropic',
            model: 'sonnet',
          },
          ...input.members.map((name, index) => ({
            name,
            role: index === 0 ? 'Reviewer' : 'Developer',
            providerId: 'anthropic',
            model: index === 0 ? 'haiku' : 'sonnet',
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamConfig(input: {
  teamName: string;
  projectPath: string;
  includeGeminiPrimary?: boolean;
  includeCodexPrimary?: boolean;
  primaryProviderId?: MixedPrimaryProviderId;
  removedMembers?: string[];
  extraMembers?: Array<{ name: string; providerId: 'opencode'; model: string }>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const primary = getMixedPrimaryFixture(input.primaryProviderId);
  const removedMembers = new Set(input.removedMembers ?? []);
  const extraMembers = input.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: primary.providerId,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        model: primary.leadModel,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.leadModel,
          },
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.memberModel,
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...(input.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  role: 'Reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                  ...(removedMembers.has('reviewer') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          ...(input.includeCodexPrimary
            ? [
                {
                  name: 'cody',
                  role: 'Developer',
                  providerId: 'codex',
                  providerBackendId: 'codex-native',
                  model: 'gpt-5.4-mini',
                  ...(removedMembers.has('cody') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'tom',
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            ...(removedMembers.has('tom') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            role: 'Developer',
            providerId: member.providerId,
            model: member.model,
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamConfigWithoutOpenCodeProviderMetadata(input: {
  teamName: string;
  projectPath: string;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
          },
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
          },
          {
            name: 'bob',
            role: 'Developer',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamLaunchState(input: {
  teamName: string;
  updatedAt?: string;
  members: Record<string, ReturnType<typeof mixedMemberState>>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    leadSessionId: 'lead-session',
    launchPhase: 'active',
    expectedMembers: Object.keys(input.members),
    bootstrapExpectedMembers: ['alice'],
    members: input.members as any,
    updatedAt: input.updatedAt,
  });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamLaunchState(input: {
  teamName: string;
  launchPhase?: 'active' | 'finished' | 'reconciled';
  expectedMembers?: string[];
  members: Record<string, ReturnType<typeof mixedMemberState>>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  const expectedMembers = input.expectedMembers ?? Object.keys(input.members);
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    leadSessionId: 'lead-session',
    launchPhase: input.launchPhase ?? 'active',
    expectedMembers,
    bootstrapExpectedMembers: expectedMembers,
    members: input.members as any,
  });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

async function writePureAnthropicPendingBobFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writePureAnthropicTeamConfig({ teamName: input.teamName, projectPath: input.projectPath });
  await writePureAnthropicTeamMeta(input.teamName, input.projectPath);
  await writePureAnthropicMembersMeta(input.teamName);
  await writePureAnthropicTeamLaunchState({
    teamName: input.teamName,
    launchPhase: 'active',
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'anthropic',
        model: 'sonnet',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
    },
  });
}

async function writePureAnthropicPendingMembersFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writePureAnthropicTeamConfig({ teamName: input.teamName, projectPath: input.projectPath });
  await writePureAnthropicTeamMeta(input.teamName, input.projectPath);
  await writePureAnthropicMembersMeta(input.teamName);
  await writePureAnthropicTeamLaunchState({
    teamName: input.teamName,
    launchPhase: 'active',
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'anthropic',
        model: 'sonnet',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
    },
  });
}

async function writeMixedAnthropicPendingAliceFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writeMixedTeamConfig({
    teamName: input.teamName,
    projectPath: input.projectPath,
    primaryProviderId: 'anthropic',
  });
  await writeTeamMeta(input.teamName, input.projectPath, { primaryProviderId: 'anthropic' });
  await writeMembersMeta(input.teamName, { primaryProviderId: 'anthropic' });
  await writeMixedTeamLaunchState({
    teamName: input.teamName,
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
      tom: mixedMemberState({
        name: 'tom',
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
    },
  });
}

async function writeLegacyPartialLaunchState(input: {
  teamName: string;
  expectedMembers: string[];
  confirmedMembers: string[];
  missingMembers: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(
      {
        state: 'partial_launch_failure',
        expectedMembers: input.expectedMembers,
        confirmedMembers: input.confirmedMembers,
        missingMembers: input.missingMembers,
        leadSessionId: 'lead-session',
        updatedAt: '2026-04-23T10:00:00.000Z',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeBootstrapState(
  teamName: string,
  members: Array<{
    name: string;
    status: string;
    lastAttemptAt?: number;
    lastObservedAt?: number;
    failureReason?: string;
  }>
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'bootstrap-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        teamName,
        updatedAt: '2026-04-23T10:00:06.000Z',
        phase: 'completed',
        members,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeLeadInboxMessages(
  teamName: string,
  messages: Array<{
    from: string;
    text: string;
    timestamp: string;
    messageId: string;
    read?: boolean;
  }>
): Promise<void> {
  const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, 'team-lead.json'),
    `${JSON.stringify(
      messages.map((message) => ({
        ...message,
        to: 'team-lead',
        read: message.read ?? false,
      })),
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMemberTranscript(input: {
  projectPath: string;
  sessionId: string;
  records: Record<string, unknown>[];
}): Promise<void> {
  const projectDir = getProjectTranscriptDir(input.projectPath);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    `${input.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
}

async function writeRawMemberTranscript(input: {
  projectPath: string;
  sessionId: string;
  lines: string[];
}): Promise<void> {
  const projectDir = getProjectTranscriptDir(input.projectPath);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    `${input.lines.join('\n')}\n`,
    'utf8'
  );
}

function getProjectTranscriptDir(projectPath: string): string {
  return path.join(getProjectsBasePath(), extractBaseDir(encodePath(projectPath)));
}

function getMemberTranscriptPath(projectPath: string, sessionId: string): string {
  return path.join(getProjectTranscriptDir(projectPath), `${sessionId}.jsonl`);
}

function bootstrapTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'user',
    message: {
      role: 'user',
      content: `You are bootstrapping into team "${input.teamName}" as member "${input.memberName}".`,
    },
  };
}

function bootstrapSuccessTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Member briefing for ${input.memberName} on team "${input.teamName}" (${input.teamName}).\nTask briefing for ${input.memberName}:\nNo actionable tasks.`,
        },
      ],
    },
  };
}

function bootstrapFailureTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
        },
      ],
    },
  };
}

function genericTranscriptApiErrorRecord(input: { timestamp: string }): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
        },
      ],
    },
  };
}

function withoutAgentName(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  delete next.agentName;
  return next;
}

function mixedMemberState(overrides: Record<string, unknown>): Record<string, unknown> {
  const bootstrapConfirmed =
    overrides.bootstrapConfirmed === true || overrides.launchState === 'confirmed_alive';
  return {
    name: overrides.name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
    ...(bootstrapConfirmed ? { lastHeartbeatAt: new Date().toISOString() } : {}),
    ...overrides,
  };
}

function getMixedPrimaryFixture(providerId: MixedPrimaryProviderId = 'codex'): {
  providerId: MixedPrimaryProviderId;
  providerBackendId?: string;
  leadModel: string;
  memberModel: string;
} {
  if (providerId === 'anthropic') {
    return {
      providerId,
      leadModel: 'sonnet',
      memberModel: 'haiku',
    };
  }

  return {
    providerId,
    providerBackendId: 'codex-native',
    leadModel: 'gpt-5.4',
    memberModel: 'gpt-5.4-mini',
  };
}

async function readInboxRows(teamName: string, inboxName: string): Promise<InboxMessage[]> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${inboxName}.json`);
  const raw = await fs.readFile(inboxPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as InboxMessage[]) : [];
}

async function writeTeamMeta(
  teamName: string,
  projectPath: string,
  options: { primaryProviderId?: MixedPrimaryProviderId } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const primary = getMixedPrimaryFixture(options.primaryProviderId);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: primary.providerId,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        model: primary.leadModel,
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamMeta(teamName: string, projectPath: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: 'anthropic',
        model: 'sonnet',
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicMembersMeta(
  teamName: string,
  options: {
    removedMembers?: string[];
    extraMembers?: Array<{ name: string; providerId: 'anthropic'; model: string }>;
  } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const removedMembers = new Set(options.removedMembers ?? []);
  const extraMembers = options.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        members: [
          {
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            providerId: member.providerId,
            model: member.model,
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMembersMeta(
  teamName: string,
  options: {
    includeGeminiPrimary?: boolean;
    includeCodexPrimary?: boolean;
    primaryProviderId?: MixedPrimaryProviderId;
    removedMembers?: string[];
    extraMembers?: Array<{ name: string; providerId: 'opencode'; model: string }>;
    memberCwd?: string;
  } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const primary = getMixedPrimaryFixture(options.primaryProviderId);
  const removedMembers = new Set(options.removedMembers ?? []);
  const extraMembers = options.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        members: [
          {
            name: 'alice',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.memberModel,
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...(options.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                  ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
                  ...(removedMembers.has('reviewer') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          ...(options.includeCodexPrimary
            ? [
                {
                  name: 'cody',
                  providerId: 'codex',
                  providerBackendId: 'codex-native',
                  model: 'gpt-5.4-mini',
                  ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
                  ...(removedMembers.has('cody') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('tom') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            providerId: member.providerId,
            model: member.model,
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}
