// @vitest-environment node
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import {
  PhysicalReadScope,
  type ReadContinuation,
} from '../../../src/features/team-read-recovery/core/application/PhysicalReadScope';
import { OwnedReadDescriptors } from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';
import {
  OwnedPathOperations,
  type PathCallbacks,
} from '../../../src/features/team-read-recovery/main/infrastructure/OwnedPathOperations';

it('rejects a closed parent continuation before unlink while a sibling still holds the drain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-continuation-'));
  const path = join(directory, 'source.txt');
  await writeFile(path, 'must remain');
  const descriptors = new OwnedReadDescriptors();
  const scope = new PhysicalReadScope();
  let release!: () => void;
  let observed!: () => void;
  const ready = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const stat: PathCallbacks['stat'] = (file, callback) =>
    fs.stat(file, (error, value) => {
      release = () => callback(error, value);
      observed();
    });
  const paths = new OwnedPathOperations({ ...fs, stat });
  let parent!: ReadContinuation;
  const acquisition = descriptors.open(path);
  const descriptor = await scope.start((continuation) => {
    parent = continuation;
    return acquisition;
  });
  const sibling = paths.execute({ kind: 'stat', path });
  void scope.start(() => sibling);
  await ready;
  scope.finishTop();
  try {
    void descriptor.close();
    await acquisition.physical;
    expect(() => parent.start(() => paths.execute({ kind: 'unlink', path }))).toThrow(
      'parent has settled'
    );
    const sentinel = Symbol();
    expect(await Promise.race([scope.drained, Promise.resolve(sentinel)])).toBe(sentinel);
  } finally {
    release();
    await scope.drained;
    await paths.retire();
    await descriptors.retire();
    try {
      expect(fs.readFileSync(path, 'utf8')).toBe('must remain');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
