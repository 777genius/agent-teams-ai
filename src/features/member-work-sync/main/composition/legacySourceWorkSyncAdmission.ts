import { AsyncLocalStorage } from 'node:async_hooks';

import {
  MemberWorkSyncTeamQuiescedError,
  normalizeMemberWorkSyncTeamOperationKey,
} from '../../core/application';
import { MemberWorkSyncTeamChangeRouter } from '../adapters/input/MemberWorkSyncTeamChangeRouter';
import { FileMemberWorkSyncAuditJournal } from '../infrastructure/FileMemberWorkSyncAuditJournal';
import { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import { QuiescingMemberWorkSyncAuditJournal } from '../infrastructure/QuiescingMemberWorkSyncAuditJournal';

import type { MemberWorkSyncLoggerPort } from '../../core/application';
import type {
  MemberWorkSyncTeamOperationAdmission,
  MemberWorkSyncTeamOperationGate,
} from '../../core/application';
import type { LegacySourceWriteAdmissionPolicy } from '@agent-teams/legacy-agent-host/lifecycle';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamChangeEvent } from '@shared/types';

/** Existing producer admissions retain their original source through async descendants. */
export function createLegacySourceWorkSyncAdmission(
  gate: MemberWorkSyncTeamOperationGate,
  policy?: LegacySourceWriteAdmissionPolicy
) {
  const ingress = new AsyncLocalStorage<{ teamKey: string }>();
  const closures = new Map<string, Set<symbol>>();
  const enter = <T>(teamName: string, operation: () => T, skipped: () => T): T => {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const original = ingress.getStore();
    if (original && original.teamKey !== teamKey)
      throw new Error('Legacy source WorkSync admission differs');
    if (!original && closures.has(teamKey)) return skipped();
    const admission = policy?.capture(teamName);
    if (admission?.kind === 'read-only') return skipped();
    return ingress.run(original ?? { teamKey }, () =>
      admission ? admission.run(operation) : operation()
    );
  };
  const bindExecution = (teamName: string) => {
    const original = ingress.getStore();
    if (!original || original.teamKey !== normalizeMemberWorkSyncTeamOperationKey(teamName))
      throw new Error('Missing original WorkSync ingress');
    const source = policy?.bindExecution(teamName);
    return Object.freeze({
      assertCurrent: () => source?.assertCurrent(),
      run: <T>(operation: () => T): T =>
        ingress.run(original, () => (source ? source.run(operation) : operation())),
    });
  };
  return {
    bindExecution,
    /** Close new producers without revoking the exact work already captured by the queue. */
    beginOwnedTeamQuiesce(teamName: string) {
      const key = normalizeMemberWorkSyncTeamOperationKey(teamName),
        token = Symbol('WorkSync ingress');
      if (ingress.getStore()?.teamKey === key)
        throw new Error('Cannot fence an admitted WorkSync operation');
      const owners = closures.get(key) ?? new Set<symbol>();
      owners.add(token);
      closures.set(key, owners);
      return {
        release() {
          owners.delete(token);
          if (!owners.size && closures.get(key) === owners) closures.delete(key);
        },
      };
    },
    captureExecution(teamName: string) {
      return enter(
        teamName,
        () => bindExecution(teamName),
        () => null
      );
    },
    createAudit(paths: MemberWorkSyncStorePaths, logger?: MemberWorkSyncLoggerPort) {
      return new QuiescingMemberWorkSyncAuditJournal(
        new FileMemberWorkSyncAuditJournal(paths, logger, { sourceWriteAdmission: policy })
      );
    },
    run<T>(
      teamName: string,
      operation: (admission: MemberWorkSyncTeamOperationAdmission) => Promise<T>
    ): Promise<T> {
      return enter(
        teamName,
        () => gate.run(teamName, operation),
        () => Promise.reject(new MemberWorkSyncTeamQuiescedError(teamName))
      );
    },
    async scan(teamNames: string[], operation: (teamName: string) => Promise<void>): Promise<void> {
      for (const teamName of teamNames)
        await enter(
          teamName,
          () => operation(teamName),
          () => Promise.resolve()
        );
    },
    createRouter(
      roster: ConstructorParameters<typeof MemberWorkSyncTeamChangeRouter>[0],
      queue: ConstructorParameters<typeof MemberWorkSyncTeamChangeRouter>[1],
      impact: ConstructorParameters<typeof MemberWorkSyncTeamChangeRouter>[3],
      teamsRoot: string
    ) {
      return new MemberWorkSyncTeamChangeRouter(
        roster,
        queue,
        {
          materializeMember: (team, member) => {
            const admission = policy?.current(team);
            const operation = () =>
              new MemberWorkSyncStorePaths(
                teamsRoot,
                admission?.assertCurrent
              ).ensureMemberWorkSyncDir(team, member);
            return admission ? admission.publish(operation) : operation();
          },
        },
        impact
      );
    },
    notify(
      event: TeamChangeEvent,
      note: (event: TeamChangeEvent) => void,
      intercept: (event: TeamChangeEvent) => boolean,
      route: (event: TeamChangeEvent) => void,
      replay: (teams: string[]) => Promise<unknown>
    ): void {
      enter(
        event.teamName,
        () => {
          note(event);
          if (intercept(event)) return;
          route(event);
          if (event.type === 'process' || event.type === 'member-spawn')
            void replay([event.teamName]);
        },
        () => undefined
      );
    },
  };
}

