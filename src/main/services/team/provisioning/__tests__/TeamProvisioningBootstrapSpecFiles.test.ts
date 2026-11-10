import { setAppDataBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupOrphanedDeterministicBootstrapSpecs,
  removeOwnedBootstrapSpecFile,
  writeOwnedBootstrapSpecFile,
} from '../TeamProvisioningBootstrapSpecFiles';

const deadPid = 2_147_483_647;
const markerName = '.agent-teams-bootstrap-owner.json';
let testRoot: string;
let directories: string[];

async function writeSpec(): Promise<string> {
  const filePath = await writeOwnedBootstrapSpecFile(
    '{"members":[{"env":{"API_KEY":"test-secret"}}]}'
  );
  directories.push(path.dirname(filePath));
  return filePath;
}

async function changeOwner(specPath: string, changes: Record<string, unknown>): Promise<void> {
  const markerPath = path.join(path.dirname(specPath), markerName);
  const owner = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(markerPath, JSON.stringify({ ...owner, ...changes }));
}

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-bootstrap-spec-profile-'));
  directories = [];
  setAppDataBasePath(testRoot);
});
afterEach(async () => {
  setAppDataBasePath(null);
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('one-shot bootstrap file custody', () => {
  it('writes private spec and secret-free ownership, and cleans idempotently', async () => {
    const specPath = await writeSpec();
    expect(path.basename(specPath)).toBe('bootstrap.json');
    const directory = path.dirname(specPath);
    const marker = path.join(directory, markerName);
    if (process.platform !== 'win32') {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(specPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual({
      version: 1,
      kind: 'agent-teams-bootstrap',
      ownerPid: process.pid,
      specFile: 'bootstrap.json',
    });
    await removeOwnedBootstrapSpecFile(specPath);
    await removeOwnedBootstrapSpecFile(specPath);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves arbitrary user specs and refuses symlinks', async () => {
    const userSpec = path.join(testRoot, 'bootstrap.json');
    await fs.writeFile(userSpec, 'user-spec');
    await removeOwnedBootstrapSpecFile(userSpec);
    expect(await fs.readFile(userSpec, 'utf8')).toBe('user-spec');
    const ownedSpec = await writeSpec();
    await fs.unlink(ownedSpec);
    await fs.symlink(userSpec, ownedSpec);
    await removeOwnedBootstrapSpecFile(ownedSpec);
    expect((await fs.lstat(ownedSpec)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(userSpec, 'utf8')).toBe('user-spec');
  });

  it('only reclaims this profile dead owners, preserving live consumers and pre-lease processes', async () => {
    const orphan = await writeSpec();
    await changeOwner(orphan, { ownerPid: deadPid });
    const liveOwner = await writeSpec();
    const liveConsumer = await writeSpec();
    await changeOwner(liveConsumer, { ownerPid: deadPid, consumerPid: process.pid });
    const preLease = await writeSpec();
    await changeOwner(preLease, { ownerPid: deadPid });
    setAppDataBasePath(path.join(testRoot, 'another-profile'));
    const otherProfile = await writeSpec();
    await changeOwner(otherProfile, { ownerPid: deadPid });
    setAppDataBasePath(testRoot);
    await cleanupOrphanedDeterministicBootstrapSpecs(async () => [
      { pid: process.pid, command: `runtime --team-bootstrap-spec ${preLease}` },
    ]);
    await expect(fs.stat(path.dirname(orphan))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const preserved of [liveOwner, liveConsumer, preLease, otherProfile]) {
      expect(await fs.readFile(preserved, 'utf8')).toContain('test-secret');
    }
    await removeOwnedBootstrapSpecFile(liveConsumer);
    expect(await fs.readFile(liveConsumer, 'utf8')).toContain('test-secret');
  });

  it('preserves files when process observation or ownership proof fails', async () => {
    const specPath = await writeSpec();
    await changeOwner(specPath, { ownerPid: deadPid });
    await expect(
      cleanupOrphanedDeterministicBootstrapSpecs(async () => {
        throw new Error('process table unavailable');
      })
    ).rejects.toThrow('process table unavailable');
    expect(await fs.readFile(specPath, 'utf8')).toContain('test-secret');
    await changeOwner(specPath, { kind: 'user-file' });
    await cleanupOrphanedDeterministicBootstrapSpecs(async () => []);
    expect(await fs.readFile(specPath, 'utf8')).toContain('test-secret');
  });
});
