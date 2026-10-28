// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

import { createAppExtensionManagement } from '../../../src/features/extension-management/main/composition/createAppExtensionManagement';

import type { createDesktopExtensionManagement } from '../../../src/features/extension-management/main/composition/createDesktopExtensionManagement';
import type { TeamCreateRequest } from '../../../src/shared/types/team';

const { compose } = vi.hoisted(() => ({
  compose: vi.fn<(deps: Parameters<typeof createDesktopExtensionManagement>[0]) => object>(
    () => ({})
  ),
}));
vi.mock(
  '../../../src/features/extension-management/main/composition/createDesktopExtensionManagement',
  () => ({ createDesktopExtensionManagement: compose })
);

beforeEach(() => vi.clearAllMocks());

function activeClients(requests: Record<string, TeamCreateRequest | null>) {
  createAppExtensionManagement({
    resourceRoot: '/test-app',
    isLocal: () => true,
    aliveTeams: () => Object.keys(requests),
    savedRequest: async (name) => requests[name],
    knownProjects: async () => [],
  });
  return compose.mock.calls[0][0].activeClientIds();
}

it.each([
  ['anthropic', 'claude'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
] as const)(
  'keeps unrelated clients available when a member inherits %s',
  async (providerId, client) => {
    await expect(
      activeClients({
        running: {
          teamName: 'running',
          cwd: '/test-project',
          providerId,
          members: [{ name: 'inherited' }],
        },
      })
    ).resolves.toEqual(new Set([client]));
  }
);

it('includes explicit member overrides and every running team', async () => {
  await expect(
    activeClients({
      mixed: {
        teamName: 'mixed',
        cwd: '/test-project',
        providerId: 'anthropic',
        members: [{ name: 'inherited' }, { name: 'codex-worker', providerId: 'codex' }],
      },
      other: {
        teamName: 'other',
        cwd: '/other-test-project',
        providerId: 'opencode',
        members: [],
      },
    })
  ).resolves.toEqual(new Set(['claude', 'codex', 'opencode']));
});

it.each([null, { teamName: 'unknown', cwd: '/test-project', members: [{ name: 'unknown' }] }])(
  'retains conservative admission when running provider information is missing: %j',
  async (request) => {
    await expect(activeClients({ unknown: request })).resolves.toEqual(
      new Set(['claude', 'codex', 'opencode'])
    );
  }
);

it('does not mark clients active without a running team', async () => {
  await expect(activeClients({})).resolves.toEqual(new Set());
});
