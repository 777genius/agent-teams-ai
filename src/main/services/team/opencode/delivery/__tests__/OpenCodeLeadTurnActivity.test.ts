import { describe, expect, it } from 'vitest';

import { resolveOpenCodeMemberIdentityFromDirectory } from '../../../provisioning/TeamProvisioningOpenCodeMemberIdentity';
import { isOpenCodeLeadRecipient } from '../OpenCodeLeadTurnActivity';

import type { OpenCodeMemberDirectory } from '../OpenCodeMemberMessageDeliveryPorts';

const directory: OpenCodeMemberDirectory = {
  config: {
    name: 'fixture-team',
    projectPath: '/sandbox/fixture',
    members: [
      { name: 'captain', agentType: 'team-lead', providerId: 'opencode', model: 'test/shared' },
      { name: 'builder', providerId: 'opencode', model: 'test/shared', cwd: '/sandbox/fixture' },
    ],
  },
  teamMeta: { providerId: 'opencode' },
  metaMembers: [],
};

describe('OpenCode lead recipient identity', () => {
  it('separates a real same-model primary teammate from the configured lead', () => {
    const identity = resolveOpenCodeMemberIdentityFromDirectory({
      memberName: 'builder',
      directory,
      runtimeAdapterProviderId: 'opencode',
    });
    expect(identity).toMatchObject({ ok: true, laneIdentity: { laneKind: 'primary' } });
    expect(isOpenCodeLeadRecipient('builder', directory)).toBe(false);
    expect(isOpenCodeLeadRecipient(' CAPTAIN ', directory)).toBe(true);
    expect(isOpenCodeLeadRecipient('team-lead', directory)).toBe(true);
  });

  it('accepts the solo alias only for a real solo roster', () => {
    expect(isOpenCodeLeadRecipient('solo', directory)).toBe(false);
    expect(
      isOpenCodeLeadRecipient('solo', {
        ...directory,
        config: { ...directory.config!, members: [] },
      })
    ).toBe(true);
  });
});
