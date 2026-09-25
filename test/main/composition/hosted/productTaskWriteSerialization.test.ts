import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProductTaskWriteFileSerialization } from '@main/composition/hosted/productTaskWriteSerialization';
import {
  assertProductTaskWritePrivateDirectoryIdentity,
  ensureProductTaskWriteLockDirectory,
  inspectProductTaskWritePrivateDirectory,
  productTaskWriteAuthorityResource,
  productTaskWriteLockDirectoryPathForAuthRoot,
  withProductTaskWriteAuthorityLockSync,
} from '@main/utils/productTaskWriteAuthorityLock';
import { parseTeamId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const teamA = parseTeamId(`team_${'a'.repeat(32)}`);
const teamB = parseTeamId(`team_${'b'.repeat(32)}`);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'product-task-lock-test-'))
  );
  directories.push(parent);
  const lockDirectory = ensureProductTaskWriteLockDirectory(parent);
  return {
    serialization: new ProductTaskWriteFileSerialization(lockDirectory),
    authDataRoot: parent,
    lockDirectory,
  };
}

describe('ProductTaskWriteFileSerialization', () => {
  it('serializes writers across teams and blocks a concurrent v35 authority mutation', async () => {
    const { serialization, lockDirectory, authDataRoot } = fixture();
    expect(productTaskWriteLockDirectoryPathForAuthRoot(authDataRoot)).toBe(lockDirectory);
    expect(productTaskWriteAuthorityResource(lockDirectory)).toBe(
      path.join(lockDirectory, 'product-task-write-authority-v1')
    );
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = serialization.withTaskWrite(teamA, async () => {
      entered();
      await held;
    });
    await acquired;

    let otherTeamEntered = false;
    const otherTeam = serialization.withTaskWrite(teamB, async () => {
      otherTeamEntered = true;
    });
    expect(() => serialization.withCanonicalTaskWrite(teamB, () => 'other team')).toThrow(
      /^product-authority-lock-transient-busy$/
    );
    expect(() => serialization.withCanonicalTaskWrite(teamA, () => 'overlap')).toThrow(
      /^product-authority-lock-transient-busy$/
    );
    expect(() => withProductTaskWriteAuthorityLockSync(lockDirectory, () => 'v35')).toThrow(
      /^product-authority-lock-transient-busy$/
    );
    expect(otherTeamEntered).toBe(false);

    release();
    await Promise.all([first, otherTeam]);
    expect(otherTeamEntered).toBe(true);
    expect(serialization.withCanonicalTaskWrite(teamA, () => 'after release')).toBe(
      'after release'
    );
    expect(withProductTaskWriteAuthorityLockSync(lockDirectory, () => 'v35')).toBe('v35');
  });

  it('releases the authority and team locks when an async writer fails', async () => {
    const { serialization, lockDirectory } = fixture();
    await expect(
      serialization.withTaskWrite(teamA, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect(withProductTaskWriteAuthorityLockSync(lockDirectory, () => 'v35')).toBe('v35');
    expect(serialization.withCanonicalTaskWrite(teamA, () => 'recovered')).toBe('recovered');
  });

  it('releases the authority lock when a v35 mutation throws', () => {
    const { serialization, lockDirectory } = fixture();
    const callbackError = new Error(
      `File lock timeout: ${productTaskWriteAuthorityResource(lockDirectory)}`
    );
    expect(() =>
      withProductTaskWriteAuthorityLockSync(lockDirectory, () => {
        throw callbackError;
      })
    ).toThrow(callbackError);
    expect(() =>
      withProductTaskWriteAuthorityLockSync(lockDirectory, () => {
        throw new Error('v35 failed');
      })
    ).toThrow('v35 failed');
    expect(serialization.withCanonicalTaskWrite(teamB, () => 'recovered')).toBe('recovered');
  });

  it('rejects a replaced private lock directory before a worker acquisition', () => {
    const { lockDirectory } = fixture();
    const original = inspectProductTaskWritePrivateDirectory(lockDirectory);
    fs.renameSync(lockDirectory, `${lockDirectory}-old`);
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
    expect(() => assertProductTaskWritePrivateDirectoryIdentity(lockDirectory, original)).toThrow(
      /^product-task-write-lock-directory-changed$/
    );
  });
});