interface LegacySourceReadFencePorts {
  gate: MemberWorkSyncTeamOperationGate;
  ingress?: { beginOwnedTeamQuiesce(teamName: string): { release(): void } };
  router: { awaitTeamIdle(teamName: string): Promise<void> };
  queue: {
    awaitTeamIdle(teamName: string, options?: { includeQueued?: boolean }): Promise<void>;
    getDiagnostics(): {
      queuedItems: { teamName: string }[];
      runningItems: { teamName: string }[];
    };
  };
  audit: { awaitTeamIdle(teamName: string): Promise<void> };
  isCurrent?(): boolean;
}

/** Main captures this closure synchronously; draining must run outside owner/publication locks. */
export function captureLegacySourceReadFence(teamName: string, ports: LegacySourceReadFencePorts) {
  const ingress = ports.ingress?.beginOwnedTeamQuiesce(teamName);
  let closure = ingress ? undefined : ports.gate.beginOwnedTeamQuiesce(teamName);
  let released = false;
  let drained = false;
  const assertCurrent = () => {
    if (released || ports.isCurrent?.() === false)
      throw new Error('Legacy source WorkSync owner changed');
  };
  const assertNoPendingMaintenance = () => {
    const pending = ports.queue.getDiagnostics();
    if (
      [...pending.queuedItems, ...pending.runningItems].some(
        (item) =>
          normalizeMemberWorkSyncTeamOperationKey(item.teamName) ===
          normalizeMemberWorkSyncTeamOperationKey(teamName)
      )
    )
      throw new Error('Legacy source has pending WorkSync maintenance');
  };
  return Object.freeze({
    async drain(): Promise<void> {
      assertCurrent();
      await ports.gate.awaitTeamIdle(teamName);
      await ports.router.awaitTeamIdle(teamName);
      await ports.queue.awaitTeamIdle(teamName, ingress ? { includeQueued: true } : undefined);
      if (ingress) {
        await ports.gate.awaitTeamIdle(teamName);
        assertCurrent();
        closure ??= ports.gate.beginOwnedTeamQuiesce(teamName);
      }
      await ports.audit.awaitTeamIdle(teamName);
      assertCurrent();
      assertNoPendingMaintenance();
      drained = true;
    },
    assertDrained(): void {
      assertCurrent();
      if (!drained) throw new Error('Legacy source WorkSync drain is unconfirmed');
      assertNoPendingMaintenance();
    },
    release(): void {
      if (released) return;
      released = true;
      closure?.release();
      ingress?.release();
    },
  });
}

/** Main import read only: seal admission first and drain outside identity/publication locks. */
export async function withLegacySourceReadFence<T>(
  teamName: string,
  read: () => Promise<T>,
  ports: LegacySourceReadFencePorts
): Promise<T> {
  const closure = captureLegacySourceReadFence(teamName, ports);
  try {
    await closure.drain();
    return await read();
  } finally {
    closure.release();
  }
}

export function createLegacyWorkSyncConfigReader(reader: TeamConfigReader) {
  return {
    listTeams: () =>
      typeof reader.listTeams === 'function' ? reader.listTeams() : Promise.resolve([]),
    getConfig: (teamName: string) =>
      typeof reader.getConfigSnapshot === 'function'
        ? reader.getConfigSnapshot(teamName)
        : reader.getConfig(teamName),
  };
}
