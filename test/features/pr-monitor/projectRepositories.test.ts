import { describe, expect, it, vi } from 'vitest';

import { projectRepositories } from '../../../src/features/pr-monitor/main/adapters/output/projectRepositories';

import type { ProjectContext } from '../../../src/features/pr-monitor/main/adapters/output/projectRepositories';
import type { RepositoryGroup } from '@main/types';

const identity = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@main/services/parsing/GitIdentityResolver', () => ({
  gitIdentityResolver: { resolveIdentity: identity.resolve },
}));
const request = { contextId: 'local', projectId: 'TEST-project' };
const groups: RepositoryGroup[] = [
  {
    id: 'TEST-repository',
    name: 'TEST',
    identity: null,
    totalSessions: 0,
    worktrees: [
      {
        id: request.projectId,
        path: '/TEST/project',
        name: 'TEST',
        isMainWorktree: true,
        source: 'git',
        sessions: [],
        createdAt: 0,
      },
    ],
  },
];

describe('repository admission scope', () => {
  it.each(['unchanged', 'scan', 'identity'] as const)(
    'keeps the initial scope when the change happens during %s',
    async (stage) => {
      let scope = {};
      const admitted = scope;
      const context: ProjectContext = {
        id: 'local',
        type: 'local',
        getDetailReadSource: () => scope,
        projectScanner: {
          scanWithWorktreeGrouping: async () => {
            if (stage === 'scan') scope = {};
            return groups;
          },
        },
      };
      identity.resolve.mockReset().mockImplementation(async () => {
        if (stage === 'identity') scope = {};
        return { remoteUrl: 'https://github.com/TEST/fixture.git' };
      });
      const result = await projectRepositories(() => context).resolve(request);
      if (stage === 'unchanged') {
        expect(result).toMatchObject({ ok: true, value: { repository: { repo: 'fixture' } } });
        if (!result.ok) throw new Error('Fixture failed');
        expect(result.value.scope).toBe(admitted);
      } else {
        expect(result).toMatchObject({ error: { kind: 'invalid_request' } });
      }
      expect(identity.resolve).toHaveBeenCalledTimes(stage === 'scan' ? 0 : 1);
    }
  );
});
