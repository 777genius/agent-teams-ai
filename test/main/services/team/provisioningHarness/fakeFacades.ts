import {
  TeamProvisioningConfigFacade,
  type TeamProvisioningConfigFacadeOptions,
} from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import { createTeamProvisioningLaunchExpectedMembersPorts } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembersPortsFactory';

import {
  readHarnessRegularFileUtf8,
  type TeamProvisioningHarnessPaths,
} from './harnessFilesystem';

import type {
  TeamProvisioningHarnessFacades,
  TeamProvisioningHarnessLogger,
  TeamProvisioningHarnessStores,
} from './TeamProvisioningHarnessBuilder';
import type { TeamProvisioningLaunchExpectedMembersPorts } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';

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
  return new TeamProvisioningConfigFacade(options);
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
