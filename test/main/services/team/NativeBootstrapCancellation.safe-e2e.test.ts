// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTeamProvisioningCancellationBoundary } from '@main/services/team/provisioning/TeamProvisioningCancellationBoundary';
import { killTeamProcessAndWait } from '@main/services/team/provisioning/TeamProvisioningRunProgress';
import {
  killProcessTreeAndWait,
  killTrackedCliProcesses,
  spawnCli,
} from '@main/utils/childProcess';
import { isSameUnixProcessIdentity, readUnixProcessTable } from '@main/utils/unixProcessTable';
import { expect, it, vi } from 'vitest';

import type {
  TeamProvisioningCancellationBoundaryPorts,
  TeamProvisioningCancellationRun,
} from '@main/services/team/provisioning/TeamProvisioningCancellationBoundary';
import type { UnixProcessIdentity } from '@main/utils/unixProcessTable';
import type { TeamProvisioningProgress } from '@shared/types';

it.skipIf(process.platform === 'win32')(
  'cancel during native bootstrap confirms detached children gone before cancelled/offline and app shutdown',
  async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'TEST-native-bootstrap-cancel-'));
    const marker = path.join(project, 'processes.json');
    const fixture = fileURLToPath(
      new URL('./fixtures/nativeCancellationProcess.ts', import.meta.url)
    );
    const child = spawnCli(process.execPath, [fixture, 'lead', marker], {
      cwd: project,
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'ignore',
    });
    const captured = new Map<number, UnixProcessIdentity>();
    try {
      let pids: { leadPid: number; memberPid: number; providerPid: number } | undefined;
      const deadline = Date.now() + 10_000;
      while (!pids && Date.now() < deadline) {
        pids = await readFile(marker, 'utf8')
          .then((value) => JSON.parse(value))
          .catch(() => undefined);
        if (!pids) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pids).toBeDefined();
      expect(pids!.leadPid).toBe(child.pid);
      const before = readUnixProcessTable(child.pid!);
      for (const pid of Object.values(pids!)) {
        expect(before.has(pid)).toBe(true);
        captured.set(pid, before.get(pid)!);
      }
      expect(before.get(pids!.memberPid)!.processGroupId).toBe(pids!.memberPid);
      expect(before.get(pids!.providerPid)!.processGroupId).toBe(pids!.providerPid);
      const assertGone = () => {
        const current = readUnixProcessTable(child.pid!);
        for (const [pid, identity] of captured)
          expect(isSameUnixProcessIdentity(identity, current.get(pid))).toBe(false);
      };
      const progress: TeamProvisioningProgress = {
        runId: 'TEST-cancel-run',
        teamName: 'TEST-cancel-team',
        state: 'spawning',
        message: 'Bootstrap',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const run: TeamProvisioningCancellationRun = {
        runId: progress.runId,
        teamName: progress.teamName,
        progress,
        child,
        cancelRequested: false,
        processKilled: false,
        anthropicApiKeyHelper: null,
        anthropicApiKeyHelperCleanupPromise: null,
        onProgress: vi.fn((next) => {
          if (next.state === 'cancelled') assertGone();
        }),
      };
      const cleanupRun = vi.fn(assertGone);
      const ports: TeamProvisioningCancellationBoundaryPorts<TeamProvisioningCancellationRun> = {
        runs: new Map([[run.runId, run]]),
        runtimeAdapterProgressByRunId: new Map(),
        cancelledRuntimeAdapterRunIds: new Set(),
        runtimeAdapterRunByTeam: new Map(),
        provisioningRunByTeam: new Map([[run.teamName, run.runId]]),
        aliveRunByTeam: new Map(),
        getTrackedRunId: () => run.runId,
        deleteAliveRunId: () => {},
        hasSecondaryRuntimeRuns: () => false,
        stopMixedSecondaryRuntimeLanes: async () => {},
        stopOpenCodeRuntimeAdapterTeam: async () => {},
        killTeamProcess: () => {},
        killTeamProcessAndWait: (target) => killTeamProcessAndWait(target as typeof child),
        updateProgress: (_run, state, message) =>
          (run.progress = { ...run.progress, state, message }),
        cleanupRun,
        nowIso: () => new Date().toISOString(),
        clearOpenCodeRuntimeToolApprovals: () => {},
        invalidateRuntimeSnapshotCaches: () => {},
        setRuntimeAdapterProgress: (value) => value,
        emitTeamChange: () => {},
        readLaunchState: async () => null,
        getOpenCodeRuntimeAdapter: () => null,
        readPersistedTeamProjectPath: () => project,
        logWarning: () => {},
      };
      await createTeamProvisioningCancellationBoundary(ports).cancelProvisioning(run.runId);
      expect(run.progress.state).toBe('cancelled');
      expect(cleanupRun).toHaveBeenCalledOnce();
      assertGone();
      killTrackedCliProcesses('SIGKILL'); // The same process shutdown primitive the app closes with.
      assertGone();
    } finally {
      await killProcessTreeAndWait(child, 'SIGKILL').catch(() => {});
      for (const [pid, identity] of captured) {
        if (isSameUnixProcessIdentity(identity, readUnixProcessTable(child.pid!).get(pid)))
          process.kill(pid, 'SIGKILL');
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const current = readUnixProcessTable(child.pid!);
        if (
          ![...captured].some(([pid, identity]) =>
            isSameUnixProcessIdentity(identity, current.get(pid))
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const remaining = readUnixProcessTable(child.pid!);
      for (const [pid, identity] of captured)
        expect(isSameUnixProcessIdentity(identity, remaining.get(pid))).toBe(false);
      await rm(project, { recursive: true, force: true });
    }
  },
  20_000
);
