#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { releasePin, RELEASE_PIN_SECRET } from './lib/admission.mjs';
import { assertOperatorEnv, createCompose } from './lib/compose.mjs';
import { DEFAULT_CONFIG_PATH, loadConfig, parseEnvFile } from './lib/config.mjs';
import { atomicWriteFile, ensureDirectory, pathExists, readRegularFile } from './lib/fsutil.mjs';
import { createLauncherKey, loadLauncherKey } from './lib/keys.mjs';
import { installOwner, readOwnerRecord, verifyInstalledOwner, writeOwnerRecord } from './lib/owner-artifact.mjs';
import { sleep } from './lib/process.mjs';
import { installProduct, readProductRecord, writeProductRecord } from './lib/product-artifact.mjs';
import { initialState, liveLockHolder, readState, stateExists, withStateLock, writeState } from './lib/state.mjs';
import { runSupervisor, SUPERVISOR_PID_FILE } from './lib/supervisor.mjs';
import { listPublishedTeams, resolvePublishedTeam } from './lib/teams.mjs';

const USAGE = `usage: hostedctl [--config PATH] <command>
  init [--deployment-id ID]           create launcher key, state and directories (once)
  install owner <image@sha256:...> --version X.Y.Z [--no-pull]
  install product [--no-mcp]          build the Product image and extract its team-tools MCP
  up                                  run the Owner/Product pair in the foreground (systemd)
  switch-team <team_id> | --idle      restart the pair with another published team
  status                              print launcher, pair and team state as JSON
  down [--product-only]               stop the supervisor, then the Compose stack`;

const log = (event, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);

function requireRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('hostedctl-requires-linux-root');
}

function noMoreArguments(args) {
  if (args.length > 0) throw new Error(`hostedctl-unexpected-arguments:${args.join(' ')}`);
}

function takeOption(args, name, { flag = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) return flag ? false : undefined;
  const [, value] = args.splice(index, flag ? 1 : 2);
  if (!flag && (value === undefined || value.startsWith('--'))) throw new Error(`hostedctl-option-value-missing:${name}`);
  return flag ? true : value;
}

async function readProviderValues(config) {
  if (!config.providerEnvFile) return new Map();
  const bytes = await readRegularFile(config.providerEnvFile, { maxBytes: 65_536, uid: 0, mode: 0o600 });
  return parseEnvFile(bytes.toString('utf8'));
}

async function init(config, args) {
  const deploymentId = takeOption(args, '--deployment-id');
  noMoreArguments(args);
  const root = { mode: 0o700 };
  const agent = { uid: config.agent.uid, gid: config.agent.gid, mode: 0o700 };
  for (const path of [config.stateDir, config.logDir, config.secretsDir, dirname(config.launcherKeyFile)]) {
    await ensureDirectory(path, root);
  }
  await ensureDirectory(config.installRoot, { mode: 0o755 });
  await ensureDirectory(config.runDir, { mode: 0o755 });
  await ensureDirectory(config.claudeRoot, agent);
  await ensureDirectory(config.workspaceRoot, agent);
  const home = await lstat(config.agent.home);
  if (!home.isDirectory() || home.uid !== config.agent.uid) throw new Error('hostedctl-agent-home-invalid');
  const key = await pathExists(config.launcherKeyFile)
    ? await loadLauncherKey(config.launcherKeyFile) : await createLauncherKey(config.launcherKeyFile);
  const state = await withStateLock(config.stateDir, async () => {
    if (await stateExists(config.stateDir)) {
      const existing = await readState(config.stateDir);
      if (deploymentId && existing.deploymentId !== deploymentId) throw new Error('hostedctl-state-exists-with-other-deployment');
      return existing;
    }
    return writeState(config.stateDir, initialState(deploymentId ? { deploymentId } : {}));
  });
  log('initialized', { deploymentId: state.deploymentId, workspaceId: state.workspaceId,
    launcherKeyId: key.keyId });
}

async function install(config, args) {
  const kind = args.shift();
  const key = await loadLauncherKey(config.launcherKeyFile);
  if (kind === 'owner') {
    const imageReference = args.shift();
    const artifactVersion = takeOption(args, '--version');
    const pull = !takeOption(args, '--no-pull', { flag: true });
    noMoreArguments(args);
    const current = await readOwnerRecord(config.stateDir);
    const record = current?.imageReference === imageReference && current.artifactVersion === artifactVersion
      ? (await verifyInstalledOwner(current), current)
      : await installOwner({ imageReference, artifactVersion, installRoot: config.installRoot, pull });
    await writeOwnerRecord(config.stateDir, record);
    await atomicWriteFile(join(config.secretsDir, RELEASE_PIN_SECRET), releasePin(record, key),
      { uid: config.agent.uid, gid: config.agent.gid, mode: 0o400 });
    log('owner-installed', { imageReference: record.imageReference, artifactVersion: record.artifactVersion,
      executableDigest: record.executableDigest, root: record.root });
    return;
  }
  if (kind === 'product') {
    const extractMcp = !takeOption(args, '--no-mcp', { flag: true });
    noMoreArguments(args);
    const record = await installProduct({ config, state: await readState(config.stateDir), extractMcp });
    await writeProductRecord(config.stateDir, record);
    log('product-installed', { imageTag: record.imageTag, imageId: record.imageId, mcp: record.mcp });
    return;
  }
  throw new Error('hostedctl-install-kind-invalid');
}

async function up(config, args) {
  noMoreArguments(args);
  const key = await loadLauncherKey(config.launcherKeyFile);
  await assertOperatorEnv(config.composeEnvFile);
  const providerValues = await readProviderValues(config);
  return runSupervisor({ config, key, compose: createCompose(config), providerValues, log });
}

