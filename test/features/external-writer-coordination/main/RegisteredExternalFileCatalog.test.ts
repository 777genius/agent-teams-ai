import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  RegisteredExternalFileCatalog,
  RegisteredExternalFileCatalogError,
  type RegisteredExternalFileDefinition,
} from '@features/external-writer-coordination/main';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const teamId = parseTeamId('team_11111111111111111111111111111111');

describe('RegisteredExternalFileCatalog', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'registered-external-file-catalog-'));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const definition = (
    filePath: string,
    fileKey = 'task-1',
    featureKey = 'tasks'
  ): RegisteredExternalFileDefinition => ({
    rootPath: fixtureRoot,
    filePath,
    registration: {
      scope: { teamId, featureKey },
      fileKey,
      maxBytes: 1_024,
      attributionPolicy: 'external_file_only',
    },
  });

  it('freezes an immutable exact-file catalog and admits a missing registered file', async () => {
    const existingPath = join(fixtureRoot, 'task-1.json');
    const missingPath = join(fixtureRoot, 'task-2.json');
    await writeFile(existingPath, '{"status":"open"}');
    const first = definition(existingPath);
    const catalog = new RegisteredExternalFileCatalog([first, definition(missingPath, 'task-2')]);

    first.registration.fileKey = 'mutated-after-composition';
    const scopes = await catalog.listScopes();
    const registrations = await catalog.listRegistrations(scopes[0]);
    const files = catalog.listRegisteredFiles();

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(scopes)).toBe(true);
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(Object.isFrozen(files)).toBe(true);
    expect(Object.isFrozen(files[0])).toBe(true);
    expect(Object.isFrozen(files[0].registration)).toBe(true);
    expect(Object.isFrozen(files[0].registration.scope)).toBe(true);
    expect(registrations.map((registration) => registration.fileKey)).toEqual(['task-1', 'task-2']);
    expect(files[0].rootDevice).toMatch(/^\d+$/);
    expect(files[0].rootInode).toMatch(/^\d+$/);
    expect(files[0].parentDevice).toMatch(/^\d+$/);
    expect(files[0].parentInode).toMatch(/^\d+$/);
    expect(catalog.getRegisteredFile(registrations[0]).realFilePath).toBe(existingPath);
  });

  it('rejects relative paths and lexical root escape', async () => {
    const outsidePath = join(fixtureRoot, '..', `${basename(fixtureRoot)}-outside.json`);
    await writeFile(outsidePath, '{}');

    expect(
      () =>
        new RegisteredExternalFileCatalog([
          { ...definition(join(fixtureRoot, 'task.json')), rootPath: '.' },
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('path_not_absolute'));
    expect(
      () =>
        new RegisteredExternalFileCatalog([
          { ...definition(join(fixtureRoot, 'task.json')), filePath: 'task.json' },
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('path_not_absolute'));
    expect(() => new RegisteredExternalFileCatalog([definition(outsidePath)])).toThrowError(
      new RegisteredExternalFileCatalogError('path_outside_root')
    );

    await rm(outsidePath, { force: true });
  });

  it('rejects file, parent, and root symlink aliases', async () => {
    const targetPath = join(fixtureRoot, 'target.json');
    const fileAliasPath = join(fixtureRoot, 'file-alias.json');
    await writeFile(targetPath, '{}');
    await symlink(targetPath, fileAliasPath, 'file');
    expect(() => new RegisteredExternalFileCatalog([definition(fileAliasPath)])).toThrowError(
      new RegisteredExternalFileCatalogError('symlink_not_allowed')
    );

    const realParent = join(fixtureRoot, 'real-parent');
    const parentAlias = join(fixtureRoot, 'parent-alias');
    await mkdir(realParent);
    await writeFile(join(realParent, 'nested.json'), '{}');
    await symlink(realParent, parentAlias, 'dir');
    expect(
      () => new RegisteredExternalFileCatalog([definition(join(parentAlias, 'nested.json'))])
    ).toThrowError(new RegisteredExternalFileCatalogError('symlink_not_allowed'));

    const rootAlias = join(fixtureRoot, '..', `${basename(fixtureRoot)}-alias`);
    await symlink(fixtureRoot, rootAlias, 'dir');
    expect(
      () =>
        new RegisteredExternalFileCatalog([
          {
            ...definition(join(rootAlias, 'target.json')),
            rootPath: rootAlias,
            filePath: join(rootAlias, 'target.json'),
          },
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('symlink_not_allowed'));
    await rm(rootAlias, { force: true });
  });

  it('rejects a lexically distinct root reached through a symlinked ancestor', async () => {
    const realAncestor = join(fixtureRoot, 'real-ancestor');
    const ancestorAlias = join(fixtureRoot, 'ancestor-alias');
    const registeredRoot = join(realAncestor, 'registered-root');
    await mkdir(registeredRoot, { recursive: true });
    await writeFile(join(registeredRoot, 'task.json'), '{}');
    await symlink(realAncestor, ancestorAlias, 'dir');
    const aliasedRoot = join(ancestorAlias, 'registered-root');

    expect(
      () =>
        new RegisteredExternalFileCatalog([
          {
            ...definition(join(aliasedRoot, 'task.json')),
            rootPath: aliasedRoot,
            filePath: join(aliasedRoot, 'task.json'),
          },
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('symlink_not_allowed'));
  });

  it('rejects directories and duplicate path or inode aliases', async () => {
    const firstPath = join(fixtureRoot, 'first.json');
    const hardLinkPath = join(fixtureRoot, 'hard-link.json');
    const otherPath = join(fixtureRoot, 'other.json');
    await writeFile(firstPath, '{}');
    await writeFile(otherPath, '{}');
    await link(firstPath, hardLinkPath);

    expect(() => new RegisteredExternalFileCatalog([definition(fixtureRoot)])).toThrowError(
      new RegisteredExternalFileCatalogError('path_outside_root')
    );
    expect(
      () => new RegisteredExternalFileCatalog([definition(join(fixtureRoot, 'directory-as-file'))])
    ).not.toThrow();
    await mkdir(join(fixtureRoot, 'directory-as-file'));
    expect(
      () => new RegisteredExternalFileCatalog([definition(join(fixtureRoot, 'directory-as-file'))])
    ).toThrowError(new RegisteredExternalFileCatalogError('unsupported_file_type'));
    expect(
      () =>
        new RegisteredExternalFileCatalog([
          definition(firstPath, 'first'),
          definition(firstPath, 'alias'),
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('duplicate_alias'));
    expect(
      () =>
        new RegisteredExternalFileCatalog([
          definition(firstPath, 'first'),
          definition(hardLinkPath, 'hard-link'),
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('duplicate_alias'));
    expect(
      () =>
        new RegisteredExternalFileCatalog([
          definition(firstPath, 'same-key'),
          definition(otherPath, 'same-key'),
        ])
    ).toThrowError(new RegisteredExternalFileCatalogError('duplicate_registration'));
  });

  it('rejects forged registrations when resolving a file', async () => {
    const filePath = join(fixtureRoot, 'task.json');
    await writeFile(filePath, '{}');
    const catalog = new RegisteredExternalFileCatalog([definition(filePath)]);
    const [registration] = await catalog.listRegistrations({
      teamId,
      featureKey: 'tasks',
    });

    expect(() => catalog.getRegisteredFile({ ...registration, maxBytes: 2_048 })).toThrowError(
      new RegisteredExternalFileCatalogError('invalid_registration')
    );
    await expect(
      catalog.listRegistrations({ teamId, featureKey: 'unregistered' })
    ).resolves.toEqual([]);
  });
});
