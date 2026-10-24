// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import {
  emptyManagedPreferences,
  parseManagedPreferences,
  resolveManagedPreferences,
} from '../../../src/features/runtime-provider-management/core/domain/managedProviderPreferences';
import { FileManagedProviderPreferences } from '../../../src/features/runtime-provider-management/main/infrastructure/FileManagedProviderPreferences';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-model-preferences-')));
  const projectRoot = join(root, 'project'),
    globalRoot = join(root, 'global');
  await mkdir(projectRoot);
  await mkdir(globalRoot);
  let current = true;
  const store = await FileManagedProviderPreferences.capture(
    { projectRoot, globalRoot },
    () => current
  );
  return {
    root,
    projectRoot,
    globalRoot,
    store,
    stale: () => {
      current = false;
    },
    projectFile: join(projectRoot, 'agent-teams-runtime-preferences.json'),
    globalFile: join(globalRoot, 'global-runtime-preferences.json'),
  };
}

it('reads frozen v1/v2 preferences and resolves project → global → native without losing unknown fields', () => {
  const global = parseManagedPreferences({
    schemaVersion: 1,
    defaultModelId: 'TEST/global',
    custom: { preserved: true },
  });
  const project = parseManagedPreferences({
    schemaVersion: 2,
    defaultModelId: 'TEST/project',
    modelLimitOverrides: {
      'TEST/model': { contextTokens: 8192, outputTokens: 1024, updatedAt: null, custom: true },
    },
  });
  expect(global.custom).toEqual({ preserved: true });
  expect(resolveManagedPreferences(project, global, 'TEST/native')).toMatchObject({
    defaultModel: 'TEST/project',
    defaultModelSource: 'project',
    fallbackModel: 'TEST/global',
  });
  project.defaultModelId = null;
  expect(resolveManagedPreferences(project, global, 'TEST/native').defaultModel).toBe(
    'TEST/global'
  );
  global.defaultModelId = null;
  expect(resolveManagedPreferences(project, global, 'TEST/native').defaultModelSource).toBe(
    'opencode_config'
  );
  expect(() => parseManagedPreferences({ schemaVersion: 99 })).toThrow();
  expect(() =>
    parseManagedPreferences({ schemaVersion: 2, defaultModelId: 'malformed' })
  ).toThrow();
});

it('updates the original filename while preserving model limits, extensions, and readable legacy mode', async () => {
  const f = await fixture();
  const original = {
    ...emptyManagedPreferences(),
    custom: { flag: true },
    modelLimitOverrides: {
      'TEST/model': {
        contextTokens: 8192,
        outputTokens: 1024,
        updatedAt: null,
        custom: 'TEST-keep',
      },
    },
  };
  await writeFile(f.projectFile, JSON.stringify(original), { mode: 0o644 });
  await f.store.setDefault('project', 'TEST/project');
  const saved = JSON.parse(await readFile(f.projectFile, 'utf8'));
  expect(saved).toMatchObject({
    schemaVersion: 2,
    custom: original.custom,
    modelLimitOverrides: original.modelLimitOverrides,
    defaultModelId: 'TEST/project',
  });
  expect(saved.updatedAt).toEqual(expect.any(String));
  expect((await stat(f.projectFile)).mode & 0o777).toBe(0o644);
  await f.store.setDefault('all_projects', 'TEST/global');
  await f.store.setDefault('project', null);
  const snapshot = await f.store.read();
  expect(resolveManagedPreferences(snapshot.project, snapshot.global, null)).toMatchObject({
    defaultModel: 'TEST/global',
    defaultModelSource: 'all_projects',
  });
  expect(snapshot.project?.modelLimitOverrides).toEqual(original.modelLimitOverrides);
});

it('corrupt or symlinked files hold instead of replacing known data with empty preferences', async () => {
  const f = await fixture();
  await writeFile(f.projectFile, '{TEST-corrupt');
  await expect(f.store.setDefault('project', 'TEST/new')).rejects.toThrow();
  expect(await readFile(f.projectFile, 'utf8')).toBe('{TEST-corrupt');
  const other = await fixture();
  await writeFile(other.globalFile, JSON.stringify(emptyManagedPreferences()));
  await symlink(other.globalFile, other.projectFile);
  await expect(other.store.setDefault('project', 'TEST/new')).rejects.toThrow();
  expect(JSON.parse(await readFile(other.globalFile, 'utf8')).defaultModelId).toBeNull();
});

it('context change or namespace replacement cannot redirect a pending preference write', async () => {
  const f = await fixture();
  f.stale();
  await expect(f.store.setDefault('project', 'TEST/new')).rejects.toThrow();
  const other = await fixture();
  await rename(other.projectRoot, join(other.root, 'old-project'));
  await mkdir(other.projectRoot);
  await expect(other.store.setDefault('project', 'TEST/new')).rejects.toThrow();
  await expect(readFile(other.projectFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
