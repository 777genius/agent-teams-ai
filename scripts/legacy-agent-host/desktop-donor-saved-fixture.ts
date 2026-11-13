import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  classifyLegacySavedTeamNativeRecords,
  isLegacySavedTeamProductRecords,
} from '../../src/main/services/team/LegacySavedTeamNativeIdentity.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { selectedCdpPort } from './desktop-backend-observations.ts';
import { stoppedImportSourceBytes } from './desktop-stopped-import-fixture.ts';

export const DONOR_SAVED_COMMIT = '4a0e06277fe216d9f82dbbede362668fe46622ee';
export const DONOR_SAVED_MEMBER = 'donor-peer';
export const DONOR_SAVED_DESCRIPTION = 'TEST genuine donor saved Team; no native business input';
export type DonorRow = Record<string, unknown>;
export const donorRow = (value: unknown): DonorRow => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as DonorRow;
};
export const readDonorJson = async (path: string) =>
  donorRow(JSON.parse(await readFile(path, 'utf8')));
const git = (directory: string, args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', directory, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).trim();

/** Actual exact donor checkout and installed inputs; no source or product-record edits. */
export async function captureDonorSavedInputs(directory: string, node: string) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  const root = await realpath(directory);
  assert.equal(git(root, ['rev-parse', '--show-toplevel']), root);
  assert.equal(git(root, ['rev-parse', 'HEAD']), DONOR_SAVED_COMMIT);
  assert.equal(
    git(root, ['status', '--porcelain=v1', '--untracked-files=no']),
    '',
    'donor source and lock remain unchanged'
  );
  const packageJson = await readDonorJson(join(root, 'package.json'));
  assert.equal(donorRow(packageJson.scripts)['dev:mcp'],
    'node ./scripts/dev-with-runtime.mjs --remoteDebuggingPort ' + String(selectedCdpPort),
    'the original donor script supplies the selected CDP argument exactly once');
  assert.match(String(packageJson.packageManager), /^pnpm@11\.22\.0\+sha512\./);
  const runtimeLock = await readDonorJson(join(root, 'runtime.lock.json'));
  assert.equal(runtimeLock.version, '0.0.160');
  const asset = donorRow(donorRow(runtimeLock.assets)['darwin-arm64']);
  assert.equal(asset.sha256, 'facece83f619c4b1c1ec3a76cff25727d85a2b75d18812cbc3a5b729e855ecc9');
  const cacheRoot = await realpath(process.env.LEGACY_DESKTOP_DONOR_RUNTIME_CACHE!);
  const payload = join(cacheRoot, '0.0.160/darwin-arm64/payload-v1');
  const native = await realpath(join(payload, 'claude-multimodel'));
  assert.equal(dirname(native), payload);
  const validator = await import(
    pathToFileURL(join(root, 'scripts/lib/runtime-payload-cache.mjs')).href
  );
  assert.equal(typeof validator.isRuntimePayloadCacheValid, 'function');
  assert.equal(
    await validator.isRuntimePayloadCacheValid(payload, asset.sha256, asset.binaryName),
    true,
    'ordinary donor bootstrap retained the complete checksum-verified runtime payload'
  );
  const require = createRequire(join(root, 'package.json'));
  const electronPackage = require.resolve('electron/package.json');
  const electronRoot = dirname(electronPackage);
  const relative = (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim();
  assert.equal(relative, 'Electron.app/Contents/MacOS/Electron');
  const electron = await realpath(join(electronRoot, 'dist', relative));
  const files = await Promise.all(
    ['package.json', 'pnpm-lock.yaml', 'runtime.lock.json'].map(async (path) => ({
      path,
      sha256: await fileDigest(join(root, path)),
    }))
  );
  return {
    root,
    commit: DONOR_SAVED_COMMIT,
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    packageManager: packageJson.packageManager,
    files,
    node: { path: node, version: process.version, sha256: await fileDigest(node) },
    electron: {
      path: electron,
      version: (await readDonorJson(electronPackage)).version,
      sha256: await fileDigest(electron),
    },
    runtime: {
      path: native,
      version: runtimeLock.version,
      cliVersion: runtimeLock.cliVersion,
      archiveSha256: asset.sha256,
      sha256: await fileDigest(native),
      cacheValidated: true,
    },
  };
}
export type DonorSavedInputs = Awaited<ReturnType<typeof captureDonorSavedInputs>>;

export async function captureDonorSavedCorpus(root: string, teamName: string) {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.match(teamName, /^test-donor-saved-[a-f0-9]{12}$/);
  const roots = [
    join(root, 'claude/teams', teamName),
    join(root, 'claude/tasks', teamName),
    join(root, 'userData/data/attachments', teamName),
    join(root, 'userData/data/task-attachments', teamName),
  ];
  const present: string[] = [],
    absent: string[] = [];
  for (const path of roots) {
    try {
      const stat = await lstat(path);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      present.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent.push(path);
    }
  }
  assert.ok(present.includes(roots[0]!));
  const files = await stoppedImportSourceBytes(root, present);
  assert.ok(files.some((file) => file.path === join(roots[0]!, 'team.meta.json')));
  assert.ok(files.some((file) => file.path === join(roots[0]!, 'members.meta.json')));
  assert.ok(
    !files.some((file) => file.path === join(roots[0]!, 'config.json')),
    'actual save-only Create has no native CLI configuration'
  );
  assert.equal(
    files.filter((file) => !file.path.startsWith(roots[0]! + '/')).length,
    0,
    'this genuine saved-only corpus does not claim task or attachment coverage'
  );
  const meta = await readDonorJson(join(roots[0]!, 'team.meta.json'));
  const roster = await readDonorJson(join(roots[0]!, 'members.meta.json'));
  assert.equal(
    classifyLegacySavedTeamNativeRecords(teamName, { config: null, meta, roster }),
    'empty'
  );
  assert.equal(isLegacySavedTeamProductRecords(teamName, { config: null, meta, roster }), true);
  assert.equal(meta.cwd, join(root, 'workspace'));
  assert.equal(meta.description, DONOR_SAVED_DESCRIPTION);
  assert.equal(meta.model, 'claude-sonnet-4-6');
  assert.equal(Object.hasOwn(meta, 'effort'), false, 'compatible donor catalogue omits unsupported effort');
  assert.ok(Array.isArray(roster.members));
  assert.deepEqual(
    roster.members.map((value) => donorRow(value).name),
    [DONOR_SAVED_MEMBER]
  );
  return { present, absent, files, meta, roster, nativeIdentity: 'empty' as const };
}
export type DonorSavedCorpus = Awaited<ReturnType<typeof captureDonorSavedCorpus>>;
export interface DonorSavedSeed {
  sourceKind: 'actual-donor-saved-only';
  teamName: string;
  displayName: string;
  producer: DonorSavedInputs;
  producerProbeCount: number;
  source: DonorSavedCorpus;
}
export async function writeDonorSavedSeed(root: string, seed: DonorSavedSeed): Promise<void> {
  await writeFile(join(root, 'desktop-donor-saved-seed.json'), JSON.stringify(seed, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
}
export async function readDonorSavedSeed(root: string): Promise<DonorSavedSeed> {
  const seed = await readDonorJson(join(root, 'desktop-donor-saved-seed.json'));
  assert.equal(seed.sourceKind, 'actual-donor-saved-only');
  assert.ok(typeof seed.teamName === 'string');
  assert.ok(typeof seed.displayName === 'string');
  assert.match(seed.teamName, /^test-donor-saved-[a-f0-9]{12}$/);
  assert.equal(donorRow(seed.producer).commit, DONOR_SAVED_COMMIT);
  assert.ok(
    Number.isSafeInteger(seed.producerProbeCount) &&
      Number(seed.producerProbeCount) >= 0 &&
      Number(seed.producerProbeCount) <= 8
  );
  const source = await captureDonorSavedCorpus(root, seed.teamName);
  assert.deepEqual(source, seed.source, 'original donor source bytes remain immutable');
  return {
    sourceKind: 'actual-donor-saved-only',
    teamName: seed.teamName,
    displayName: seed.displayName,
    producer: seed.producer as DonorSavedInputs,
    producerProbeCount: Number(seed.producerProbeCount),
    source,
  };
}
