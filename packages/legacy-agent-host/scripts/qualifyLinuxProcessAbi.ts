import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinuxProcessNativeArtifact } from './buildLinuxProcessNativeArtifact.ts';
import { loadProcessNativeArtifact } from '../dist/process/loadProcessNativeArtifact.js';
import { readPackagedLinuxProcessArtifact } from '../dist/process/readPackagedProcessArtifact.js';

/** Build-only actor in the resolved official UBI8 image; never imported by product startup. */
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.21.0');
const [outputInput, environmentInput, compilerInput, inspectorInput, headersInput, ...extra] = process.argv.slice(2);
assert.ok(outputInput && environmentInput && compilerInput && inspectorInput && headersInput && !extra.length);
const output = realpathSync(outputInput), environmentPath = realpathSync(environmentInput);
assert.match(output, /\/TEST-[^/]+$/);
assert.equal(lstatSync(output).isDirectory(), true);
assert.equal(lstatSync(environmentPath).isFile(), true);
assert.equal(lstatSync(environmentPath).nlink, 1);
assert.ok(lstatSync(environmentPath).size < 32 * 1024);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const environmentSha256 = hash(environmentPath);
const environment = JSON.parse(readFileSync(environmentPath, 'utf8')) as {
  baseImage: string; toolchainImageId: string; sourceSha: string;
};
assert.match(environment.baseImage, /^registry\.access\.redhat\.com\/ubi8\/ubi@sha256:[a-f0-9]{64}$/);
assert.match(environment.toolchainImageId, /^sha256:[a-f0-9]{64}$/);
assert.match(environment.sourceSha, /^[a-f0-9]{40}$/);
assert.equal(environment.sourceSha, process.env.EXPECTED_SOURCE_SHA);
const glibc = execFileSync('/usr/bin/getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8', timeout: 5000 }).trim();
assert.equal(glibc, 'glibc 2.28', 'the actual build/load userspace must be UBI8 glibc2.28');
const packages = execFileSync('/usr/bin/rpm', ['-qa', '--qf', '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n'],
  { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }).trim().split('\n').sort();
for (const name of ['gcc', 'binutils', 'glibc-devel', 'kernel-headers'])
  assert.ok(packages.some(value => value.startsWith(name + '-')), `official ${name} package is required`);
const compiler = realpathSync(compilerInput), inspector = realpathSync(inspectorInput), headersRoot = realpathSync(headersInput);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(packageRoot, 'native/registered-process-linux.c');
const artifact = buildLinuxProcessNativeArtifact({ compiler, compilerSha256: hash(compiler),
  inspector, inspectorSha256: hash(inspector), headersRoot,
  headers: ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']
    .map(file => ({ file, sha256: hash(join(headersRoot, file)) })),
  source, sourceSha256: hash(source), outputDirectory: join(output, 'artifact') });
const versions = artifact.manifest.libc.minimumVersion.split('.').map(Number);
assert.ok(versions[0]! < 2 || (versions[0] === 2 && versions[1]! <= 28), 'measured ELF GLIBC requirement must not exceed2.28');
const selected = readPackagedLinuxProcessArtifact(artifact);
const { native, assertBinary } = loadProcessNativeArtifact<{
  kernelIdentity(): { pidfd: boolean; pidfs: boolean; glibcVersion: string; machine: string; kernelRelease: string };
}>(selected);
const capabilities = native.kernelIdentity();
assert.equal(capabilities.glibcVersion, '2.28'); assert.equal(capabilities.machine, 'x86_64');
assert.equal(typeof capabilities.pidfd, 'boolean'); assert.equal(typeof capabilities.pidfs, 'boolean');
assertBinary();
assert.equal(hash(environmentPath), environmentSha256);
const receipt = { schemaVersion: 1, status: 'PASS', scope: 'Actual glibc2.28 build and NAPI load; host kernel is shared',
  environment, environmentSha256, packages, glibc, nodeVersion: process.version,
  nodeSha256: hash(realpathSync(process.execPath)), capabilities,
  manifestSha256: artifact.manifestSha256, binarySha256: artifact.manifest.binarySha256,
  sourceSha256: artifact.manifest.sourceSha256, measuredMinimumVersion: artifact.manifest.libc.minimumVersion };
writeFileSync(join(output, 'abi-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, manifestSha256: receipt.manifestSha256,
  binarySha256: receipt.binarySha256, measuredMinimumVersion: receipt.measuredMinimumVersion, glibc }));
