import { proveNoRosterLaunchInvocationResources } from './proveNoRosterLaunchInvocationResources';
import { readBootstrapRosterLaunchEvidence } from './readBootstrapRosterLaunchEvidence';
import { decodeAuthorizedRoster } from './rosterAuthorizationRecordValidation';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamRosterAuthorizationTransactionService } from './TeamRosterAuthorizationTransactionService';

import type { TeamMembersMetaStore } from './TeamMembersMetaStore';

const services = new WeakMap<TeamMembersMetaStore, TeamRosterAuthorizationTransactionService>();

export function getRosterAuthorizationTransactionService(
  store: TeamMembersMetaStore
): TeamRosterAuthorizationTransactionService {
  let service = services.get(store);
  if (!service) {
    service = new TeamRosterAuthorizationTransactionService(store, {
      proveNoInvocationResources: (record, command) =>
        proveNoRosterLaunchInvocationResources(record.teamName, command.launchCommandId),
      reconcileUnknownLaunch: async (record, command) => {
        const snapshot = await new TeamLaunchStateStore().read(record.teamName);
        const members = snapshot ? Object.values(snapshot.members) : [];
        const owned = members.filter((member) => member.runtimeRunId === command.launchCommandId);
        if (owned.some((member) => member.launchState === 'confirmed_alive')) {
          return {
            state: 'started',
            result: {
              transactionId: record.transactionId,
              teamName: record.teamName,
              rosterFingerprint: record.targetFingerprint,
              rosterRevision: record.requestFingerprint,
              launchCommandId: command.launchCommandId,
              executionProof: record.executionProof,
              launchRequestFingerprint: record.launchRequestFingerprint,
              runId: command.launchCommandId,
              attemptId: command.launchCommandId,
              launchStatus: 'started',
            },
          };
        }
        // A live or retained attempt-owned runtime vetoes historical all-failed
        // bootstrap evidence, but is not sufficient to commit as started.
        if (owned.some((member) => member.runtimeAlive || member.runtimePid !== undefined)) {
          return { state: 'unknown' };
        }
        const evidence = await readBootstrapRosterLaunchEvidence(
          record.teamName,
          command.launchCommandId,
          decodeAuthorizedRoster(record).map((member) => member.name)
        );
        const resolvedEvidence = evidence;
        if (resolvedEvidence.state !== 'started') return resolvedEvidence;
        return {
          state: 'started',
          result: {
            transactionId: record.transactionId,
            teamName: record.teamName,
            rosterFingerprint: record.targetFingerprint,
            rosterRevision: record.requestFingerprint,
            launchCommandId: command.launchCommandId,
            executionProof: record.executionProof,
            launchRequestFingerprint: record.launchRequestFingerprint,
            runId: command.launchCommandId,
            attemptId: command.launchCommandId,
            launchStatus: 'started',
          },
        };
      },
    });
    services.set(store, service);
  }
  return service;
}

export async function recoverRosterAuthorizationTeams(
  store: TeamMembersMetaStore,
  teamNames: readonly string[]
): Promise<void> {
  const service = getRosterAuthorizationTransactionService(store);
  const startedAt = Date.now();
  const orderedTeamNames = [...new Set(teamNames)].sort();
  let processed = 0;
  for (const teamName of orderedTeamNames) {
    if (processed >= 16 || (processed > 0 && Date.now() - startedAt >= 25)) break;
    await service.recoverTeam(teamName).catch(() => undefined);
    processed += 1;
  }
  if (processed < orderedTeamNames.length) {
    setImmediate(() => {
      void recoverRosterAuthorizationTeams(store, orderedTeamNames.slice(processed));
    });
  }
}
