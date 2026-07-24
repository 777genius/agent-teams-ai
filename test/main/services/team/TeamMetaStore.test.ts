import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ teamsBase: '' }));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';

describe('TeamMetaStore', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-meta-store-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves supported-version unknown fields while replacing every known field', async () => {
    const teamName = 'round-trip-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'team.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        cwd: '/old/project',
        prompt: 'remove me',
        description: 'old description',
        createdAt: 1,
        futureRoot: { retained: true },
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          selectedModel: 'old-model',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'old-model',
          catalogId: 'old-catalog',
          catalogSource: 'app-server',
          catalogFetchedAt: null,
          selectedEffort: 'high',
          resolvedEffort: 'high',
          futureIdentityField: { retained: true },
        },
      }),
      'utf8'
    );

    await new TeamMetaStore().writeMeta(teamName, {
      cwd: '/new/project',
      description: 'new description',
      launchIdentity: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedModel: 'new-model',
        selectedModelKind: 'explicit',
        resolvedLaunchModel: 'new-model',
        catalogId: 'new-catalog',
        catalogSource: 'app-server',
        catalogFetchedAt: null,
        selectedEffort: 'medium',
        resolvedEffort: 'medium',
      },
      createdAt: 2,
    });

    const persisted = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 1,
      cwd: '/new/project',
      description: 'new description',
      createdAt: 2,
      futureRoot: { retained: true },
      launchIdentity: {
        selectedModel: 'new-model',
        selectedEffort: 'medium',
        futureIdentityField: { retained: true },
      },
    });
    expect(persisted.prompt).toBeUndefined();
  });

  it('accepts ultra as a supported persisted launch effort during mutation', async () => {
    const teamName = 'ultra-effort-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'team.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        cwd: '/old/project',
        createdAt: 1,
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          selectedModel: 'gpt-ultra',
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-ultra',
          catalogId: 'catalog',
          catalogSource: 'app-server',
          catalogFetchedAt: null,
          selectedEffort: 'ultra',
          resolvedEffort: 'ultra',
        },
      }),
      'utf8'
    );

    await new TeamMetaStore().writeMeta(teamName, {
      cwd: '/new/project',
      launchIdentity: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        selectedModel: 'gpt-ultra',
        selectedModelKind: 'explicit',
        resolvedLaunchModel: 'gpt-ultra',
        catalogId: 'catalog',
        catalogSource: 'app-server',
        catalogFetchedAt: null,
        selectedEffort: 'ultra',
        resolvedEffort: 'ultra',
      },
      createdAt: 2,
    });

    await expect(new TeamMetaStore().getMeta(teamName)).resolves.toMatchObject({
      cwd: '/new/project',
      launchIdentity: { selectedEffort: 'ultra', resolvedEffort: 'ultra' },
    });
  });

  it.each([
    ['future version', JSON.stringify({ version: 2, cwd: '/future', createdAt: 1 })],
    ['malformed JSON', '{not-json'],
    [
      'malformed known root field',
      JSON.stringify({ version: 1, cwd: '/project', createdAt: 'yesterday' }),
    ],
    [
      'malformed nested launch identity field',
      JSON.stringify({
        version: 1,
        cwd: '/project',
        createdAt: 1,
        launchIdentity: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          selectedModel: 42,
          selectedModelKind: 'explicit',
          resolvedLaunchModel: 'gpt-5',
          catalogId: 'catalog',
          catalogSource: 'app-server',
          catalogFetchedAt: null,
          selectedEffort: 'high',
          resolvedEffort: 'high',
        },
      }),
    ],
    [
      'oversized JSON',
      JSON.stringify({ version: 1, cwd: '/large', createdAt: 1, pad: 'x'.repeat(256 * 1024) }),
    ],
  ])('fails closed on %s and leaves the existing bytes unchanged', async (_label, raw) => {
    const teamName = 'closed-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    const metaPath = path.join(teamDir, 'team.meta.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(metaPath, raw, 'utf8');

    await expect(
      new TeamMetaStore().writeMeta(teamName, {
        cwd: '/replacement',
        createdAt: 2,
      })
    ).rejects.toBeTruthy();
    await expect(fs.readFile(metaPath, 'utf8')).resolves.toBe(raw);
  });
});
