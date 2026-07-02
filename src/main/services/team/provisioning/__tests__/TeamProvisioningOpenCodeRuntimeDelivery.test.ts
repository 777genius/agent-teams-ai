import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeRuntimeDeliveryPorts,
  getOpenCodeRuntimeRecoveryLaneIds,
} from '../TeamProvisioningOpenCodeRuntimeDelivery';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

describe('TeamProvisioningOpenCodeRuntimeDelivery', () => {
  describe('createOpenCodeRuntimeDeliveryPorts', () => {
    it('creates the runtime destination ports used by OpenCode delivery', () => {
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(),
          readMessages: vi.fn(),
        },
        inboxReader: {
          getMessagesFor: vi.fn(),
        },
        inboxWriter: {
          sendMessage: vi.fn(),
        },
        getCrossTeamSender: () => vi.fn(),
      });

      expect(ports.map((port) => port.kind)).toEqual([
        'user_sent_messages',
        'member_inbox',
        'cross_team_outbox',
      ]);
    });
  });

  describe('getOpenCodeRuntimeRecoveryLaneIds', () => {
    it('prefers lane index keys when the runtime lane index has entries', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {
            primary: { laneId: 'primary' },
            'lane-builder': { laneId: 'secondary-builder' },
          },
          launchSnapshot: snapshotWithMembers({
            builder: {
              laneId: 'snapshot-builder',
              laneOwnerProviderId: 'opencode',
            },
          }),
        })
      ).toEqual(['primary', 'lane-builder']);
    });

    it('falls back to unique OpenCode lane ids from the launch snapshot', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {},
          launchSnapshot: snapshotWithMembers({
            builder: {
              laneId: ' secondary-builder ',
              laneOwnerProviderId: 'opencode',
            },
            reviewer: {
              laneId: 'secondary-builder',
              laneOwnerProviderId: 'opencode',
            },
            designer: {
              laneId: 'secondary-designer',
              laneOwnerProviderId: 'opencode',
            },
            nativeMember: {
              laneId: 'native-lane',
              laneOwnerProviderId: 'anthropic',
            },
          }),
        })
      ).toEqual(['secondary-builder', 'secondary-designer']);
    });

    it('defaults to the primary lane when no lane evidence exists', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {},
          launchSnapshot: snapshotWithMembers({}),
        })
      ).toEqual(['primary']);
    });
  });
});

function snapshotWithMembers(
  members: Record<string, Partial<Pick<PersistedTeamLaunchSnapshot, 'members'>['members'][string]>>
): Pick<PersistedTeamLaunchSnapshot, 'members'> {
  return {
    members: members as Pick<PersistedTeamLaunchSnapshot, 'members'>['members'],
  };
}
