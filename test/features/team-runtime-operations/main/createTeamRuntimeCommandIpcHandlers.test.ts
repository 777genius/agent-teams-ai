import { createTeamRuntimeCommandIpcHandlers } from '@features/team-runtime-operations/main/adapters/input/ipc/createTeamRuntimeCommandIpcHandlers';
import { describe, expect, it, vi } from 'vitest';

import type { TeamRuntimeOperationsFeature } from '@features/team-runtime-operations/main';

vi.mock('@main/ipc/guards', () => ({
  validateMemberName: (value: unknown) => ({ valid: true, value }),
  validateTeamName: (value: unknown) => ({ valid: true, value }),
}));

function feature() {
  const restartMember = vi.fn(() => Promise.resolve());
  return {
    restartMember,
    handlers: createTeamRuntimeCommandIpcHandlers({
      lifecycle: { restartMember },
      logger: { error: vi.fn() },
    } as unknown as TeamRuntimeOperationsFeature),
  };
}

describe('createTeamRuntimeCommandIpcHandlers', () => {
  it('validates and preserves secondary-lane ownership intent on restart', async () => {
    const harness = feature();

    await expect(
      harness.handlers.restartMember({}, 'sandbox-team', 'worker', 'true')
    ).resolves.toEqual({ success: false, error: 'Invalid expectedSecondary' });
    await expect(
      harness.handlers.restartMember({}, 'sandbox-team', 'worker', true)
    ).resolves.toEqual({ success: true, data: undefined });

    expect(harness.restartMember).toHaveBeenCalledTimes(1);
    expect(harness.restartMember).toHaveBeenCalledWith('sandbox-team', 'worker', true);
  });
});
