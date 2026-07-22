import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningOrgConfigCompatibilityFacade,
  type TeamProvisioningOrgConfigCompatibilityServiceHost,
} from '../TeamProvisioningOrgConfigCompatibilityFacade';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamConfig, TeamMember } from '@shared/types';

describe('TeamProvisioningOrgConfigCompatibilityFacade', () => {
  it('builds the OpenCode member directory from config and metadata stores', async () => {
    const config = { teamName: 'alpha' } as unknown as TeamConfig;
    const teamMeta = { providerId: 'opencode' };
    const metaMembers = [{ name: 'Builder' }] as TeamMember[];
    const { facade, host } = createFacade({
      configFacade: {
        readConfigForObservation: vi.fn(async () => config),
      },
      teamMetaStore: {
        getMeta: vi.fn(async () => teamMeta),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => metaMembers),
      },
    });

    await expect(facade.readOpenCodeMemberDirectory('alpha')).resolves.toEqual({
      config,
      teamMeta,
      metaMembers,
    });
    expect(host.configFacade.readConfigForObservation).toHaveBeenCalledWith('alpha');
    expect(host.teamMetaStore.getMeta).toHaveBeenCalledWith('alpha');
    expect(host.membersMetaStore.getMembers).toHaveBeenCalledWith('alpha');
  });

  it('keeps the previous null and empty-member fallbacks when lookup sources fail', async () => {
    const { facade } = createFacade({
      configFacade: {
        readConfigForObservation: vi.fn(async () => {
          throw new Error('config unreadable');
        }),
      },
      teamMetaStore: {
        getMeta: vi.fn(async () => {
          throw new Error('meta unreadable');
        }),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => {
          throw new Error('members unreadable');
        }),
      },
    });

    await expect(facade.readOpenCodeMemberDirectory('alpha')).resolves.toEqual({
      config: null,
      teamMeta: null,
      metaMembers: [],
    });
  });

  it('delegates OpenCode member identity resolution through the configured boundary', () => {
    const directory = {
      config: null,
      teamMeta: null,
      metaMembers: [],
    } satisfies OpenCodeMemberDirectory;
    const resolution = {
      ok: false,
      reason: 'recipient_is_not_opencode',
    } satisfies OpenCodeMemberIdentityResolution;
    const resolveOpenCodeMemberIdentityFromDirectory = vi.fn(() => resolution);
    const { facade } = createFacade({
      openCodeMemberIdentityBoundary: {
        resolveOpenCodeMemberIdentityFromDirectory,
      },
    });

    expect(facade.resolveOpenCodeMemberIdentityFromDirectory('alpha', 'Builder', directory)).toBe(
      resolution
    );
    expect(resolveOpenCodeMemberIdentityFromDirectory).toHaveBeenCalledWith(
      'alpha',
      'Builder',
      directory
    );
  });
});

function createFacade(overrides: Partial<TeamProvisioningOrgConfigCompatibilityServiceHost> = {}): {
  facade: TeamProvisioningOrgConfigCompatibilityFacade;
  host: TeamProvisioningOrgConfigCompatibilityServiceHost;
} {
  const host: TeamProvisioningOrgConfigCompatibilityServiceHost = {
    configFacade: {
      readConfigForObservation: vi.fn(async () => null),
    },
    teamMetaStore: {
      getMeta: vi.fn(async () => null),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    openCodeMemberIdentityBoundary: {
      resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
        ok: false as const,
        reason: 'opencode_recipient_unavailable' as const,
      })),
    },
    ...overrides,
  };

  return {
    facade: new TeamProvisioningOrgConfigCompatibilityFacade(host),
    host,
  };
}
