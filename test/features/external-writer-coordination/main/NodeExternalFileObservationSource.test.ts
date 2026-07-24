import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NodeExternalFileObservationSource,
  NodeExternalFileObservationSourceError,
  RegisteredExternalFileCatalog,
} from '@features/external-writer-coordination/main';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const teamId = parseTeamId('team_11111111111111111111111111111111');

describe('NodeExternalFileObservationSource', () => {
  let fixtureRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    [fixtureRoot, outsideRoot] = await Promise.all([
      mkdtemp(join(tmpdir(), 'node-external-file-source-')),
      mkdtemp(join(tmpdir(), 'node-external-file-outside-')),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      rm(fixtureRoot, { force: true, recursive: true }),
      rm(outsideRoot, { force: true, recursive: true }),
    ]);
  });

  const createSource = (rootPath: string, filePath: string, maxBytes = 1_024) => {
    const registration = {
      scope: { teamId, featureKey: 'tasks' },
      fileKey: 'task-1',
      maxBytes,
      attributionPolicy: 'external_file_only' as const,
    };
    const catalog = new RegisteredExternalFileCatalog([{ rootPath, filePath, registration }]);
    return {
      registration,
      source: new NodeExternalFileObservationSource(catalog),
    };
  };

  it('returns stable bigint stat identity, bounded bytes, and exact absence confirmation', async () => {
    const filePath = join(fixtureRoot, 'task.json');
    await writeFile(filePath, 'registered-content');
    const { registration, source } = createSource(fixtureRoot, filePath);

    const before = await source.stat(registration);
    const content = await source.read(registration, 1_024);
    const after = await source.stat(registration);

    expect(before).toMatchObject({
      kind: 'file',
      contained: true,
      byteLength: 18,
    });
    expect(before.device).toMatch(/^\d+$/);
    expect(before.inode).toMatch(/^\d+$/);
    expect(before.modifiedTimeNs).toMatch(/^\d+$/);
    expect(before.changedTimeNs).toMatch(/^\d+$/);
    expect(new TextDecoder().decode(content)).toBe('registered-content');
    expect(after).toEqual(before);

    await rm(filePath);
    await expect(source.stat(registration)).resolves.toEqual({
      kind: 'missing',
      contained: true,
      byteLength: 0,
      device: null,
      inode: null,
      modifiedTimeNs: null,
      changedTimeNs: null,
    });
    await expect(source.confirmAbsentByParentRescan(registration)).resolves.toBe(true);
    await writeFile(filePath, 'recreated');
    await expect(source.confirmAbsentByParentRescan(registration)).resolves.toBe(false);
  });

  it('rejects reads beyond either caller or registered byte bounds', async () => {
    const filePath = join(fixtureRoot, 'bounded.json');
    await writeFile(filePath, '1234');
    const { registration, source } = createSource(fixtureRoot, filePath, 4);

    await expect(source.read(registration, 3)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('oversized')
    );
    await expect(source.read(registration, 4)).resolves.toEqual(
      new Uint8Array(Buffer.from('1234'))
    );

    await writeFile(filePath, '12345');
    await expect(source.read(registration, 100)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('oversized')
    );
    await expect(source.read(registration, 0)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('invalid_max_bytes')
    );
  });

  it('fails closed when a registered file becomes a symlink or another file type', async () => {
    const filePath = join(fixtureRoot, 'replaceable.json');
    const targetPath = join(outsideRoot, 'outside.json');
    await Promise.all([writeFile(filePath, '{}'), writeFile(targetPath, 'outside')]);
    const { registration, source } = createSource(fixtureRoot, filePath);

    await rm(filePath);
    await symlink(targetPath, filePath, 'file');
    await expect(source.stat(registration)).resolves.toMatchObject({
      kind: 'symlink',
      contained: false,
    });
    await expect(source.read(registration, 1_024)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('symlink_not_allowed')
    );

    await rm(filePath);
    await mkdir(filePath);
    await expect(source.stat(registration)).resolves.toMatchObject({
      kind: 'directory',
      contained: true,
    });
    await expect(source.read(registration, 1_024)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('unsupported_file_type')
    );
  });

  it('fails containment after parent aliasing or registered-root replacement', async () => {
    const registeredRoot = join(fixtureRoot, 'registered-root');
    const registeredParent = join(registeredRoot, 'team');
    const filePath = join(registeredParent, 'task.json');
    await mkdir(registeredParent, { recursive: true });
    await writeFile(filePath, 'inside');
    const { registration, source } = createSource(registeredRoot, filePath);

    const savedParent = join(registeredRoot, 'team-saved');
    const outsideParent = join(outsideRoot, 'outside-team');
    await mkdir(outsideParent);
    await writeFile(join(outsideParent, 'task.json'), 'outside');
    await rename(registeredParent, savedParent);
    await symlink(outsideParent, registeredParent, 'dir');
    await expect(source.stat(registration)).resolves.toMatchObject({
      contained: false,
    });
    await expect(source.read(registration, 1_024)).rejects.toThrowError(
      new NodeExternalFileObservationSourceError('outside_containment')
    );

    await rm(registeredParent);
    await rename(savedParent, registeredParent);
    const savedRoot = join(fixtureRoot, 'registered-root-saved');
    await rename(registeredRoot, savedRoot);
    await mkdir(join(registeredRoot, 'team'), { recursive: true });
    await writeFile(join(registeredRoot, 'team', 'task.json'), 'replacement-root');
    await expect(source.stat(registration)).resolves.toMatchObject({
      contained: false,
    });
    await expect(source.confirmAbsentByParentRescan(registration)).resolves.toBe(false);
  });
});
