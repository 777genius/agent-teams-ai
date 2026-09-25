import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProductTaskWriteFileSerialization } from '@main/composition/hosted/productTaskWriteSerialization';
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

function fixture(): ProductTaskWriteFileSerialization {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'product-task-lock-test-'));
  directories.push(parent);
  const lockDirectory = path.join(parent, 'product-private-locks');
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  return new ProductTaskWriteFileSerialization(lockDirectory);
}

describe('ProductTaskWriteFileSerialization', () => {
  it('blocks another writer for the same team while allowing a different team', async () => {
    const serialization = fixture();
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

    let secondEntered = false;
    const second = serialization.withTaskWrite(teamA, async () => {
      secondEntered = true;
    });
    expect(serialization.withCanonicalTaskWrite(teamB, () => 'other team')).toBe('other team');
    expect(() => serialization.withCanonicalTaskWrite(teamA, () => 'overlap')).toThrow(
      'File lock timeout'
    );
    expect(secondEntered).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    expect(serialization.withCanonicalTaskWrite(teamA, () => 'after release')).toBe(
      'after release'
    );
  });

  it('releases the shared lock when an async writer fails', async () => {
    const serialization = fixture();
    await expect(
      serialization.withTaskWrite(teamA, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect(serialization.withCanonicalTaskWrite(teamA, () => 'recovered')).toBe('recovered');
  });
});
