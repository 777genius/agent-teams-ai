import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Finite CI actor: existing Docker digest pattern plus the unchanged native process journeys. */
assert.equal(process.env.LEGACY_REGISTERED_PROCESS_NATIVE_GO, '1');
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.21.0');
const [outputInput, ...extra] = process.argv.slice(2);
assert.ok(outputInput && !extra.length);
assert.match(outputInput, /\/TEST-[^/]+$/);
mkdirSync(outputInput, { mode: 0o700 });
const output = realpathSync(outputInput);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(packageRoot, '../..');
const nodeRoot = resolve(dirname(realpathSync(process.execPath)), '..');
assert.equal(realpathSync(join(nodeRoot, 'bin/node')), realpathSync(process.execPath));
for (const path of [output, repository, nodeRoot]) assert.doesNotMatch(path, /[:,\r\n\0]/);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command: string, args: string[], log: string, timeout = 300_000) => {
  try {
    const text = execFileSync(command, args, { cwd: repository, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(output, log), text, { mode: 0o600, flag: 'wx' }); return text;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    writeFileSync(join(output, log), (failure.stdout ?? '') + (failure.stderr ?? '') + failure.message, { mode: 0o600, flag: 'wx' });
    throw error;
  }
};
const sourceSha = run('git', ['rev-parse', 'HEAD'], 'source-sha.txt').trim();
assert.equal(sourceSha, process.env.EXPECTED_SOURCE_SHA);
assert.match(sourceSha, /^[a-f0-9]{40}$/);
const docker = realpathSync('/usr/bin/docker');
console.log('Resolving official UBI8 image to one exact digest');
run(docker, ['pull', 'registry.access.redhat.com/ubi8/ubi:8.10'], 'pull.log');
const images = JSON.parse(run(docker, ['image', 'inspect', 'registry.access.redhat.com/ubi8/ubi:8.10'], 'base-image.json')) as { RepoDigests?: string[] }[];
const matches = images[0]?.RepoDigests?.filter(value => /^registry\.access\.redhat\.com\/ubi8\/ubi@sha256:[a-f0-9]{64}$/.test(value));
assert.equal(matches?.length, 1);
const baseImage = matches![0]!;
const build = join(output, 'toolchain'); mkdirSync(build, { mode: 0o700 });
writeFileSync(join(build, 'Dockerfile'), `FROM ${baseImage}\nRUN dnf install -y gcc binutils glibc-devel kernel-headers && dnf clean all\n`, { mode: 0o600, flag: 'wx' });
console.log('Preparing official compiler and UAPI packages');
run(docker, ['build', '--iidfile', join(build, 'image.id'), build], 'toolchain-build.log', 600_000);
const toolchainImageId = readFileSync(join(build, 'image.id'), 'utf8').trim();
assert.match(toolchainImageId, /^sha256:[a-f0-9]{64}$/);
run(docker, ['image', 'inspect', toolchainImageId], 'toolchain-image.json');
writeFileSync(join(output, 'build-environment.json'), JSON.stringify({ baseImage, toolchainImageId, sourceSha }), { mode: 0o600, flag: 'wx' });
console.log('Building and loading original NAPI bytes in offline glibc2.28 userspace');
run(docker, ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
  '--mount', `type=bind,source=${repository},target=/source,readonly`,
  '--mount', `type=bind,source=${nodeRoot},target=/node,readonly`,
  '--mount', `type=bind,source=${output},target=/output/TEST-linux-abi`,
  '--env', 'LEGACY_REGISTERED_PROCESS_NATIVE_GO=1', '--env', `EXPECTED_SOURCE_SHA=${sourceSha}`,
  toolchainImageId, '/node/bin/node', '/source/packages/legacy-agent-host/scripts/qualifyLinuxProcessAbi.ts',
  '/output/TEST-linux-abi', '/output/TEST-linux-abi/build-environment.json', '/usr/bin/cc', '/usr/bin/readelf', '/node/include/node'], 'abi-build-load.log');
const abi = JSON.parse(readFileSync(join(output, 'abi-receipt.json'), 'utf8')) as {
  status: string; manifestSha256: string; binarySha256: string; sourceSha256: string;
};
assert.equal(abi.status, 'PASS');
const artifact = join(output, 'artifact');
assert.equal(hash(join(artifact, 'manifest.json')), abi.manifestSha256);
assert.equal(hash(join(artifact, 'registered-process.node')), abi.binarySha256);
assert.equal(hash(join(packageRoot, 'native/registered-process-linux.c')), abi.sourceSha256);
const actor = join(output, 'registered-process-actor');
const compiler = realpathSync('/usr/bin/cc');
run(compiler, ['-D_GNU_SOURCE', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread',
  join(packageRoot, 'tests/fixtures/registered-process-actor.c'), '-o', actor], 'actor-build.log', 30_000);
console.log('Qualifying automatic warm custody on the actual older host kernel');
const raw = run(process.execPath, [join(packageRoot, 'tests/registered-process-linux.native.mjs'),
  artifact, abi.manifestSha256, actor], 'automatic-native.log', 45_000);
const proof = JSON.parse(raw.trim()) as { workspace: string; completed: boolean; cleaned: boolean };
assert.match(proof.workspace, /^\/tmp\/TEST-linux-pidfd-[A-Za-z0-9]+$/);
assert.equal(proof.completed, true); assert.equal(proof.cleaned, true);
const original = readFileSync(join(proof.workspace, 'proof.ndjson'), 'utf8');
const entries = original.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
assert.equal(entries.find(row => row.phase === 'proved')?.captureVersion, 4,
  'actual automatic warm selection required; a newer hosted kernel cannot silently qualify this gate');
assert.ok(entries.some(row => row.phase === 'live-worker-after-thread-leader-exit' &&
  row.observation === 'unknown' && row.signal === 'refused' && row.workerClosed === false));
copyFileSync(join(proof.workspace, 'proof.ndjson'), join(output, 'automatic-proof.ndjson'));
assert.equal(hash(join(artifact, 'manifest.json')), abi.manifestSha256);
assert.equal(hash(join(artifact, 'registered-process.node')), abi.binarySha256);
run('git', ['diff', '--exit-code', '--'], 'source-unchanged.log');
const receipt = { schemaVersion: 1, status: 'PASS', sourceSha, baseImage, toolchainImageId,
  abiReceiptSha256: hash(join(output, 'abi-receipt.json')), manifestSha256: abi.manifestSha256,
  binarySha256: abi.binarySha256, nodeSha256: hash(realpathSync(process.execPath)),
  dockerSha256: hash(docker), actorCompilerSha256: hash(compiler), proof,
  scope: 'Same original glibc2.28 artifact, actual older host automatic warm capture and cleanup; no SDK/UI/installer claim' };
writeFileSync(join(output, 'host-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, manifestSha256: receipt.manifestSha256, binarySha256: receipt.binarySha256 }));
