import { randomBytes } from 'node:crypto';
import { chmod, chown, lstat, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRootOwnedChain, atomicWriteFile, ensureDirectory, pathExists, readRegularFile,
  sha256File } from './fsutil.mjs';
import { docker as defaultDocker } from './process.mjs';

export const OWNER_INSTALL_FORMAT = 'agent-teams.hosted-launcher.owner-install/v1';
const PINNED_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})+@sha256:[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const LAUNCHER = /^hostedActualOwnerLauncher-([0-9a-f]{64})$/u;
const EXECUTABLES = new Set(['cli', 'bin/bun']);

/** Docker reports repo digests with registry defaults filled in; compare in that form. */
export function canonicalImageReference(value) {
  if (typeof value !== 'string' || !value.includes('@')) return null;
  const [tagged, digest] = value.split('@');
  let name = tagged;
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  if (lastColon > lastSlash) name = name.slice(0, lastColon);
  const first = name.split('/')[0];
  if (!name.includes('/')) name = `docker.io/library/${name}`;
  else if (!first.includes('.') && !first.includes(':') && first !== 'localhost') name = `docker.io/${name}`;
  return `${name}@${digest}`;
}

async function assertRepoDigest(reference, docker) {
  const raw = await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', reference]);
  let digests;
  try { digests = JSON.parse(raw); } catch { throw new Error('hostedctl-owner-repo-digest-invalid'); }
  const wanted = canonicalImageReference(reference);
  if (!Array.isArray(digests) || !digests.some(item => canonicalImageReference(item) === wanted)) {
    throw new Error('hostedctl-owner-repo-digest-mismatch');
  }
}

/** Exactly the closure the E2E Owner image carries; anything else is refused. */
async function ownerInventory(root) {
  const exact = async (path, expected) => {
    const actual = (await readdir(path)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(`hostedctl-owner-inventory-invalid:${path}`);
    }
  };
  await exact(root, ['bin', 'cli', 'dist']);
  await exact(join(root, 'bin'), ['bun']);
  await exact(join(root, 'dist'), ['local-cli']);
  const bundle = join(root, 'dist', 'local-cli');
  const launchers = (await readdir(bundle)).filter(name => LAUNCHER.test(name));
  if (launchers.length !== 1) throw new Error('hostedctl-owner-launcher-ambiguous');
  await exact(bundle, ['cli.js', launchers[0]]);
  return ['cli', 'bin/bun', 'dist/local-cli/cli.js', `dist/local-cli/${launchers[0]}`];
}

async function sealTree(root, files) {
  for (const relative of files) {
    const path = join(root, relative);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size === 0) {
      throw new Error(`hostedctl-owner-file-invalid:${relative}`);
    }
    await chown(path, 0, 0);
    const executable = EXECUTABLES.has(relative) || LAUNCHER.test(relative.split('/').at(-1));
    await chmod(path, executable ? 0o555 : 0o444);
  }
  for (const directory of ['dist/local-cli', 'dist', 'bin', '.']) {
    await chown(join(root, directory), 0, 0);
    await chmod(join(root, directory), 0o555);
  }
}

async function digestFiles(root, files) {
  const digests = {};
  for (const relative of files) digests[relative] = await sha256File(join(root, relative));
  const launcher = files.find(relative => LAUNCHER.test(relative.split('/').at(-1)));
  const named = LAUNCHER.exec(launcher.split('/').at(-1))[1];
  if (digests[launcher] !== named) throw new Error('hostedctl-owner-launcher-digest-mismatch');
  return { digests, executableDigest: `sha256:${named}` };
}

/**
 * Extracts /opt/owner from a digest-pinned image into installRoot/owner/<digest>. The image must
 * already carry that repo digest locally (pulled from a registry or pushed to a local one);
 * a digest is never synthesized from files.
 */
export async function installOwner({ imageReference, artifactVersion, installRoot, pull = true,
  docker = defaultDocker }) {
  if (!PINNED_IMAGE.test(imageReference ?? '')) throw new Error('hostedctl-owner-image-must-be-pinned-by-digest');
  if (!VERSION.test(artifactVersion ?? '')) throw new Error('hostedctl-owner-version-must-be-semver');
  const artifactDigest = imageReference.slice(imageReference.lastIndexOf('@') + 1);
  if (pull) await docker(['pull', imageReference], { timeoutMs: 20 * 60_000 });
  await assertRepoDigest(imageReference, docker);
  await ensureDirectory(join(installRoot, 'owner'), { mode: 0o755 });
  await assertRootOwnedChain(join(installRoot, 'owner'));
  const root = join(installRoot, 'owner', artifactDigest.slice('sha256:'.length));
  if (await pathExists(root)) {
    throw new Error(`hostedctl-owner-already-installed:${root}`);
  }
  const staging = join(installRoot, 'owner', `.staging-${randomBytes(8).toString('hex')}`);
  const container = `hostedctl-extract-${randomBytes(8).toString('hex')}`;
  await ensureDirectory(staging, { mode: 0o700 });
  try {
    await docker(['create', '--name', container, imageReference]);
    try { await docker(['cp', `${container}:/opt/owner/.`, staging], { timeoutMs: 10 * 60_000 }); }
    finally { await docker(['rm', '-f', container]).catch(() => undefined); }
    const files = await ownerInventory(staging);
    await sealTree(staging, files);
    const { digests, executableDigest } = await digestFiles(staging, files);
    if (executableDigest === artifactDigest) throw new Error('hostedctl-owner-digests-not-distinct');
    await rename(staging, root);
    return Object.freeze({ format: OWNER_INSTALL_FORMAT, imageReference, artifactDigest,
      artifactVersion, executableDigest, root, files: digests,
      installedAt: new Date().toISOString() });
  } catch (error) {
    await chmod(staging, 0o700).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Re-hashes every installed file before each Owner start. Any drift refuses the start. */
export async function verifyInstalledOwner(installed, { trustedUid = 0 } = {}) {
  if (installed?.format !== OWNER_INSTALL_FORMAT) throw new Error('hostedctl-owner-install-record-invalid');
  await assertRootOwnedChain(installed.root, { trustedUids: [...new Set([0, trustedUid])] });
  const files = await ownerInventory(installed.root);
  if (JSON.stringify([...files].sort()) !== JSON.stringify(Object.keys(installed.files).sort())) {
    throw new Error('hostedctl-owner-inventory-changed');
  }
  for (const relative of files) {
    const path = join(installed.root, relative);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== trustedUid ||
        entry.nlink !== 1 || (entry.mode & 0o222) !== 0) {
      throw new Error(`hostedctl-owner-file-custody-invalid:${relative}`);
    }
    if (await sha256File(path) !== installed.files[relative]) {
      throw new Error(`hostedctl-owner-file-digest-mismatch:${relative}`);
    }
  }
  const launcher = files.find(relative => LAUNCHER.test(relative.split('/').at(-1)));
  return Object.freeze({ cli: join(installed.root, 'cli'), bun: join(installed.root, 'bin', 'bun'),
    cliJs: join(installed.root, 'dist', 'local-cli', 'cli.js'), launcher: join(installed.root, launcher),
    sha256: installed.files });
}

const ownerRecordPath = stateDir => join(stateDir, 'owner-install.json');

export async function writeOwnerRecord(stateDir, record) {
  await atomicWriteFile(ownerRecordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readOwnerRecord(stateDir) {
  if (!await pathExists(ownerRecordPath(stateDir))) return null;
  return JSON.parse(await readRegularFile(ownerRecordPath(stateDir), { uid: 0, mode: 0o600 })
    .then(bytes => bytes.toString('utf8')));
}

