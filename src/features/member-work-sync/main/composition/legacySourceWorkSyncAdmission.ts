import { MemberWorkSyncTeamQuiescedError } from '../../core/application';
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
  const enter = <T>(teamName: string, operation: () => T, skipped: () => T): T => {
    const admission = policy?.capture(teamName);
    if (admission?.kind === 'read-only') return skipped();
    return admission ? admission.run(operation) : operation();
  };
  return {
    captureExecution(teamName: string) {
      const admission = policy?.capture(teamName);
      if (admission?.kind === 'read-only') return null;
      return admission?.run(() => policy!.bindExecution(teamName));
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

/** Main import read only: seal admission first and drain outside identity/publication locks. */
export async function withLegacySourceReadFence<T>(
  teamName: string,
  read: () => Promise<T>,
  ports: {
    gate: MemberWorkSyncTeamOperationGate;
    router: { awaitTeamIdle(teamName: string): Promise<void> };
    queue: {
      awaitTeamIdle(teamName: string): Promise<void>;
      getDiagnostics(): {
        queuedItems: { teamName: string }[];
        runningItems: { teamName: string }[];
      };
    };
    audit: { awaitTeamIdle(teamName: string): Promise<void> };
  }
): Promise<T> {
  const closure = ports.gate.beginOwnedTeamQuiesce(teamName);
  try {
    await ports.gate.awaitTeamIdle(teamName);
    await ports.router.awaitTeamIdle(teamName);
    await ports.queue.awaitTeamIdle(teamName);
    await ports.audit.awaitTeamIdle(teamName);
    const pending = ports.queue.getDiagnostics();
    if (
      [...pending.queuedItems, ...pending.runningItems].some((item) => item.teamName === teamName)
    )
      throw new Error('Legacy source has pending WorkSync maintenance');
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
