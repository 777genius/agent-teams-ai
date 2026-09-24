import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chown, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u;
const LAUNCHER = /^hostedActualOwnerLauncher-([0-9a-f]{64})$/u;
export const EXACT_OWNER_COMMIT = '7d48dd74ab36c375f9735fad751278d0e818ea69';

function requireLinuxRoot() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() !== 0) {
    throw new Error('core-issuer-oci-requires-linux-x64-root');
  }
}

function pinnedImage(value, label) {
  if (typeof value !== 'string' || !PINNED_IMAGE.test(value)) {
    throw new Error(`core-issuer-${label}-must-be-pinned-by-digest`);
  }
  return value;
}

function safeBuildRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || resolve(value) !== value || value.includes('/../')) {
    throw new Error('core-issuer-owner-repo-invalid');
  }
  return value;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function regularFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size === 0) {
    throw new Error('core-issuer-artifact-is-not-regular-file');
  }
  return entry;
}

async function inspectClosure(root) {
  const cli = join(root, 'cli');
  const bundle = join(root, 'dist', 'local-cli');
  const bundleStat = await lstat(bundle);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
    throw new Error('core-issuer-bundle-directory-invalid');
  }
  await regularFile(cli);
  await regularFile(join(bundle, 'cli.js'));
  const candidates = (await readdir(bundle)).filter(name => LAUNCHER.test(name));
  if (candidates.length !== 1) throw new Error('core-issuer-content-addressed-launcher-ambiguous');
  const launcher = candidates[0];
  const digest = LAUNCHER.exec(launcher)[1];
  await regularFile(join(bundle, launcher));
  if (await sha256(join(bundle, launcher)) !== digest) {
    throw new Error('core-issuer-content-addressed-launcher-digest-mismatch');
  }
  return { cli, bundle, launcher, executableDigest: `sha256:${digest}` };
}

async function copyClosure(source, bunPath, context) {
  await mkdir(join(context, 'dist', 'local-cli'), { recursive: true, mode: 0o700 });
  await mkdir(join(context, 'bin'), { mode: 0o700 });
  await copyFile(bunPath, join(context, 'bin', 'bun'), constants.COPYFILE_EXCL);
  await copyFile(source.cli, join(context, 'cli'), constants.COPYFILE_EXCL);
  for (const name of ['cli.js', source.launcher]) {
    await copyFile(join(source.bundle, name), join(context, 'dist', 'local-cli', name), constants.COPYFILE_EXCL);
  }
  await chmod(join(context, 'cli'), 0o555);
  await chmod(join(context, 'bin', 'bun'), 0o555);
  await chmod(join(context, 'dist', 'local-cli', source.launcher), 0o555);
  await chmod(join(context, 'dist', 'local-cli', 'cli.js'), 0o444);
}

async function assertExtractedTree(root) {
  async function exactEntries(path, expected) {
    const actual = (await readdir(path)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error('core-issuer-extracted-image-inventory-invalid');
    }
  }
  await exactEntries(root, ['bin', 'cli', 'dist']);
  await exactEntries(join(root, 'bin'), ['bun']);
  await exactEntries(join(root, 'dist'), ['local-cli']);
  const bundle = join(root, 'dist', 'local-cli');
  const launcher = (await readdir(bundle)).find(name => LAUNCHER.test(name));
  if (!launcher) throw new Error('core-issuer-extracted-image-launcher-missing');
  await exactEntries(bundle, ['cli.js', launcher]);
  async function visit(path) {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || entry.uid !== 0 || entry.gid !== 0) {
      throw new Error('core-issuer-extracted-image-identity-invalid');
    }
    if (entry.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      await chmod(path, 0o555);
    } else {
      if (entry.nlink !== 1) throw new Error('core-issuer-extracted-image-hardlink-invalid');
      await chmod(path, path.endsWith('/cli') || path.endsWith('/bin/bun') ||
        LAUNCHER.test(path.split('/').at(-1)) ? 0o555 : 0o444);
    }
  }
  await visit(root);
}

export function commandRunner(command, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      uid: options.uid, gid: options.gid,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const add = (parts, bytes) => {
      size += bytes.length;
      if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
      else parts.push(bytes);
    };
    child.stdout.on('data', bytes => add(out, bytes));
    child.stderr.on('data', bytes => add(err, bytes));
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20 * 60_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(Buffer.concat(out).toString('utf8').trim());
      else reject(new Error(`core-issuer-command-failed:${command}:${args[0]}:${code}:${Buffer.concat(err).toString('utf8').slice(0, 512)}`));
    });
  });
}

function registryPort(value) {
  const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):([1-9][0-9]{0,4})\s*$/u.exec(value);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port > 65535) throw new Error('core-issuer-registry-port-invalid');
  return port;
}

