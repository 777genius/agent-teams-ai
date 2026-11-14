import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { digest, fileDigest } from './desktop-backend-fixture.ts';
import { json, record } from './desktop-resume-records.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';

export const emulatedCodexInstallerSource = 'tools/owned-process-broker/fixtures/codexInstallerRegistry.cjs';
type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
type Source = { path: string; sha256: string };
const binaryVersionA = '0.162.0', binaryVersionB = '0.169.0';
const vendor = 'aarch64-apple-darwin';
const platformTag = 'darwin-arm64';

function archive(files: { name: string; content: string; mode: number }[]) {
  const parts: Buffer[] = [];
  for (const file of files) {
    const name = `package/vendor/${vendor}/${file.name}`, content = Buffer.from(file.content), header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(name) < 100 && !name.includes('..'));
    header.write(name, 0, 100, 'utf8');
    for (const [offset, length, value] of [[100, 8, file.mode], [108, 8, 0], [116, 8, 0], [124, 12, content.length], [136, 12, 0]])
      header.write(value!.toString(8).padStart(length! - 1, '0') + '\0', offset!, length!, 'ascii');
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}

/** Finite A/B launchers and a package body; actual installation and selection stay with Main/Host. */
export async function prepareDesktopEmulatedCodexInstaller(fixture: Fixture, repo: string, sources: readonly Source[]) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const root = join(fixture.root, 'TEST-codex-install');
  await mkdir(root, { mode: 0o700 });
  for (const directory of ['bin', 'path', 'codex']) await mkdir(join(root, directory), { mode: 0o700 });
  const helper = '#!/bin/sh\nprintf "TEST finite Codex package helper\\n"\n';
  const manifest = (version: string) => JSON.stringify({ kind: 'TEST-emulated-codex-package', version, vendor, inference: false }) + '\n';
  const wrapper = (version: string) => `#!${fixture.node}
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=${JSON.stringify(root)},executable=fileURLToPath(import.meta.url),version=${JSON.stringify(version)};
assert.equal(realpathSync(root),root);assert.equal(realpathSync(executable),executable);
assert.equal(sha(readFileSync(join(dirname(executable),'../path/rg'))),${JSON.stringify(digest(helper))});
assert.equal(sha(readFileSync(join(dirname(executable),'../codex/TEST-package.json'))),${JSON.stringify(digest(manifest(version)))});
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(sha(readFileSync(source.path)),source.sha256)}
const argv=process.argv.slice(2),isVersion=argv.length===1&&argv[0]==='--version';
const log=join(root,'invocations.ndjson');try{assert.ok(lstatSync(log).isFile()&&lstatSync(log).size<1024*1024)}catch(e){if(e.code!=='ENOENT')throw e}
appendFileSync(log,JSON.stringify({event:'invoke',pid:process.pid,parentPid:process.ppid,executable,version,kind:isVersion?'version':'app-server'})+'\\n',{mode:0o600});
if(isVersion)process.stdout.write('codex-cli '+version+'\\n');
else {assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER,'1');assert.equal(process.env.TEST_PEER_PROVIDER,'codex');await import(${JSON.stringify(pathToFileURL(sources[0]!.path).href)})}
`;
  const a = wrapper(binaryVersionA), b = wrapper(binaryVersionB), executable = { path: join(root, 'bin/codex'), sha256: digest(a) };
  await writeFile(executable.path, a, { mode: 0o700, flag: 'wx' });
  await writeFile(join(root, 'path/rg'), helper, { mode: 0o700, flag: 'wx' });
  await writeFile(join(root, 'codex/TEST-package.json'), manifest(binaryVersionA), { mode: 0o600, flag: 'wx' });
  const packageFiles = [{ name: 'codex/codex', content: b, mode: 0o700 },
    { name: 'path/rg', content: helper, mode: 0o700 }, { name: 'codex/TEST-package.json', content: manifest(binaryVersionB), mode: 0o600 }];
  const tarballBytes = archive(packageFiles), integrity = 'sha512-' + createHash('sha512').update(tarballBytes).digest('base64');
  const tarball = { path: join(root, 'TEST-codex-0.169.0-darwin-arm64.tgz'), sha256: digest(tarballBytes) };
  await writeFile(tarball.path, tarballBytes, { mode: 0o600, flag: 'wx' });
  const preload = { path: join(repo, emulatedCodexInstallerSource), sha256: await fileDigest(join(repo, emulatedCodexInstallerSource)) };
  assert.equal(await realpath(preload.path), preload.path); assert.equal(/\s/u.test(preload.path), false);
  const latestUrl = 'https://registry.npmjs.org/%40openai%2Fcodex/latest';
  const platformVersion = binaryVersionB + '-' + platformTag;
  const platformUrl = 'https://registry.npmjs.org/%40openai%2Fcodex/' + platformVersion;
  const tarballUrl = 'https://registry.npmjs.org/@openai/codex/-/TEST-emulated-codex-0.169.0-darwin-arm64.tgz';
  const dist = { tarball: tarballUrl, integrity };
  const body = { kind: 'TEST-emulated-codex-installer-v1', root, preload, tarball, integrity, latestUrl, platformUrl, tarballUrl,
    latestMetadata: { name: '@openai/codex', version: binaryVersionB, dist,
      optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@' + platformVersion } },
    platformMetadata: { name: '@openai/codex', version: platformVersion, dist } };
  const fixturePath = join(root, 'fixture.json'), fixtureBytes = JSON.stringify(body);
  await writeFile(fixturePath, fixtureBytes, { mode: 0o600, flag: 'wx' });
  const applicationEnvironment = fixture.appEnvironment as Record<string, string>;
  assert.ok(applicationEnvironment.NODE_OPTIONS === undefined || applicationEnvironment.NODE_OPTIONS === '--max-old-space-size=8192');
  applicationEnvironment.NODE_OPTIONS = [applicationEnvironment.NODE_OPTIONS, '--require=' + preload.path].filter(Boolean).join(' ');
  applicationEnvironment.TEST_CODEX_INSTALL_FIXTURE = fixturePath;
  applicationEnvironment.TEST_CODEX_INSTALL_FIXTURE_SHA256 = digest(fixtureBytes);
  applicationEnvironment.PATH = dirname(executable.path) + ':' + applicationEnvironment.PATH;
  delete applicationEnvironment.CODEX_CLI_PATH;
  return { root, executable, binaryVersionA, binaryVersionB, preload, tarball, integrity,
    fixture: { path: fixturePath, sha256: digest(fixtureBytes) },
    packageFiles: packageFiles.map(file => ({ relativePath: file.name, sha256: digest(file.content), mode: file.mode })),
    aFiles: [{ path: join(root, 'path/rg'), sha256: digest(helper) },
      { path: join(root, 'codex/TEST-package.json'), sha256: digest(manifest(binaryVersionA)) }],
    manifestPath: join(fixture.root, 'userData/data/runtimes/codex/current.json'),
    expectedBinarySha256: digest(b), invocationLog: join(root, 'invocations.ndjson'), registryLog: join(root, 'registry.ndjson') };
}