const readActive = config => readFile(join(config.runDir, 'active.json'), 'utf8').then(JSON.parse, () => null);

/** Waits for a pair newer than `afterGeneration` that serves `teamId`. */
async function waitForActiveTeam(config, { teamId, supervisorPid, afterGeneration, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await readActive(config);
    if (active?.teamId === teamId && active.supervisorPid === supervisorPid &&
        active.ownerGeneration > afterGeneration) return active;
    if (await liveLockHolder(join(config.stateDir, SUPERVISOR_PID_FILE)) !== supervisorPid) {
      throw new Error('hostedctl-supervisor-exited-during-switch');
    }
    await sleep(2_000);
  }
  throw new Error('hostedctl-switch-team-timeout');
}

async function switchTeam(config, args) {
  const idle = takeOption(args, '--idle', { flag: true });
  const teamId = idle ? undefined : args.shift();
  noMoreArguments(args);
  const next = await withStateLock(config.stateDir, async () => {
    const state = await readState(config.stateDir);
    const desiredTeam = idle ? null : await resolvePublishedTeam(config.claudeRoot, teamId,
      { deploymentId: state.deploymentId, uid: config.agent.uid, gid: config.agent.gid })
      .then(team => ({ teamId: team.teamId, legacyKey: team.legacyKey }));
    return writeState(config.stateDir, { ...state, desiredTeam, updatedAt: new Date().toISOString() });
  });
  const target = next.desiredTeam ?? next.idleTeam;
  const supervisor = await liveLockHolder(join(config.stateDir, SUPERVISOR_PID_FILE));
  if (supervisor === null) {
    log('switch-team-recorded', { teamId: target.teamId, note: 'applies on the next up' });
    return;
  }
  const afterGeneration = (await readActive(config))?.ownerGeneration ?? 0;
  process.kill(supervisor, 'SIGHUP');
  log('switch-team-requested', { teamId: target.teamId, supervisorPid: supervisor });
  const active = await waitForActiveTeam(config, { teamId: target.teamId, supervisorPid: supervisor,
    afterGeneration, timeoutMs: config.timeouts.productHealthyMs + 180_000 });
  const compose = createCompose(config);
  const deadline = Date.now() + config.timeouts.productHealthyMs;
  while (await compose.productHealth() !== 'healthy') {
    if (Date.now() > deadline) throw new Error('hostedctl-switch-team-product-not-healthy');
    await sleep(2_000);
  }
  log('switch-team-done', { teamId: active.teamId, ownerGeneration: active.ownerGeneration });
}

async function status(config, args) {
  noMoreArguments(args);
  const state = await readState(config.stateDir);
  const owner = await readOwnerRecord(config.stateDir);
  const product = await readProductRecord(config.stateDir);
  const supervisorPid = await liveLockHolder(join(config.stateDir, SUPERVISOR_PID_FILE));
  const active = supervisorPid === null ? null : await readActive(config);
  const published = await listPublishedTeams(config.claudeRoot,
    { deploymentId: state.deploymentId, uid: config.agent.uid, gid: config.agent.gid });
  const productHealth = await createCompose(config).productHealth().catch(error => `error:${error.message}`);
  const keyId = await loadLauncherKey(config.launcherKeyFile).then(key => key.keyId, () => null);
  process.stdout.write(`${JSON.stringify({
    deploymentId: state.deploymentId, workspaceId: state.workspaceId,
    ownerGeneration: state.ownerGeneration, desiredTeam: state.desiredTeam, idleTeam: state.idleTeam,
    launcherKeyId: keyId,
    owner: owner && { imageReference: owner.imageReference, artifactVersion: owner.artifactVersion,
      executableDigest: owner.executableDigest },
    product: product && { imageTag: product.imageTag, imageId: product.imageId, mcp: product.mcp },
    supervisorPid, active, productHealth, publishedTeams: published.teams, rejectedTeams: published.rejected,
  }, null, 2)}\n`);
}

async function down(config, args) {
  const productOnly = takeOption(args, '--product-only', { flag: true });
  noMoreArguments(args);
  const pidFile = join(config.stateDir, SUPERVISOR_PID_FILE);
  const supervisor = await liveLockHolder(pidFile);
  if (supervisor !== null) {
    process.kill(supervisor, 'SIGTERM');
    const deadline = Date.now() + config.timeouts.productStopSeconds * 1000 + config.timeouts.ownerStopMs + 120_000;
    while (await liveLockHolder(pidFile) === supervisor) {
      if (Date.now() > deadline) throw new Error('hostedctl-supervisor-did-not-stop');
      await sleep(1_000);
    }
  }
  const compose = createCompose(config);
  await compose.stopProduct();
  if (!productOnly) await compose.stopAll();
  log('down', { supervisorPid: supervisor, productOnly });
}

async function main(argv) {
  const args = [...argv];
  const configPath = takeOption(args, '--config') ?? process.env.HOSTEDCTL_CONFIG ?? DEFAULT_CONFIG_PATH;
  const command = args.shift();
  if (!command || command === 'help' || command === '--help') { process.stdout.write(`${USAGE}\n`); return 0; }
  requireRoot();
  const config = await loadConfig(configPath);
  const commands = { init, install, up, 'switch-team': switchTeam, status, down };
  if (!Object.hasOwn(commands, command)) throw new Error(`hostedctl-unknown-command:${command}`);
  const result = await commands[command](config, args);
  return typeof result === 'number' ? result : 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  log('failed', { reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