function repoDigest(ref, inspected) {
  let refs;
  try { refs = JSON.parse(inspected); } catch { throw new Error('core-issuer-repo-digest-invalid'); }
  const canonical = value => {
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
  };
  if (!Array.isArray(refs) || !refs.some(candidate => canonical(candidate) === canonical(ref))) {
    throw new Error('core-issuer-repo-digest-mismatch');
  }
}

/**
 * Test-owned OCI provenance. The registry and extraction container are named
 * with a fresh random token; cleanup addresses those names only. Call close()
 * after terminating the owner process. No digest is synthesized from a file.
 */
export async function prepareOwnerImage({ ownerRepo, ownerCommit, registryImage, baseImage, command = commandRunner }) {
  requireLinuxRoot();
  safeBuildRoot(ownerRepo);
  if (ownerCommit !== EXACT_OWNER_COMMIT) {
    throw new Error('core-issuer-exact-owner-commit-mismatch');
  }
  pinnedImage(registryImage, 'registry-image');
  pinnedImage(baseImage, 'base-image');
  if (!/^registry:2@sha256:[0-9a-f]{64}$/u.test(registryImage)) {
    throw new Error('core-issuer-registry-v2-pin-required');
  }
  const nonce = randomBytes(12).toString('hex');
  const root = await mkdtemp('/tmp/hosted-core-issuer-');
  await chmod(root, 0o711);
  const registry = `core-issuer-registry-${nonce}`;
  const extracted = `core-issuer-extract-${nonce}`;
  const base = `core-issuer-base-${nonce}`;
  let tag;
  let imageReference;
  let registryStarted = false;
  let extractCreated = false;
  let baseCreated = false;
  let closed = false;
  const docker = (...args) => command('docker', args);
  const close = async () => {
    if (closed) return;
    closed = true;
    if (extractCreated) await docker('rm', '-f', extracted).catch(() => undefined);
    if (baseCreated) await docker('rm', '-f', base).catch(() => undefined);
    if (registryStarted) await docker('rm', '-f', registry).catch(() => undefined);
    if (imageReference) await docker('image', 'rm', imageReference).catch(() => undefined);
    if (tag) await docker('image', 'rm', tag).catch(() => undefined);
    // Remove only the unique directory created above. Refuse substitution.
    const entry = await lstat(root).catch(() => null);
    if (entry?.isDirectory() && !entry.isSymbolicLink() && root.startsWith('/tmp/hosted-core-issuer-')) {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: false });
    }
  };
  try {
    await docker('pull', registryImage);
    await docker('pull', baseImage);
    repoDigest(registryImage, await docker('image', 'inspect', '--format', '{{json .RepoDigests}}', registryImage));
    repoDigest(baseImage, await docker('image', 'inspect', '--format', '{{json .RepoDigests}}', baseImage));
    const repoOwner = await stat(ownerRepo);
    if (!repoOwner.isDirectory() || await realpath(ownerRepo) !== ownerRepo) {
      throw new Error('core-issuer-owner-repo-invalid');
    }
    const gitOptions = { cwd: ownerRepo, uid: repoOwner.uid, gid: repoOwner.gid,
      env: { HOME: ownerRepo, PATH: '/usr/local/bin:/usr/bin:/bin' } };
    const selectedCommit = await command('git', ['rev-parse', 'HEAD'], gitOptions);
    const dirty = await command('git', ['status', '--porcelain', '--untracked-files=all'], gitOptions);
    if (selectedCommit !== ownerCommit || dirty !== '') {
      throw new Error('core-issuer-owner-commit-or-worktree-mismatch');
    }
    const packageJson = JSON.parse(await readFile(join(ownerRepo, 'package.json'), 'utf8'));
    const expectedBunVersion = /^bun@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(packageJson.packageManager)?.[1];
    if (!expectedBunVersion || !baseImage.startsWith(`oven/bun:${expectedBunVersion}@sha256:`)) {
      throw new Error('core-issuer-base-bun-version-mismatch');
    }
    await docker('create', '--name', base, baseImage);
    baseCreated = true;
    const buildBin = join(root, 'build-bin');
    await mkdir(buildBin, { mode: 0o755 });
    const bunPath = join(buildBin, 'bun');
    await docker('cp', '-L', `${base}:/usr/local/bin/bun`, bunPath);
    await regularFile(bunPath);
    await chmod(bunPath, 0o555);
    const observedBunVersion = await command(bunPath, ['--version'], {
      uid: repoOwner.uid, gid: repoOwner.gid, timeoutMs: 10_000,
    });
    if (observedBunVersion !== expectedBunVersion) throw new Error('core-issuer-base-bun-binary-version-mismatch');
    const buildHome = join(root, 'build-home');
    await mkdir(buildHome, { mode: 0o700 });
    await chown(buildHome, repoOwner.uid, repoOwner.gid);
    const buildOptions = { cwd: ownerRepo, uid: repoOwner.uid, gid: repoOwner.gid,
      env: { HOME: buildHome, PATH: `${buildBin}:/usr/local/bin:/usr/bin:/bin`, CI: '1' } };
    await command(bunPath, ['install', '--frozen-lockfile'], buildOptions);
    await command(bunPath, ['run', 'build'], buildOptions);
    const postBuildStatus = await command('git', ['status', '--porcelain', '--untracked-files=all'], gitOptions);
    if (postBuildStatus !== '?? bin/hosted-actual-owner-acceptance') {
      throw new Error('core-issuer-owner-worktree-mutated-by-build');
    }
    const generated = join(ownerRepo, 'bin', 'hosted-actual-owner-acceptance');
    const generatedDir = await lstat(join(ownerRepo, 'bin'));
    const generatedFile = await regularFile(generated);
    if (!generatedDir.isDirectory() || generatedDir.isSymbolicLink() ||
        generatedDir.uid !== repoOwner.uid || generatedDir.gid !== repoOwner.gid ||
        generatedFile.uid !== repoOwner.uid || generatedFile.gid !== repoOwner.gid) {
      throw new Error('core-issuer-owner-generated-artifact-invalid');
    }
    const generatedArtifact = Object.freeze({ path: 'bin/hosted-actual-owner-acceptance',
      sha256: await sha256(generated), size: generatedFile.size });
    const source = await inspectClosure(ownerRepo);
    const context = join(root, 'context');
    await mkdir(context, { mode: 0o700 });
    await copyClosure(source, bunPath, context);
    await writeFile(join(context, 'Dockerfile'),
      `FROM ${baseImage}\nUSER root\nWORKDIR /opt/owner\nCOPY --chown=0:0 bin ./bin\nCOPY --chown=0:0 cli ./cli\nCOPY --chown=0:0 dist ./dist\nRUN chmod 0555 /opt/owner /opt/owner/bin /opt/owner/bin/bun /opt/owner/dist /opt/owner/dist/local-cli /opt/owner/cli /opt/owner/dist/local-cli/${source.launcher}\nUSER 1000:1000\nENTRYPOINT ["/opt/owner/cli"]\n`,
      { mode: 0o600 });
    await docker('run', '-d', '--name', registry, '-p', '127.0.0.1::5000', registryImage);
    registryStarted = true;
    const port = registryPort(await docker('port', registry, '5000/tcp'));
    tag = `127.0.0.1:${port}/core-owner:${nonce}`;
    await docker('build', '--pull=false', '--no-cache', '-t', tag, context);
    await docker('push', tag);
    const refs = await docker('image', 'inspect', '--format', '{{json .RepoDigests}}', tag);
    let digests;
    try { digests = JSON.parse(refs); } catch { throw new Error('core-issuer-pushed-digest-invalid'); }
    const matches = digests.filter(value => typeof value === 'string' && value.startsWith(`${tag.slice(0, tag.lastIndexOf(':'))}@sha256:`));
    if (matches.length !== 1 || !PINNED_IMAGE.test(matches[0])) throw new Error('core-issuer-pushed-digest-ambiguous');
    imageReference = matches[0];
    await docker('pull', imageReference);
    repoDigest(imageReference, await docker('image', 'inspect', '--format', '{{json .RepoDigests}}', imageReference));
    const entrypoint = await docker('image', 'inspect', '--format', '{{json .Config.Entrypoint}}', imageReference);
    const user = await docker('image', 'inspect', '--format', '{{.Config.User}}', imageReference);
    if (entrypoint !== '["/opt/owner/cli"]' || user !== '1000:1000') {
      throw new Error('core-issuer-image-runtime-config-invalid');
    }
    await docker('create', '--name', extracted, imageReference);
    extractCreated = true;
    const imageRoot = join(root, 'image');
    await mkdir(imageRoot, { mode: 0o700 });
    await docker('cp', `${extracted}:/opt/owner/.`, imageRoot);
    const actual = await inspectClosure(imageRoot);
    if (actual.executableDigest !== source.executableDigest ||
      await sha256(join(imageRoot, 'bin', 'bun')) !== await sha256(bunPath) ||
      await sha256(actual.cli) !== await sha256(source.cli) ||
      await sha256(join(actual.bundle, 'cli.js')) !== await sha256(join(source.bundle, 'cli.js'))) {
      throw new Error('core-issuer-extracted-owner-closure-mismatch');
    }
    await assertExtractedTree(imageRoot);
    const imageDigest = imageReference.slice(imageReference.lastIndexOf('@') + 1);
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest) || imageDigest === actual.executableDigest) {
      throw new Error('core-issuer-image-executable-digests-invalid');
    }
    return Object.freeze({ root, imageRoot, imageReference, ownerCommit, generatedArtifact,
      ownerArtifactDigest: imageDigest,
      ownerExecutableDigest: actual.executableDigest, cli: actual.cli, bun: join(imageRoot, 'bin', 'bun'),
      cliSha256: await sha256(actual.cli), bunSha256: await sha256(join(imageRoot, 'bin', 'bun')),
      launcher: join(actual.bundle, actual.launcher), close });
  } catch (error) {
    await close();
    throw error;
  }
}
