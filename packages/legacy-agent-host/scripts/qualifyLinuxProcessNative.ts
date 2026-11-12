import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinuxProcessNativeArtifact } from './buildLinuxProcessNativeArtifact.ts';

/** Explicit native TEST build/proof actor; no import from product startup. */
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
const [outputInput, compilerInput, inspectorInput, headersInput] = process.argv.slice(2);
assert.ok(outputInput && compilerInput && inspectorInput && headersInput);
assert.match(outputInput, /\/TEST-[^/]+(?:\/[^/]+)*$/);
mkdirSync(outputInput, { mode: 0o700 });
const output = realpathSync(outputInput);
const compiler = realpathSync(compilerInput), inspector = realpathSync(inspectorInput);
const headersRoot = realpathSync(headersInput);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const source = join(packageRoot, 'native/registered-process-linux.c');
const artifact = buildLinuxProcessNativeArtifact({ compiler, compilerSha256: hash(compiler),
  inspector, inspectorSha256: hash(inspector), headersRoot,
  headers: ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']
    .map(file => ({ file, sha256: hash(join(headersRoot, file)) })),
  source, sourceSha256: hash(source), outputDirectory: join(output, 'artifact') });
const actor = join(output, 'registered-process-actor');
execFileSync(compiler, ['-D_GNU_SOURCE', '-std=c11', '-Wall', '-Wextra', '-Werror',
  join(packageRoot, 'tests/fixtures/registered-process-actor.c'), '-o', actor],
{ timeout: 30_000, maxBuffer: 1024 * 1024 });
assert.equal(hash(compiler), artifact.manifest.compilerSha256);
const selection = { directory: artifact.directory, manifestSha256: artifact.manifestSha256, actor };
writeFileSync(join(output, 'selection.json'), JSON.stringify(selection, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const stdout = execFileSync(process.execPath, [join(packageRoot, 'tests/registered-process-linux.native.mjs'),
  artifact.directory, artifact.manifestSha256, actor],
{ encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
writeFileSync(join(output, 'native.log'), stdout, { mode: 0o600, flag: 'wx' });
const proof = JSON.parse(stdout.trim()) as { workspace: string; completed: boolean; cleaned: boolean };
assert.match(proof.workspace, /^\/tmp\/TEST-linux-pidfd-[A-Za-z0-9]+$/);
assert.equal(proof.completed, true); assert.equal(proof.cleaned, true);
copyFileSync(join(proof.workspace, 'proof.ndjson'), join(output, 'proof.ndjson'));
console.log(JSON.stringify({ ...selection, completed: true, cleaned: true,
  binarySha256: artifact.manifest.binarySha256, libc: artifact.manifest.libc,
  scope: 'Linux pidfs native/Host composition proof; SDK, Desktop and older kernels remain separate' }));
