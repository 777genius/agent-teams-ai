import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

import type { TokenUsageRunDto } from '@features/token-usage/contracts';
import type { TeamProviderId } from '@shared/types';

export interface GatewayLaunchSnapshot {
  id: string;
  teamName: string;
  memberName: string;
  providerId: TeamProviderId;
  gatewayUsageRef?: string;
  startedAt: string;
  endedAt?: string;
  runs: TokenUsageRunDto[];
}

/** App-owned launch intent and native-session associations outlive team discovery files. */
export class GatewayRunMetadataStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  snapshotLaunch(input: Omit<GatewayLaunchSnapshot, 'id' | 'startedAt' | 'runs'>): Promise<string> {
    return this.update(async (snapshots) => {
      const id = randomUUID();
      snapshots.push({ ...input, id, startedAt: new Date().toISOString(), runs: [] });
      return id;
    });
  }

  abortUnspawnedLaunch(id: string): Promise<void> {
    return this.update(async (snapshots) => {
      const snapshot = snapshots.find((entry) => entry.id === id);
      if (snapshot?.runs.length === 0 && !snapshot.endedAt)
        snapshot.endedAt = new Date().toISOString();
    });
  }

  confirmLaunchStopped(id: string): Promise<void> {
    return this.update(async (snapshots) => {
      const snapshot = snapshots.find((entry) => entry.id === id);
      if (!snapshot || snapshot.endedAt) return;
      snapshot.endedAt = new Date().toISOString();
      for (const run of snapshot.runs) {
        if (run.terminationConfirmed && run.endedAt) continue;
        run.endedAt = snapshot.endedAt;
        run.status = 'completed';
        run.terminationConfirmed = true;
      }
    });
  }

  confirmNativeTeamStopped(teamName: string): Promise<void> {
    return this.update(async (snapshots) => {
      const endedAt = new Date().toISOString();
      for (const snapshot of snapshots) {
        if (
          snapshot.teamName !== teamName ||
          snapshot.providerId === 'opencode' ||
          snapshot.endedAt
        )
          continue;
        snapshot.endedAt = endedAt;
        for (const run of snapshot.runs) {
          if (run.terminationConfirmed && run.endedAt) continue;
          run.endedAt = endedAt;
          run.status = 'completed';
          run.terminationConfirmed = true;
        }
      }
    });
  }

  reconcileRuns(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageRunDto[]> {
    return this.update(async (snapshots) => {
      const result = runs.map((run) => {
        const associated = snapshots.find((snapshot) =>
          snapshot.runs.some((known) => sessionIdentity(known) === sessionIdentity(run))
        );
        // A lookup uses launch-time facts only. A later binding cannot rewrite a native session.
        const snapshot =
          associated ??
          [...snapshots]
            .reverse()
            .find(
              (candidate) =>
                candidate.teamName === run.teamName &&
                candidate.memberName === run.agentName &&
                candidate.providerId === run.providerId &&
                candidate.providerId !== 'opencode' &&
                candidate.startedAt <= run.startedAt
            );
        if (
          !snapshot?.gatewayUsageRef ||
          (snapshot.endedAt && snapshot.endedAt < run.startedAt && !associated)
        )
          return run;
        const known = snapshot.runs.find((item) => sessionIdentity(item) === sessionIdentity(run));
        const confirmed = known?.terminationConfirmed
          ? { ...run, terminationConfirmed: true, endedAt: known.endedAt, status: known.status }
          : snapshot.endedAt
            ? {
                ...run,
                terminationConfirmed: true,
                endedAt: snapshot.endedAt,
                status: 'completed' as const,
              }
            : run;
        const marked = {
          ...confirmed,
          agentId: run.agentId ?? known?.agentId ?? `${snapshot.teamName}:${snapshot.memberName}`,
          gatewayUsageRef: snapshot.gatewayUsageRef,
          ...(confirmed.terminationConfirmed
            ? {}
            : {
                endedAt: undefined,
                status: run.status === 'running' ? ('running' as const) : ('unknown' as const),
              }),
        };
        const index = snapshot.runs.findIndex(
          (known) => sessionIdentity(known) === sessionIdentity(run)
        );
        if (index < 0) snapshot.runs.push(marked);
        else snapshot.runs[index] = marked;
        return marked;
      });
      const discovered = new Set(result.map(sessionIdentity));
      for (const snapshot of snapshots) {
        if (!snapshot.gatewayUsageRef) continue;
        if (snapshot.runs.length === 0) {
          result.push({
            appRunId: `gateway-launch:${snapshot.id}`,
            teamName: snapshot.teamName,
            agentName: snapshot.memberName,
            agentId: `${snapshot.teamName}:${snapshot.memberName}`,
            providerId: snapshot.providerId,
            runtimeKind: snapshot.providerId,
            gatewayUsageRef: snapshot.gatewayUsageRef,
            startedAt: snapshot.startedAt,
            endedAt: snapshot.endedAt,
            terminationConfirmed: snapshot.endedAt ? true : undefined,
            status: snapshot.endedAt ? 'completed' : 'unknown',
            source: 'team_launch_state',
            sources: [],
          });
        }
        for (const run of snapshot.runs) {
          if (!discovered.has(sessionIdentity(run))) result.push(run);
        }
      }
      return result;
    });
  }

  async hasSourceHistory(gatewayUsageRef: string): Promise<boolean> {
    await this.chain;
    return (await this.read()).some((snapshot) => snapshot.gatewayUsageRef === gatewayUsageRef);
  }

  async hasUnfinishedRuns(gatewayUsageRef: string): Promise<boolean> {
    await this.chain;
    return hasUnfinished(await this.read(), gatewayUsageRef);
  }

  /** Excludes new launch snapshots while a stopped source's artifact is being retired. */
  runWhenStopped(gatewayUsageRef: string, action: () => Promise<void>): Promise<void> {
    return this.update(async (snapshots) => {
      if (!hasUnfinished(snapshots, gatewayUsageRef)) await action();
    });
  }

  recordOpenCodeSessions(
    teamName: string,
    members: readonly { memberName: string; sessionId?: string; runtimeAlive: boolean }[],
    launchSnapshotIds: readonly string[]
  ): Promise<void> {
    if (launchSnapshotIds.length === 0) return Promise.resolve();
    const allowed = new Set(launchSnapshotIds);
    return this.update(async (snapshots) => {
      for (const member of members) {
        if (!member.sessionId) continue;
        const snapshot = [...snapshots]
          .reverse()
          .find(
            (entry) =>
              allowed.has(entry.id) &&
              entry.teamName === teamName &&
              entry.memberName === member.memberName &&
              entry.providerId === 'opencode'
          );
        if (
          !snapshot?.gatewayUsageRef ||
          snapshot.runs.some((run) =>
            run.sources.some((source) => source.nativeSessionId === member.sessionId)
          )
        )
          continue;
        const appRunId = `team:${teamName}:member:${member.memberName}:opencode:${member.sessionId}`;
        snapshot.runs.push({
          appRunId,
          teamName,
          agentName: member.memberName,
          agentId: `${teamName}:${member.memberName}`,
          providerId: 'opencode',
          runtimeKind: 'opencode',
          gatewayUsageRef: snapshot.gatewayUsageRef,
          startedAt: snapshot.startedAt,
          status: member.runtimeAlive ? 'running' : 'unknown',
          source: 'team_launch_state',
          sources: [
            {
              id: `${appRunId}:session`,
              appRunId,
              sourceType: 'runtime_trace',
              nativeSessionId: member.sessionId,
              discoveredAt: new Date().toISOString(),
            },
          ],
        });
      }
    });
  }

  confirmOpenCodeStopped(
    teamName: string,
    members: readonly { memberName: string; sessionId?: string; stopped: boolean }[]
  ): Promise<void> {
    return this.update(async (snapshots) => {
      const endedAt = new Date().toISOString();
      for (const snapshot of snapshots) {
        if (snapshot.teamName !== teamName || snapshot.providerId !== 'opencode') continue;
        for (const member of members) {
          if (!member.stopped || snapshot.memberName !== member.memberName) continue;
          if (snapshot.runs.length === 0 && !member.sessionId && !snapshot.endedAt)
            snapshot.endedAt = endedAt;
          for (const run of snapshot.runs) {
            if (run.terminationConfirmed && run.endedAt) continue;
            if (
              member.sessionId &&
              !run.sources.some((source) => source.nativeSessionId === member.sessionId)
            )
              continue;
            run.endedAt = endedAt;
            run.status = 'completed';
            run.terminationConfirmed = true;
          }
        }
      }
    });
  }

  private update<T>(change: (snapshots: GatewayLaunchSnapshot[]) => Promise<T>): Promise<T> {
    const work = this.chain.then(async () => {
      const snapshots = await this.read();
      const result = await change(snapshots);
      await atomicWriteAsync(this.filePath, JSON.stringify({ schemaVersion: 1, snapshots }), {
        mode: 0o600,
        directoryMode: 0o700,
      });
      return result;
    });
    this.chain = work.catch(() => {});
    return work;
  }

  private async read(): Promise<GatewayLaunchSnapshot[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as {
        snapshots?: GatewayLaunchSnapshot[];
      };
      if (!Array.isArray(value.snapshots)) throw new Error('Invalid gateway launch metadata');
      return value.snapshots;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function sessionIdentity(run: TokenUsageRunDto): string {
  return JSON.stringify([
    run.teamName,
    run.agentName,
    run.sources.find((source) => source.nativeSessionId)?.nativeSessionId ?? run.appRunId,
  ]);
}

function hasUnfinished(snapshots: readonly GatewayLaunchSnapshot[], ref: string): boolean {
  return snapshots.some(
    (snapshot) =>
      snapshot.gatewayUsageRef === ref &&
      ((!snapshot.endedAt && snapshot.runs.length === 0) ||
        snapshot.runs.some(
          (run) => !run.endedAt || (run.status !== 'completed' && run.status !== 'failed')
        ))
  );
}
