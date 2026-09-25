import { randomBytes } from 'node:crypto';
import { chmod, chown, lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRootOwnedChain, atomicWriteFile, ensureDirectory, pathExists, readRegularFile,
  sha256File } from './fsutil.mjs';
import { composeArgs, composeProcessEnv, launcherComposeValues, productImageTag,
  PRODUCT_SERVICE, renderEnvFile, TRUST_INIT_SERVICE } from './compose.mjs';
import { docker as defaultDocker, run } from './process.mjs';

export const PRODUCT_INSTALL_FORMAT = 'agent-teams.hosted-launcher.product-install/v1';
/** Paths inside the Product image; see docker/Dockerfile. */
export const PRODUCT_MCP_ENTRY = '/app/mcp-server/dist/index.js';
export const PRODUCT_NODE = '/usr/local/bin/node';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

/** mcp-server engines: >=24.15.0 <25. */
export const nodeVersionSupported = text => /^v24\.(?:1[5-9]|[2-9][0-9]|[1-9][0-9]{2,})\.[0-9]+$/u.test(text);

async function imageId(tag, docker) {
  const id = await docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (!IMAGE_ID.test(id)) throw new Error('hostedctl-product-image-id-invalid');
  return id;
}

async function sealedFile(path, mode) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size === 0) {
    throw new Error(`hostedctl-mcp-file-invalid:${path}`);
  }
  await chown(path, 0, 0);
  await chmod(path, mode);
  return sha256File(path);
}

/**
 * Copies the team-tools MCP bundle and Node out of the exact Product image the stack runs, so the
 * host-local agents use the MCP that ships with this Product build and nothing from PATH.
 */
export async function extractAgentTeamsMcp({ imageId: id, installRoot, agent, docker = defaultDocker }) {
  const parent = join(installRoot, 'mcp');
  await ensureDirectory(parent, { mode: 0o755 });
  await assertRootOwnedChain(parent);
  const directory = join(parent, id.slice('sha256:'.length));
  if (await pathExists(directory)) throw new Error(`hostedctl-mcp-already-installed:${directory}`);
  const staging = join(parent, `.staging-${randomBytes(8).toString('hex')}`);
  const container = `hostedctl-mcp-${randomBytes(8).toString('hex')}`;
  await ensureDirectory(staging, { mode: 0o700 });
  try {
    await docker(['create', '--name', container, id]);
    try {
      await docker(['cp', '-L', `${container}:${PRODUCT_MCP_ENTRY}`, join(staging, 'index.js')]);
      await docker(['cp', '-L', `${container}:${PRODUCT_NODE}`, join(staging, 'node')]);
    } finally { await docker(['rm', '-f', container]).catch(() => undefined); }
    const entrySha256 = await sealedFile(join(staging, 'index.js'), 0o444);
    const commandSha256 = await sealedFile(join(staging, 'node'), 0o555);
    await chmod(staging, 0o555);
    await rename(staging, directory);
    const descriptor = Object.freeze({ command: join(directory, 'node'), commandSha256,
      entry: join(directory, 'index.js'), entrySha256 });
    await assertMcpDescriptor(descriptor, agent);
    return descriptor;
  } catch (error) {
    await chmod(staging, 0o700).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Checked again before every Owner start; the spawn helper re-checks it as root once more. */
export async function assertMcpDescriptor(descriptor, agent) {
  for (const [path, digest] of [[descriptor.command, descriptor.commandSha256],
    [descriptor.entry, descriptor.entrySha256]]) {
    await assertRootOwnedChain(path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.nlink !== 1 || await sha256File(path) !== digest) {
      throw new Error('hostedctl-mcp-digest-mismatch');
    }
  }
  const version = await run(descriptor.command, ['--version'], { uid: agent.uid, gid: agent.gid,
    env: { PATH: '/usr/bin:/bin', HOME: agent.home }, cwd: '/', timeoutMs: 10_000 });
  if (!nodeVersionSupported(version)) throw new Error(`hostedctl-mcp-node-version-unsupported:${version}`);
  return version;
}

/**
 * Builds the Product image once under a launcher-owned tag, records its content id and extracts
 * the MCP from exactly that id. `up` refuses to start a different image under the same tag.
 */
export async function installProduct({ config, state, docker = defaultDocker, extractMcp = true }) {
  const buildEnv = join(config.stateDir, 'build.env');
  await atomicWriteFile(buildEnv, renderEnvFile(launcherComposeValues(config, state)), { mode: 0o600 });
  try {
    await docker([...composeArgs(config, buildEnv), 'build', PRODUCT_SERVICE, TRUST_INIT_SERVICE],
      { env: composeProcessEnv(), cwd: config.productRepo, timeoutMs: 60 * 60_000 });
  } finally { await rm(buildEnv, { force: true }); }
  const id = await imageId(productImageTag(config), docker);
  const mcp = extractMcp ? await extractAgentTeamsMcp({ imageId: id, installRoot: config.installRoot,
    agent: config.agent, docker }) : null;
  return Object.freeze({ format: PRODUCT_INSTALL_FORMAT, imageTag: productImageTag(config),
    imageId: id, mcp, installedAt: new Date().toISOString() });
}

export async function verifyInstalledProduct(record, agent, docker = defaultDocker) {
  if (record?.format !== PRODUCT_INSTALL_FORMAT) throw new Error('hostedctl-product-install-record-invalid');
  if (await imageId(record.imageTag, docker) !== record.imageId) {
    throw new Error('hostedctl-product-image-changed');
  }
  if (record.mcp) await assertMcpDescriptor(record.mcp, agent);
  return record;
}

const recordPath = stateDir => join(stateDir, 'product-install.json');

export async function writeProductRecord(stateDir, record) {
  await atomicWriteFile(recordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readProductRecord(stateDir) {
  if (!await pathExists(recordPath(stateDir))) return null;
  return JSON.parse((await readRegularFile(recordPath(stateDir), { uid: 0, mode: 0o600 })).toString('utf8'));
}
