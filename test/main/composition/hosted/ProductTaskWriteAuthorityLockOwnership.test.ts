import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inspectProductTaskWritePrivateDirectory } from '@main/utils/productTaskWriteAuthorityLock';
import { expect, it, vi } from 'vitest';

const spoof = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: ((target: string) => {
      const stat = real.lstatSync(target);
      if (target === spoof.path) {
        return Object.assign(stat, {
          uid: process.getuid?.() === 1 ? 2 : 1,
          mode: (stat.mode & ~0o777) | 0o755,
        });
      }
      return stat;
    }) as typeof real.lstatSync,
  };
});

it('rejects a foreign-owned non-writable ancestor', () => {
  if (process.platform === 'win32' || !process.getuid) return;
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'product-lock-owner-'))
  );
  const directory = path.join(root, '.product-task-write-locks');
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    spoof.path = root;
    expect(() => inspectProductTaskWritePrivateDirectory(directory)).toThrow(
      /^product-task-write-lock-directory-ancestry-owner-unsafe$/
    );
  } finally {
    spoof.path = '';
    fs.rmSync(root, { recursive: true, force: true });
  }
});