export type EmulatedCodexInstaller = Awaited<ReturnType<typeof prepareDesktopEmulatedCodexInstaller>>;

export async function verifyDesktopEmulatedCodexInstaller(selected: EmulatedCodexInstaller) {
  for (const pin of [selected.executable, selected.preload, selected.tarball, selected.fixture, ...selected.aFiles]) {
    assert.equal(await realpath(pin.path), pin.path); assert.equal(await fileDigest(pin.path), pin.sha256);
  }
  return { package: 'TEST finite package, not an official Codex distribution', aVersion: selected.binaryVersionA,
    bVersion: selected.binaryVersionB, aSha256: selected.executable.sha256, bSha256: selected.expectedBinarySha256,
    packageSha256: selected.tarball.sha256, integrity: selected.integrity, preloadSha256: selected.preload.sha256 };
}

/** Strict identity observation of the real stock installer output, never a path chosen by the test. */
export async function readDesktopEmulatedCodexInstallation(selected: EmulatedCodexInstaller) {
  let manifest;
  try { manifest = await json(selected.manifestPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.rootVersion, selected.binaryVersionB);
  assert.equal(manifest.platformVersion, selected.binaryVersionB + '-' + platformTag); assert.equal(manifest.platformTarget, vendor);
  assert.equal(manifest.integrity, selected.integrity);
  const path = String(manifest.binaryPath), installation = dirname(dirname(path));
  const versionRoot = join(dirname(selected.manifestPath), 'versions', selected.binaryVersionB + '-' + platformTag);
  assert.equal(dirname(installation), versionRoot); assert.ok(basename(installation).startsWith(vendor + '-'));
  assert.match(basename(installation).slice(vendor.length + 1), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert.equal(relative(installation, path), 'codex/codex'); assert.equal(await realpath(installation), installation);
  for (const file of selected.packageFiles) {
    const target = join(installation, file.relativePath); assert.equal(await realpath(target), target);
    const stat = await lstat(target); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(await fileDigest(target), file.sha256);
    if (file.mode & 0o111) assert.equal(stat.mode & 0o777, file.mode);
    else assert.equal(stat.mode & 0o111, 0);
  }
  assert.equal(await fileDigest(path), selected.expectedBinarySha256);
  return { manifest, manifestPath: selected.manifestPath, manifestSha256: await fileDigest(selected.manifestPath),
    installation, executable: { path, sha256: selected.expectedBinarySha256 }, packageFiles: selected.packageFiles };
}

export async function readDesktopEmulatedCodexInstallerLog(path: string) {
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 1024 * 1024);
  const values = (await readFile(path, 'utf8')).trim().split('\n').map(line => record(JSON.parse(line)));
  assert.ok(values.length <= 2048 && values.every(row => Number.isSafeInteger(row.pid) && Number(row.pid) > 1));
  assert.equal(values.some(row => row.event === 'failure'), false); return values;
}
