import {
  createPersistedLaunchSnapshot,
  normalizePersistedLaunchSnapshot,
} from '@main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ teamsBase: '' }));

vi.mock('@main/utils/pathDecoder', () => ({ getTeamsBasePath: () => state.teamsBase }));

function identity(providerBackendId: 'adapter' | 'codex-native') {
  return {
    providerId: 'codex' as const,
    providerBackendId,
    selectedModel: 'gpt-5.6',
    selectedModelKind: 'explicit' as const,
    resolvedLaunchModel: 'gpt-5.6',
    catalogId: 'gpt-5.6',
    catalogSource: 'runtime' as const,
    catalogFetchedAt: null,
    selectedEffort: 'medium' as const,
    resolvedEffort: 'medium' as const,
  };
}

describe('launch-state backend provenance', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-state-provenance-'));
    state.teamsBase = path.join(sandbox, 'teams');
    await fs.mkdir(path.join(state.teamsBase, 'alpha'), { recursive: true });
  });

  afterEach(async () => {
    state.teamsBase = '';
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('writes v3 and preserves distinct current member and identity routes after restart', async () => {
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'alpha',
      expectedMembers: ['builder'],
      launchPhase: 'active',
      updatedAt: '2026-08-25T00:00:00.000Z',
      members: {
        builder: {
          name: 'builder',
          providerId: 'codex',
          providerBackendId: 'api',
          launchIdentity: identity('adapter'),
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-08-25T00:00:00.000Z',
        },
      },
    });
    await new TeamLaunchStateStore().write('alpha', snapshot);

    const raw = JSON.parse(
      await fs.readFile(path.join(state.teamsBase, 'alpha', 'launch-state.json'), 'utf8')
    ) as { version: number };
    expect(raw.version).toBe(3);
    await expect(new TeamLaunchStateStore().read('alpha')).resolves.toMatchObject({
      version: 3,
      members: {
        builder: {
          providerBackendId: 'api',
          launchIdentity: { providerBackendId: 'adapter' },
        },
      },
    });
  });

  it('migrates historical v2 Codex route values conservatively', () => {
    const current = createPersistedLaunchSnapshot({
      teamName: 'alpha',
      expectedMembers: ['builder'],
      members: {
        builder: {
          name: 'builder',
          providerId: 'codex',
          providerBackendId: 'api',
          launchIdentity: identity('adapter'),
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-08-25T00:00:00.000Z',
        },
      },
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(normalizePersistedLaunchSnapshot('alpha', { ...current, version: 2 })).toMatchObject({
      version: 3,
      members: {
        builder: {
          providerBackendId: 'codex-native',
          launchIdentity: { providerBackendId: 'codex-native' },
        },
      },
    });
  });

  it('rejects unknown future snapshots even when they carry a legacy marker', () => {
    expect(normalizePersistedLaunchSnapshot('alpha', { version: 999, members: {} })).toBeNull();
    expect(
      normalizePersistedLaunchSnapshot('alpha', {
        version: 999,
        state: 'partial_launch_failure',
        expectedMembers: ['builder'],
        missingMembers: ['builder'],
      })
    ).toBeNull();
  });
});
