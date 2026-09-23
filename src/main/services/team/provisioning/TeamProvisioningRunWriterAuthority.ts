import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  withAtomicWriteCommitGuard,
} from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { TeamProvisioningProgress } from '@shared/types';

interface TrackedRunLease {
  teamName: string;
  runId: string | null;
  earlyCleanups: Set<string>;
  cleanupSeen: boolean;
  pendingWrites: number;
  generation: DurablePathIdentity | null;
  release(): void;
}

type WorkflowLease = <T>(
  teamName: string,
  operation: () => Promise<T>,
  continuation?: { assertGeneration(): void }
) => Promise<T>;

function observeTeamGeneration(teamName: string): DurablePathIdentity | null {
  try {
    const stats = fs.lstatSync(path.join(getTeamsBasePath(), teamName));
    return stats.isDirectory() && !stats.isSymbolicLink() ? getDurablePathIdentity(stats) : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the desktop writer lease through a spawned run, including its detached
 * process-close callbacks. A deletion drains this lease or fails in 30 seconds.
 */
export class TeamProvisioningRunWriterAuthority {
  private workflowLease: WorkflowLease | null = null;
  private readonly runs = new Set<TrackedRunLease>();

  configure(workflowLease: WorkflowLease): void {
    this.workflowLease = workflowLease;
  }

  isConfigured(): boolean {
    return this.workflowLease !== null;
  }

  async start<T extends { runId: string; launchStatus?: string }>(
    teamName: string,
    onProgress: (progress: TeamProvisioningProgress) => void,
    operation: (report: (progress: TeamProvisioningProgress) => void) => Promise<T>,
    isRunTracked: (runId: string) => boolean = () => true
  ): Promise<T> {
    if (!this.workflowLease) return operation(onProgress);
    let endHold!: () => void;
    let entered!: () => void;
    let failedToEnter!: (error: unknown) => void;
    const hold = new Promise<void>((resolve) => {
      endHold = resolve;
    });
    const admitted = new Promise<void>((resolve, reject) => {
      entered = resolve;
      failedToEnter = reject;
    });
    void this.workflowLease(teamName, async () => {
      entered();
      await hold;
    }).catch(failedToEnter);
    await admitted;

    const lease: TrackedRunLease = {
      teamName,
      runId: null,
      earlyCleanups: new Set(),
      cleanupSeen: false,
      pendingWrites: 0,
      generation: observeTeamGeneration(teamName),
      release: () => {
        if (!this.runs.delete(lease)) return;
        endHold();
      },
    };
    this.runs.add(lease);
    try {
      const response = await operation((progress) => {
        lease.runId ??= progress.runId;
        lease.generation ??= observeTeamGeneration(teamName);
        onProgress(progress);
      });
      lease.runId = response.runId;
      lease.generation ??= observeTeamGeneration(teamName);
      if (
        response.launchStatus === 'already_launching' ||
        response.launchStatus === 'already_running'
      ) {
        lease.release();
      } else {
        lease.cleanupSeen =
          lease.earlyCleanups.has(response.runId) || !isRunTracked(response.runId);
        this.releaseIfSettled(lease);
      }
      return response;
    } catch (error) {
      // A launched run may report failure while its process-close or rollback
      // continuation is still queued. Keep the lease until cleanup observes it.
      if (lease.runId === null) {
        lease.release();
      } else if (lease.earlyCleanups.has(lease.runId) || !isRunTracked(lease.runId)) {
        lease.cleanupSeen = true;
        this.releaseIfSettled(lease);
      }
      throw error;
    }
  }

  assertCurrent(run: { teamName: string; runId: string }): void {
    if (!this.workflowLease) return;
    const lease = this.findLease(run);
    if (!lease) this.throwExpired(run.teamName);
    this.assertGeneration(lease);
  }

  cleaned(run: { teamName: string; runId: string }): void {
    for (const lease of this.runs) {
      if (lease.teamName !== run.teamName) continue;
      if (lease.runId === null) lease.earlyCleanups.add(run.runId);
      if (lease.runId !== run.runId) continue;
      lease.cleanupSeen = true;
      this.releaseIfSettled(lease);
    }
  }

  async persistForRun<T>(
    run: { teamName: string; runId: string },
    operation: () => Promise<T>
  ): Promise<T> {
    if (!this.workflowLease) return operation();
    const lease = this.findLease(run);
    if (!lease) this.throwExpired(run.teamName);
    lease.pendingWrites += 1;
    try {
      return await this.workflowLease(
        run.teamName,
        () => withAtomicWriteCommitGuard(() => this.assertGeneration(lease), operation),
        {
          assertGeneration: () => this.assertGeneration(lease),
        }
      );
    } finally {
      lease.pendingWrites -= 1;
      this.releaseIfSettled(lease);
    }
  }

  private releaseIfSettled(lease: TrackedRunLease): void {
    if (lease.cleanupSeen && lease.pendingWrites === 0) lease.release();
  }

  private findLease(run: { teamName: string; runId: string }): TrackedRunLease | undefined {
    return [...this.runs].find(
      (lease) => lease.teamName === run.teamName && lease.runId === run.runId
    );
  }

  private assertGeneration(lease: TrackedRunLease): void {
    const current = observeTeamGeneration(lease.teamName);
    if (
      !lease.generation ||
      !current ||
      !isSameDurablePathIdentity(lease.generation, current) ||
      lease.generation.birthtimeMs !== current.birthtimeMs
    ) {
      this.throwExpired(lease.teamName);
    }
  }

  private throwExpired(teamName: string): never {
    throw new Error(`operator_required: provisioning run writer authority expired: ${teamName}`);
  }
}
