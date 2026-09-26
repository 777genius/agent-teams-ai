// @vitest-environment node
import { createProjectFolderFeature } from '@features/project-folder/main';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('project folder feature', () => {
  let root: string;
  const feature = createProjectFolderFeature();

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'project-folder-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports folder state without creating anything', async () => {
    const filePath = path.join(root, 'file.txt');
    writeFileSync(filePath, 'x');
    const missingPath = path.join(root, 'missing', 'nested');

    expect(await feature.getState({ path: root })).toEqual({ state: 'exists' });
    expect(await feature.getState({ path: filePath })).toEqual({ state: 'not_directory' });
    expect(await feature.getState({ path: missingPath })).toEqual({ state: 'missing' });
    expect(existsSync(path.join(root, 'missing'))).toBe(false);
  });

  it('rejects relative, root and malformed paths', async () => {
    for (const input of [
      { path: 'relative/project' },
      { path: path.parse(root).root },
      { path: '   ' },
      { path: `${root}/bad\0name` },
      { path: 42 },
      null,
    ]) {
      expect(await feature.getState(input)).toEqual({ state: 'invalid' });
      expect(await feature.create(input)).toEqual({ state: 'invalid', error: 'invalid_path' });
    }
  });

  it('creates missing parents and is idempotent', async () => {
    const target = path.join(root, 'new', 'project');

    expect(await feature.create({ path: `  ${target}  ` })).toEqual({ state: 'exists' });
    expect(await feature.getState({ path: target })).toEqual({ state: 'exists' });
    expect(await feature.create({ path: target })).toEqual({ state: 'exists' });
  });

  it('reports a file in the way as a path conflict', async () => {
    const filePath = path.join(root, 'taken');
    writeFileSync(filePath, 'x');

    expect(await feature.create({ path: filePath })).toEqual({
      state: 'not_directory',
      error: 'path_conflict',
    });
    expect(await feature.create({ path: path.join(filePath, 'child') })).toEqual({
      state: 'missing',
      error: 'path_conflict',
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports permission failures instead of pretending the folder is missing',
    async () => {
      const lockedParent = path.join(root, 'locked');
      mkdirSync(lockedParent);
      chmodSync(lockedParent, 0o500);
      try {
        expect(await feature.create({ path: path.join(lockedParent, 'project') })).toEqual({
          state: 'missing',
          error: 'permission_denied',
        });
      } finally {
        chmodSync(lockedParent, 0o700);
      }
    }
  );
});
