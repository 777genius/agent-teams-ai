import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { hashFile } from './inputs.mts';
import { readPeArchitecture } from './windows-native.mts';
import { selectedWindowsPowerShell } from './windows-powershell.mts';
import type { windowsNative } from './windows-native.mts';
import {
  ARM211_FILES,
  ARM211_SHA,
  DECODER_ARCHIVE_SHA,
  usesRepairedArm211,
} from '../../ci/release/windowsArmPriorFixture.ts';
import type { ArmPriorFixture } from '../../ci/release/windowsArmPriorFixture.ts';
export { ARM211_FILES } from '../../ci/release/windowsArmPriorFixture.ts';

const unchanged = ['resources/app.asar', 'resources/app-update.yml'] as const;
const execute = promisify(execFile);
type Native = Awaited<ReturnType<typeof windowsNative>>;
type Bytes = Awaited<ReturnType<typeof hashFile>>;
type Guard = (file: string, exists?: boolean) => Promise<void>;
export function assertRepairManifest(entries: { name: string; method: string; link: boolean }[]) {
  assert.equal(entries.length, 1026, 'Original archive file count changed');
  const names = entries.map((entry) => entry.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'Archive name collision');
  for (const entry of entries) {
    const valid =
      !entry.link &&
      entry.name.length < 512 &&
      !/[\\:\0]/u.test(entry.name) &&
      entry.name.split('/').every((part) => part && part !== '.' && part !== '..');
    assert(
      valid,
      `Invalid original archive member: ${JSON.stringify({
        name: entry.name.slice(0, 512),
        method: entry.method.slice(0, 128),
        link: entry.link,
      })}`
    );
  }
  assert.deepEqual(
    entries
      .filter((entry) => /\bARM64\b/u.test(entry.method))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b)),
    [...ARM211_FILES].sort((a, b) => a.localeCompare(b))
  );
}
export async function assertFixturePath(root: string, file: string, exists: boolean) {
  const relative = path.relative(root, file);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(':')
  );
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    current = path.join(current, part);
    const item = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!item) {
      assert(!exists);
      return;
    }
    assert(!item.isSymbolicLink(), 'Fixture symbolic link rejected');
  }
  assert(exists, 'Existing destination cannot be repaired');
  assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
}
export async function copyOriginalArmFile(from: string, to: string, expected: Bytes, guard: Guard) {
  await guard(from);
  assert.deepEqual(await hashFile(from), expected);
  const pe = await readPeArchitecture(from);
  await guard(from);
  assert.equal(pe.architecture, 'arm64');
  await guard(to, false);
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await guard(to);
  const installed = await hashFile(to);
  const installedPe = await readPeArchitecture(to);
  await guard(to);
  assert.equal(installedPe.architecture, 'arm64');
  assert.deepEqual(installed, expected);
  return { source: expected, installed, architecture: pe.architecture };
}
export async function assertPreservedFiles(
  root: string,
  install: string,
  preserved: Record<string, Bytes>,
  guard: Guard
) {
  for (const [name, hash] of Object.entries(preserved)) {
    const file = name === 'cache/installer.exe' ? path.join(root, name) : path.join(install, name);
    await guard(file);
    assert.deepEqual(await hashFile(file), hash);
    await guard(file);
  }
}
export function decoderMember(compressed: Buffer) {
  const tar = gunzipSync(compressed, { maxOutputLength: 8_000_000 });
  let result: Buffer | undefined;
  let offset = 0,
    count = 0;
  while (offset + 512 <= tar.length) {
    assert(count++ < 32, 'Decoder tar entry limit');
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = (header.subarray(0, 100).toString().split('\0')[0] ?? '').replace(/^\.\//u, '');
    const size = Number.parseInt(
      (header.subarray(124, 136).toString().split('\0')[0] ?? '').trim(),
      8
    );
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
    assert(!name.startsWith('/') && !name.includes('..') && !/[\\:]/u.test(name));
    assert([0, 48, 53].includes(header[156] ?? -1), 'Decoder tar links/extension entries rejected');
    if (name === '7zip/bin/7za.exe') {
      assert(!result && header[156] !== 53);
      result = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(result && result.length > 0, 'Pinned decoder member unavailable');
  return result;
}
export async function acquireDecoder(directory: string) {
  const shell = await selectedWindowsPowerShell();
  const gh = await realpath(path.join(shell.programFiles, 'GitHub CLI', 'gh.exe'));
  assert.equal(
    gh.toLowerCase(),
    path.join(shell.programFiles, 'GitHub CLI', 'gh.exe').toLowerCase()
  );
  const route = 'repos/electron-userland/electron-builder-binaries/releases';
  const metadata = await execute(gh, ['api', `${route}/333828656`], {
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  const release = JSON.parse(metadata.stdout) as {
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: { id: number; name: string; size: number; digest: string; state: string }[];
  };
  assert.equal(release.id, 333828656);
  assert.equal(release.tag_name, '7zip@1.0.0');
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  const assets = release.assets.filter((asset) => asset.id === 437402763);
  assert.equal(assets.length, 1);
  assert.deepEqual(
    assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state })),
    [
      {
        id: 437402763,
        name: '7zip-win-arm64.tar.gz',
        size: 491981,
        digest: `sha256:${DECODER_ARCHIVE_SHA}`,
        state: 'uploaded',
      },
    ]
  );
  const transfer = await execute(
    gh,
    ['api', `${route}/assets/437402763`, '--header', 'Accept: application/octet-stream'],
    { encoding: 'buffer', timeout: 60_000, maxBuffer: 1_000_000 }
  );
  const archive = path.join(directory, 'decoder.tar.gz');
  await writeFile(archive, transfer.stdout, { flag: 'wx' });
  const proof = await hashFile(archive);
  assert.equal(proof.sha256, DECODER_ARCHIVE_SHA);
  assert.equal(proof.size, 491981);
  const executable = path.join(directory, '7za.exe');
  await writeFile(executable, decoderMember(transfer.stdout), { flag: 'wx' });
  return { executable, archive: proof, binary: await hashFile(executable) };
}
export function embeddedArm211Archive(bytes: Buffer) {
  const offset = 282639;
  assert.equal(bytes.subarray(offset, offset + 6).toString('hex'), '377abcaf271c');
  const end =
    offset +
    32 +
    Number(bytes.readBigUInt64LE(offset + 12)) +
    Number(bytes.readBigUInt64LE(offset + 20));
  assert(Number.isSafeInteger(end) && end <= bytes.length && end > offset + 32);
  return bytes.subarray(offset, end);
}
export function arm211ListingEntries(listing: string) {
  const sections = listing.split('----------');
  assert.equal(sections.length, 2);
  const body = sections[1];
  assert(body);
  const entries = body
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((entry) => {
      const fields = Object.fromEntries<string>(
        entry.split(/\r?\n/u).map((line): [string, string] => {
          const separator = line.indexOf(' = ');
          assert(separator > 0);
          return [line.slice(0, separator), line.slice(separator + 3)];
        })
      );
      return {
        name: String(fields.Path),
        method: String(fields.Method ?? ''),
        link: Object.keys(fields).some((key) => /link/iu.test(key)),
      };
    });
  return entries;
}
export async function prepareArmPriorFixture(options: {
  mode: string;
  targetVersion: string;
  root: string;
  install: string;
  priorInstaller: string;
  actualNsisExitCode: number;
  env: NodeJS.ProcessEnv;
  native: Native;
  ownDecoder: (file: string) => Promise<void>;
  recordDecoded: (ledger: unknown) => Promise<void>;
  recordListing: (receipt: unknown) => Promise<void>;
}): Promise<ArmPriorFixture | undefined> {
  if (!usesRepairedArm211(process.arch, options.mode, options.targetVersion)) return undefined;
  const { root, install, priorInstaller, native } = options;
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(options.actualNsisExitCode, 0);
  assert(Object.keys(options.env).every((key) => !/^(?:GH_TOKEN|GITHUB_TOKEN)$/iu.test(key)));
  assert.equal(path.basename(root).startsWith('TEST-'), true);
  assert.equal(install, path.join(root, 'install'));
  assert.equal(priorInstaller, path.join(root, 'prior.Setup.exe'));
  const directory = path.join(root, 'prior-fixture');
  const guarded = async (file: string, exists = true) => {
    const result = await native.priorFixtureGuard([file], false);
    assert.equal(result.files[0]?.exists, exists, 'Fixture path existence changed');
    assert.equal(result.files[0]?.path.toLowerCase(), file.toLowerCase());
    await assertFixturePath(root, file, exists);
  };
  await guarded(directory, false);
  await mkdir(directory);
  const staging = path.join(directory, 'payload');
  await guarded(staging, false);
  await mkdir(staging);
  const uninstaller = path.join(install, 'Uninstall AgentTeamsAI.exe');
  const cache = path.join(root, 'cache', 'installer.exe');
  const before = await native.priorFixtureGuard(
    [uninstaller, cache, ...ARM211_FILES.map((name) => path.join(install, name))],
    true
  );
  assert(before.registry);
  assert.equal(before.registry.installLocation.toLowerCase(), install.toLowerCase());
  assert.equal(
    before.registry.uninstallString.toLowerCase(),
    `"${uninstaller}" /currentuser`.toLowerCase()
  );
  assert.equal(
    before.registry.quietUninstallString.toLowerCase(),
    `"${uninstaller}" /currentuser /S`.toLowerCase()
  );
  assert.equal(before.registry.version, '2.17.1');
  assert(before.files.slice(0, 2).every((file) => file.exists));
  assert(
    before.files.slice(2).every((file) => !file.exists),
    'Repair requires exactly19 absent original ARM PE files'
  );
  await guarded(priorInstaller);
  const source = await hashFile(priorInstaller);
  await guarded(priorInstaller);
  assert.equal(source.sha256, ARM211_SHA);
  assert.equal(source.size, 196906862);
  const preserved: Record<string, Bytes> = {};
  for (const [name, file] of [
    ...unchanged.map((name) => [name, path.join(install, name)]),
    ['cache/installer.exe', cache],
    ['Uninstall AgentTeamsAI.exe', uninstaller],
  ]) {
    assert(name && file);
    await guarded(file);
    preserved[name] = await hashFile(file);
    await guarded(file);
  }
  assert.equal(preserved['cache/installer.exe']?.sha256, ARM211_SHA);
  await guarded(priorInstaller);
  const bytes = await readFile(priorInstaller);
  const embedded = embeddedArm211Archive(bytes);
  await guarded(priorInstaller);
  assert.deepEqual(await hashFile(priorInstaller), source);
  const archive = path.join(directory, 'app-arm64.7z');
  await writeFile(archive, embedded, { flag: 'wx' });
  const archiveProof = await hashFile(archive);
  const decoder = await acquireDecoder(directory);
  await guarded(decoder.executable);
  await options.ownDecoder(decoder.executable);
  const decode = async (args: string[]) => {
    await guarded(decoder.executable);
    assert.deepEqual(await hashFile(decoder.executable), decoder.binary);
    await guarded(archive);
    assert.deepEqual(await hashFile(archive), archiveProof);
    const result = await execute(decoder.executable, args, {
      env: options.env,
      cwd: directory,
      timeout: 180_000,
      maxBuffer: 2_000_000,
    });
    await guarded(decoder.executable);
    await guarded(archive);
    assert.deepEqual(await hashFile(decoder.executable), decoder.binary);
    assert.deepEqual(await hashFile(archive), archiveProof);
    return result.stdout;
  };
  const listing = await decode(['l', '-slt', archive]);
  await options.recordListing({ installer: source, archive: archiveProof, decoder, listing });
  const entries = arm211ListingEntries(listing);
  assertRepairManifest(entries);
  await decode(['x', '-y', `-o${staging}`, archive, ...ARM211_FILES, ...unchanged]);
  for (const name of unchanged) {
    const file = path.join(staging, name);
    await guarded(file);
    assert.deepEqual(await hashFile(file), preserved[name]);
    await guarded(file);
  }
  const files: ArmPriorFixture['files'] = [];
  const decoded = [];
  for (const name of ARM211_FILES) {
    const from = path.join(staging, name);
    await guarded(from);
    const hash = await hashFile(from);
    const pe = await readPeArchitecture(from);
    await guarded(from);
    decoded.push({ name, hash, pe });
  }
  await options.recordDecoded({ source, archive: archiveProof, decoder, decoded });
  assert(
    decoded.every(({ pe }) => pe.architecture === 'arm64'),
    'Decoded original PE must be ARM64'
  );
  for (const { name, hash } of decoded) {
    files.push({
      name,
      ...(await copyOriginalArmFile(
        path.join(staging, name),
        path.join(install, name),
        hash,
        guarded
      )),
    });
  }
  await assertPreservedFiles(root, install, preserved, guarded);
  assert.deepEqual(
    (await native.priorFixtureGuard([uninstaller, cache], true)).registry,
    before.registry
  );
  const receipt: ArmPriorFixture = {
    fixtureKind: 'repaired-original-arm64-211',
    originalPriorFreshInstallProved: false,
    actualNsisExitCode: options.actualNsisExitCode,
    source,
    sourceApplicationSha: '395572f9ff2a261cb28224754883a39d2c3c8827',
    archive: archiveProof,
    decoder: { archive: decoder.archive, executable: decoder.binary },
    preserved,
    registry: before.registry,
    files,
  };
  return receipt;
}
