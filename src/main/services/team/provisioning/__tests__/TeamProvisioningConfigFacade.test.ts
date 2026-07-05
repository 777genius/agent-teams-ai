import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningConfigFacade,
  type TeamProvisioningConfigFacadeOptions,
} from '../TeamProvisioningConfigFacade';

import type { TeamConfig, TeamMember } from '@shared/types';

describe('TeamProvisioningConfigFacade', () => {
  it('keeps observation reads on snapshots while strict decisions read fresh config', async () => {
    const snapshotConfig = { teamName: 'snapshot', members: [] } as unknown as TeamConfig;
    const strictConfig = { teamName: 'strict', members: [] } as unknown as TeamConfig;
    const { facade, options } = createFacade({
      configReader: {
        getConfig: vi.fn(async () => strictConfig),
        getConfigSnapshot: vi.fn(async () => snapshotConfig),
      },
    });

    await expect(facade.readConfigForObservation('alpha')).resolves.toBe(snapshotConfig);
    await expect(facade.readConfigForStrictDecision('alpha')).resolves.toBe(strictConfig);

    expect(options.configReader.getConfigSnapshot).toHaveBeenCalledWith('alpha');
    expect(options.configReader.getConfig).toHaveBeenCalledWith('alpha');
  });

  it('materializes repair members through members metadata with provider backend', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const writeMembers = vi.fn(async () => undefined);
    const { facade } = createFacade({
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
        writeMembers,
      },
    });

    await facade.materializeLaunchCompatibilityRepair(
      {
        teamName: 'alpha',
        cwd: '/repo',
        providerBackendId: 'codex-native',
      },
      {
        level: 'repairable',
        rosterSource: 'config',
        repairAction: 'materialize-members-meta',
        members: [{ name: 'Builder', role: 'Engineer' }],
        warnings: [],
        blockers: [],
      }
    );

    expect(writeMembers).toHaveBeenCalledWith(
      'alpha',
      [expect.objectContaining({ name: 'Builder', joinedAt: 123_456 })],
      { providerBackendId: 'codex-native' }
    );
    nowSpy.mockRestore();
  });
});

function createFacade(overrides: Partial<TeamProvisioningConfigFacadeOptions> = {}): {
  facade: TeamProvisioningConfigFacade;
  options: TeamProvisioningConfigFacadeOptions;
} {
  const options: TeamProvisioningConfigFacadeOptions = {
    configReader: {
      getConfig: vi.fn(async () => null),
    },
    inboxReader: {
      listInboxNames: vi.fn(async () => []),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
      writeMembers: vi.fn(async (_teamName: string, _members: TeamMember[]) => undefined),
    },
    launchStateStore: {
      read: vi.fn(async () => null),
    },
    persistedTeamConfigCache: new Map(),
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    readRegularFileUtf8: vi.fn(async () => null),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };

  return {
    facade: new TeamProvisioningConfigFacade(options),
    options,
  };
}
