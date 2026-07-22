import {
  TeamProvisioningConfigFacade,
  type TeamProvisioningConfigFacadeOptions,
} from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import { createTeamProvisioningLaunchExpectedMembersPorts } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembersPortsFactory';

import {
  readHarnessRegularFileUtf8,
  type TeamProvisioningHarnessPaths,
  validateTeamNamePathSegment,
} from './harnessFilesystem';

import type {
  TeamProvisioningHarnessFacades,
  TeamProvisioningHarnessLogger,
  TeamProvisioningHarnessStores,
} from './TeamProvisioningHarnessBuilder';
import type { TeamProvisioningLaunchExpectedMembersPorts } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';

const ASYNC_TEAM_SCOPED_CONFIG_FACADE_METHODS = [
  'readConfigSnapshot',
  'readConfigForObservation',
  'readConfigForStrictDecision',
  'updateConfigProjectPath',
  'updateConfigPostLaunch',
  'cleanupCliAutoSuffixedMembers',
  'assertConfigLeadOnlyForLaunch',
  'normalizeTeamConfigForLaunch',
  'restorePrelaunchConfig',
  'cleanupPrelaunchBackup',
  'persistMembersMeta',
  'resolveLaunchExpectedMembers',
] as const satisfies readonly (keyof TeamProvisioningConfigFacade)[];

const SYNC_TEAM_SCOPED_CONFIG_FACADE_METHODS = [
  'readPersistedTeamProjectPath',
  'readPersistedRuntimeMembers',
] as const satisfies readonly (keyof TeamProvisioningConfigFacade)[];

function guardConfigFacadeTeamPaths(
  facade: TeamProvisioningConfigFacade
): TeamProvisioningConfigFacade {
  for (const methodName of ASYNC_TEAM_SCOPED_CONFIG_FACADE_METHODS) {
    const method = facade[methodName] as (...args: unknown[]) => unknown;
    Object.defineProperty(facade, methodName, {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        validateTeamNamePathSegment(args[0] as string);
        return Reflect.apply(method, facade, args);
      },
    });
  }
  for (const methodName of SYNC_TEAM_SCOPED_CONFIG_FACADE_METHODS) {
    const method = facade[methodName] as (...args: unknown[]) => unknown;
    Object.defineProperty(facade, methodName, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        validateTeamNamePathSegment(args[0] as string);
        return Reflect.apply(method, facade, args);
      },
    });
  }
  return facade;
}

function createConfigFacade(
  paths: TeamProvisioningHarnessPaths,
  stores: TeamProvisioningHarnessStores,
  logger: TeamProvisioningHarnessLogger
): TeamProvisioningConfigFacade {
  const options: TeamProvisioningConfigFacadeOptions = {
    configReader: stores.configReader,
    inboxReader: stores.inboxReader,
    membersMetaStore: stores.membersMetaStore,
    launchStateStore: stores.launchStateStore,
    persistedTeamConfigCache: new Map(),
    readBootstrapLaunchSnapshot: (teamName) => stores.bootstrapStateStore.read(teamName),
    readRegularFileUtf8: (filePath, readOptions) =>
      readHarnessRegularFileUtf8(paths, filePath, readOptions),
    logger,
  };
  return guardConfigFacadeTeamPaths(new TeamProvisioningConfigFacade(options));
}

function createLaunchExpectedMembersPorts(
  stores: TeamProvisioningHarnessStores,
  logger: TeamProvisioningHarnessLogger
): TeamProvisioningLaunchExpectedMembersPorts {
  return createTeamProvisioningLaunchExpectedMembersPorts({
    launchStateStore: stores.launchStateStore,
    readBootstrapLaunchSnapshot: (teamName) => stores.bootstrapStateStore.read(teamName),
    membersMetaStore: stores.membersMetaStore,
    inboxReader: stores.inboxReader,
    logger,
  });
}

export function createHarnessFacades(
  paths: TeamProvisioningHarnessPaths,
  stores: TeamProvisioningHarnessStores,
  logger: TeamProvisioningHarnessLogger
): TeamProvisioningHarnessFacades {
  return {
    configFacade: createConfigFacade(paths, stores, logger),
    launchExpectedMembersPorts: createLaunchExpectedMembersPorts(stores, logger),
  };
}
