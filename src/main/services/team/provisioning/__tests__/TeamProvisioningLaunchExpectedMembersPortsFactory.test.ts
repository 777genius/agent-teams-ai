import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLaunchExpectedMembersPorts,
  type TeamProvisioningLaunchExpectedMembersPortsFactoryDeps,
} from '../TeamProvisioningLaunchExpectedMembersPortsFactory';

import type { TeamMember } from '@shared/types';

describe('team provisioning launch expected members ports factory', () => {
  it('wires launch expected members ports to explicit provisioning dependencies', async () => {
    const launchSnapshot = { source: 'launch-state' };
    const bootstrapSnapshot = { source: 'bootstrap-state' };
    const members: TeamMember[] = [{ name: 'Worker', role: 'Engineer' }];
    const inboxNames = ['Worker'];
    const deps = makeDeps({
      launchStateStore: {
        read: vi.fn(async () => launchSnapshot),
      },
      readBootstrapLaunchSnapshot: vi.fn(async () => bootstrapSnapshot),
      membersMetaStore: {
        getMembers: vi.fn(async () => members),
      },
      inboxReader: {
        listInboxNames: vi.fn(async () => inboxNames),
      },
    });

    const ports = createTeamProvisioningLaunchExpectedMembersPorts(deps);

    await expect(ports.readLaunchState('alpha')).resolves.toBe(launchSnapshot);
    await expect(ports.readBootstrapLaunchSnapshot('alpha')).resolves.toBe(bootstrapSnapshot);
    await expect(ports.getMembers('alpha')).resolves.toBe(members);
    await expect(ports.listInboxNames('alpha')).resolves.toBe(inboxNames);
    ports.warn('[alpha] warning');

    expect(deps.launchStateStore.read).toHaveBeenCalledWith('alpha');
    expect(deps.readBootstrapLaunchSnapshot).toHaveBeenCalledWith('alpha');
    expect(deps.membersMetaStore.getMembers).toHaveBeenCalledWith('alpha');
    expect(deps.inboxReader.listInboxNames).toHaveBeenCalledWith('alpha');
    expect(deps.logger.warn).toHaveBeenCalledWith('[alpha] warning');
  });
});

function makeDeps(
  overrides: Partial<TeamProvisioningLaunchExpectedMembersPortsFactoryDeps> = {}
): TeamProvisioningLaunchExpectedMembersPortsFactoryDeps {
  return {
    launchStateStore: {
      read: vi.fn(async () => null),
    },
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    inboxReader: {
      listInboxNames: vi.fn(async () => []),
    },
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}
