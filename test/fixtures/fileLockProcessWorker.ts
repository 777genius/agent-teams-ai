import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createFileLockApi } from '../../src/main/services/team/fileLock';

import type { FileLockNativePort } from '../../src/main/services/infrastructure/file-lock';

const [mode, authorityRoot, targetPath, tracePath] = process.argv.slice(2);
if (!authorityRoot || !targetPath || !tracePath || (mode !== 'hold' && mode !== 'acquire')) {
  throw new Error('Invalid file-lock process worker arguments');
}

interface Lease {
  authorityPath: string;
  marker: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class ProcessFixtureNativePort implements FileLockNativePort {
  private nextLease = 1n;
  private readonly leases = new Map<bigint, Lease>();

  captureScope(): bigint {
    return 1n;
  }

  tryAcquire(_scopeId: bigint, relativeTarget: string, marker: string) {
    const authorityDirectory = path.join(authorityRoot, '.fixture-native-authority');
    fs.mkdirSync(authorityDirectory, { recursive: true });
    const ownerKey = createHash('sha256').update(relativeTarget).digest('hex');
    const authorityPath = path.join(authorityDirectory, ownerKey);
    for (;;) {
      try {
        fs.writeFileSync(authorityPath, `${process.pid}\n`, { flag: 'wx' });
        const leaseId = this.nextLease++;
        this.leases.set(leaseId, { authorityPath, marker });
        return { status: 'acquired' as const, leaseId, ownerKey };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const priorPid = Number(fs.readFileSync(authorityPath, 'utf8').trim());
        if (Number.isSafeInteger(priorPid) && processIsAlive(priorPid)) {
          return { status: 'contended' as const };
        }
        fs.rmSync(authorityPath, { force: true });
      }
    }
  }

  assertOwned(leaseId: bigint): void {
    const lease = this.required(leaseId);
    if (fs.readFileSync(lease.authorityPath, 'utf8') !== `${process.pid}\n`) {
      throw new Error('fixture lease lost');
    }
  }

  publishRelease(leaseId: bigint, record: string): void {
    const lease = this.required(leaseId);
    if (record !== lease.marker) throw new Error('fixture release record mismatch');
    fs.writeFileSync(`${targetPath}.lock`, record, 'utf8');
  }

  release(leaseId: bigint): void {
    const lease = this.required(leaseId);
    fs.rmSync(lease.authorityPath, { force: true });
    this.leases.delete(leaseId);
  }

  abandon(leaseId: bigint): void {
    this.required(leaseId);
  }

  closeScope(): void {}

  private required(leaseId: bigint): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error('fixture lease missing');
    return lease;
  }
}

const api = createFileLockApi(new ProcessFixtureNativePort());
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
await api.withFileLock(
  { authorityRoot, targetPath },
  async () => {
    fs.appendFileSync(tracePath, `${mode}:acquired:${process.env.HOME ?? ''}\n`, 'utf8');
    process.stdout.write('acquired\n');
    if (mode === 'hold') {
      await new Promise<void>((resolve) => process.once('message', () => resolve()));
    }
  },
  { acquireTimeoutMs: 2_000, retryIntervalMs: 5 }
);
process.disconnect?.();
