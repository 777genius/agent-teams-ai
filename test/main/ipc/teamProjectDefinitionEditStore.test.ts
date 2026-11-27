import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
const createLaunchSettingsStore = vi.hoisted(() => vi.fn(() => store));

vi.mock('../../../src/main/ipc/teams/teamLaunchSettingsStore', () => ({
  createLaunchSettingsStore,
}));
vi.mock('../../../src/main/ipc/teams/teamProjectContextCreate', () => ({
  createProjectContextRuntimeParts: vi.fn(() => ({
    registry: { list: vi.fn(), isOwnedExecutionAlias: vi.fn() },
    resolver: { getMode: vi.fn() },
    gate: { assertAllContextsStopped: vi.fn() },
  })),
}));

import { buildEditor } from '../../../src/main/ipc/teams/teamProjectDefinitionEdit';

/**
 * The editor of a definition refreshes only confirmed stopped project copies,
 * so it is the one place whose launch settings store moves the lead identity
 * of a copy's last run with a saved model or effort.
 */
describe('buildEditor', () => {
  it('projects launch settings with the store that follows the lead identity', () => {
    buildEditor({
      data: () => ({}) as never,
      runtime: () => ({}) as never,
      run: () => ({}) as never,
    });
    expect(createLaunchSettingsStore).toHaveBeenCalledWith(undefined, {
      followLeadLaunchIdentity: true,
    });
  });
});
