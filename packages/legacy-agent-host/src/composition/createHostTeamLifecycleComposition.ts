import { join } from 'node:path';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../team/contracts.js';
import { deliveryFingerprint } from '../runtime/identity.js';
import { createTeamBackupComposition } from './createTeamBackupComposition.js';
import { createTeamLifecycleMethods } from './createTeamLifecycleMethods.js';
import { createTeamLifecycleRetirement } from './createTeamLifecycleRetirement.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam, RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import type { TeamRuntimeDeliveryPort } from '../team/contracts.js';
import type { FileStoppedTeamImport } from '../stopped-team-import/FileStoppedTeamImport.js';
import type { ProcessCustody } from './processCustody.js';
import type { WindowsRegisteredProcessPort } from '../owned-process/retainedServiceContracts.js';

/** One captured storage lifetime for lifecycle, backup and the native WorkSync identity port. */
export function createHostTeamLifecycleComposition(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: Map<string, HostedTeam>;
  runtime(): Pick<RuntimeTeamCoordinator, 'lifecyclePorts'> | undefined;
  importer(): Pick<FileStoppedTeamImport, 'publication'> | undefined;
  processCustody?: Pick<NonNullable<ProcessCustody>, 'observe'>;
  windows?: Omit<WindowsRegisteredProcessPort, 'prepareCapture'>;
  assertCurrent(): void;
  assertWriter(): void;
  isShuttingDown(): boolean;
}) {
  const { profile, teams } = options;
  const stores = new Map<string, TeamOwnerStore>();
  const resources = (teamId: string) => {
    const team = teams.get(teamId), store = stores.get(teamId);
    if (!team || !store) throw new TeamOwnerError('hold');
    return { team, store };
  };
  const processCommands = (teamId: string) => resources(teamId).team.owner.processCommands(profile.principalId, {
    assertCurrent: options.assertCurrent,
    assertAsyncCurrent: options.assertCurrent,
    ...(options.windows ? { windows: {
      prepareControl: (capture, operation) => options.windows!.prepareControl(capture, operation),
      run: (intent, deadline) => options.windows!.run(intent, deadline),
      lookup: (intent, deadline) => options.windows!.lookup(intent, deadline),
      query: (capture, deadline) => options.windows!.query(capture, deadline),
    } } : {}),
    ...(options.processCustody ? { native: {
      capture() { throw new TeamOwnerError('forbidden'); },
      observe(capture) {
        options.assertCurrent();
        const value = options.processCustody!.observe(capture);
        options.assertCurrent();
        return value;
      },
      signal() { throw new TeamOwnerError('forbidden'); },
    } } : {}),
  });
  const storage = createTeamBackupComposition({
    directories: { teams: join(profile.owner.storageRoot, 'teams'), tasks: join(profile.owner.storageRoot, 'tasks'),
      appData: join(profile.owner.storageRoot, 'appData'), backups: join(profile.owner.storageRoot, 'backups') },
    principalId: profile.principalId,
    ownerId: profile.owner.ownerId,
    resources,
    assertCurrent: options.assertCurrent,
    assertWriter: options.assertWriter,
    teamIds: () => [...teams.keys()],
    isShuttingDown: options.isShuttingDown,
    importer: options.importer,
    assertBackupPrunable(teamName, identityId) {
      options.assertCurrent();
      const intent = storage.coordinator.readOwnerDeletionIntentSync(teamName, identityId), request = intent?.ownerRequest;
      if (!intent || intent.phase !== 'deleted' || !intent.cleanupCompleted || !request ||
        request.principalId !== profile.principalId || request.binding.backendId !== profile.owner.ownerId ||
        request.binding.teamName !== teamName || request.binding.teamId !== identityId || teams.has(identityId)) throw new TeamOwnerError('hold');
    },
    purge: {
      ...(options.windows ? {
        async prepareReferencesReleased(teamId: string, originalDeadline: number) {
          options.assertCurrent();
          const commands = processCommands(teamId).windows;
          if (!commands) throw new TeamOwnerError('hold');
          await commands.reconcileNaturalAbsence(originalDeadline);
          options.assertCurrent();
        },
      } : {}),
      assertReferencesReleased(teamId) {
        options.assertCurrent();
        processCommands(teamId).assertReleased();
      },
      onPurged(teamId) {
        const team = teams.get(teamId);
        if (team) retirement.retainPurged(team.definition);
        teams.delete(teamId); stores.delete(teamId);
      },
    },
  });
  const retirement = createTeamLifecycleRetirement({ owner: profile.owner, principalId: profile.principalId, coordinator: storage.coordinator, assertCurrent: options.assertCurrent });
  // No Runtime exists to prove an old retained input absent. Even lookup therefore holds.
  const unconfiguredDelivery: TeamRuntimeDeliveryPort = {
    fingerprintDelivery: deliveryFingerprint,
    async admitDelivery() { throw new TeamOwnerError('hold'); },
    async lookupDelivery() { throw new TeamOwnerError('hold'); },
    async cancelDelivery() { throw new TeamOwnerError('hold'); },
  };
  const lifecycle = createTeamLifecycleMethods({
    profile, teams, storage, retirement, assertCurrent: options.assertCurrent,
    delivery: () => options.runtime()?.lifecyclePorts().delivery ?? unconfiguredDelivery,
    async afterTrash(team, commandId) {
      options.assertCurrent();
      const runtime = options.runtime();
      if (runtime) {
        const ports = runtime.lifecyclePorts();
        await team.owner.continueLifecycleCleanup(commandId, ports.runtime, ports.delivery);
      } else {
        team.owner.lifecycleContinuation().settleCleanup(commandId, receipt => {
          if (receipt.runtimeBindings.length || receipt.targets.length) throw new TeamOwnerError('hold');
        });
      }
    },
  });
  return {
    stores, storage, retirement, methods: lifecycle.methods,
    async shutdown() {
      const result = await storage.shutdown();
      if (result.heldTeamIds.length) {
        const failure = new Error(`Team shutdown backup held: ${JSON.stringify(result.heldTeamIds)}`);
        throw Object.assign(failure, { heldTeamIds: result.heldTeamIds });
      }
    },
  };
}
