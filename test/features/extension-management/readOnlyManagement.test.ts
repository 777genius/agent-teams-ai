import { describe, expect, it } from 'vitest';

import { createReadOnlyExtensionManagement } from '../../../src/features/extension-management/main/composition/createReadOnlyExtensionManagement';

describe('standalone management capability', () => {
  it('advertises its read-only boundary and refuses direct mutation calls', async () => {
    const feature = createReadOnlyExtensionManagement();
    expect(await feature.hostStatus()).toEqual({
      available: false,
      reason: expect.stringContaining('desktop app'),
    });
    await expect(feature.capture({ client: 'claude', scope: 'user' })).rejects.toThrow(
      'standalone viewer'
    );
    await expect(
      feature.apply({ contextId: 'untrusted', planId: 'plan', requestId: 'request' })
    ).rejects.toThrow('standalone viewer');
    await expect(
      feature.prepareLocalSkill({
        contextId: 'untrusted',
        change: { action: 'delete', rootId: 'root', skillName: 'name' },
      })
    ).rejects.toThrow('standalone viewer');
  });
});
