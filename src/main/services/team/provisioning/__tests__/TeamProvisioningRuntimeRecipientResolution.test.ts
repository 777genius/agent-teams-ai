import { describe, expect, it, vi } from 'vitest';

import { type TeamLaunchRuntimeAdapter, TeamRuntimeAdapterRegistry } from '../../runtime';
import {
  getOpenCodeRuntimeAdapter,
  getOpenCodeRuntimeMessageAdapter,
  getOpenCodeRuntimePermissionListingAdapter,
  isOpenCodeRuntimeRecipient,
  isOpenCodeRuntimeRecipientFromSources,
  resolveRuntimeRecipientProviderId,
  resolveRuntimeRecipientProviderIdFromSources,
  type RuntimeRecipientProviderSourcePorts,
} from '../TeamProvisioningRuntimeRecipientResolution';

import type { TeamConfig, TeamMember } from '@shared/types';

function makeAdapter(
  providerId: TeamLaunchRuntimeAdapter['providerId'],
  capabilities: {
    message?: boolean;
    permissions?: boolean;
  } = {}
): TeamLaunchRuntimeAdapter {
  return {
    providerId,
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
    ...(capabilities.message
      ? {
          sendMessageToMember: vi.fn(),
        }
      : {}),
    ...(capabilities.permissions
      ? {
          listRuntimePermissions: vi.fn(),
        }
      : {}),
  } as unknown as TeamLaunchRuntimeAdapter;
}

describe('TeamProvisioningRuntimeRecipientResolution', () => {
  describe('OpenCode runtime adapter helpers', () => {
    it('returns null when the registry is missing or lacks an OpenCode adapter', () => {
      expect(getOpenCodeRuntimeAdapter(null)).toBeNull();
      expect(
        getOpenCodeRuntimeAdapter(new TeamRuntimeAdapterRegistry([makeAdapter('codex')]))
      ).toBeNull();
    });

    it('returns the registered OpenCode adapter and narrows optional capabilities', () => {
      const adapter = makeAdapter('opencode', { message: true, permissions: true });
      const registry = new TeamRuntimeAdapterRegistry([adapter]);

      expect(getOpenCodeRuntimeAdapter(registry)).toBe(adapter);
      expect(getOpenCodeRuntimeMessageAdapter(adapter)).toBe(adapter);
      expect(getOpenCodeRuntimePermissionListingAdapter(adapter)).toBe(adapter);
    });

    it('returns null for missing OpenCode message and permission capability methods', () => {
      const adapter = makeAdapter('opencode');

      expect(getOpenCodeRuntimeMessageAdapter(null)).toBeNull();
      expect(getOpenCodeRuntimeMessageAdapter(adapter)).toBeNull();
      expect(
        getOpenCodeRuntimeMessageAdapter({ ...adapter, sendMessageToMember: true } as never)
      ).toBeNull();
      expect(getOpenCodeRuntimePermissionListingAdapter(null)).toBeNull();
      expect(getOpenCodeRuntimePermissionListingAdapter(adapter)).toBeNull();
    });
  });

  describe('runtime recipient provider source resolution', () => {
    it('returns undefined for blank member names', () => {
      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: '   ',
          config: null,
          metaMembers: [],
        })
      ).toBeUndefined();
      expect(
        isOpenCodeRuntimeRecipientFromSources({
          memberName: '   ',
          config: null,
          metaMembers: [],
        })
      ).toBe(false);
    });

    it('resolves provider ids from metadata before config and normalizes legacy provider fields', () => {
      const config: TeamConfig = {
        name: 'team-a',
        members: [
          {
            name: 'Alice',
            providerId: 'codex',
            model: 'gpt-5.4',
          },
          {
            name: 'Bob',
            provider: ' OPENCODE ',
          } as TeamMember & { provider: string },
        ],
      };
      const metaMembers: TeamMember[] = [
        {
          name: 'alice',
          provider: ' OPENCODE ',
        } as TeamMember & { provider: string },
      ];

      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: ' ALICE ',
          config,
          metaMembers,
        })
      ).toBe('opencode');
      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: 'bob',
          config,
          metaMembers,
        })
      ).toBe('opencode');
    });

    it('falls back to model inference when no explicit provider exists', () => {
      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: 'dev',
          config: {
            name: 'team-a',
            members: [{ name: 'dev', model: 'gpt-5.4' }],
          },
          metaMembers: [],
        })
      ).toBe('codex');
    });

    it('resolves the synthetic solo target only for OpenCode solo rosters', () => {
      const config: TeamConfig = {
        name: 'solo-team',
        projectPath: '/repo',
        members: [
          {
            name: 'team-lead',
            role: 'Team Lead',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
          },
        ],
      };

      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: 'solo',
          config,
          metaMembers: [],
        })
      ).toBe('opencode');
      expect(
        resolveRuntimeRecipientProviderIdFromSources({
          memberName: 'alice',
          config,
          metaMembers: [],
        })
      ).toBeUndefined();
      expect(
        isOpenCodeRuntimeRecipientFromSources({
          memberName: 'solo',
          config,
          metaMembers: [],
        })
      ).toBe(true);
    });
  });

  describe('runtime recipient provider ports', () => {
    it('reads config and metadata sources through explicit ports', async () => {
      const ports = {
        readConfigSnapshot: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'alice', providerId: 'codex' as const }],
        })),
        readMembersMeta: vi.fn(async () => [{ name: 'alice', providerId: 'opencode' as const }]),
      } satisfies RuntimeRecipientProviderSourcePorts;

      await expect(
        resolveRuntimeRecipientProviderId({ teamName: 'team-a', memberName: 'Alice' }, ports)
      ).resolves.toBe('opencode');
      await expect(
        isOpenCodeRuntimeRecipient({ teamName: 'team-a', memberName: 'Alice' }, ports)
      ).resolves.toBe(true);
      expect(ports.readConfigSnapshot).toHaveBeenCalledWith('team-a');
      expect(ports.readMembersMeta).toHaveBeenCalledWith('team-a');
    });

    it('treats unreadable sources as empty without failing recipient resolution', async () => {
      const ports = {
        readConfigSnapshot: vi.fn(async () => {
          throw new Error('config unavailable');
        }),
        readMembersMeta: vi.fn(async () => {
          throw new Error('meta unavailable');
        }),
      };

      await expect(
        resolveRuntimeRecipientProviderId({ teamName: 'team-a', memberName: 'Alice' }, ports)
      ).resolves.toBeUndefined();
    });
  });
});
