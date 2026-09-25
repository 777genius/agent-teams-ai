import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionIdentity, launcherLease, ownerHeader, publishAdmission } from './admission.mjs';
import { launcherComposeValues, writeSessionEnv } from './compose.mjs';
import { atomicWriteFile, ensureDirectory } from './fsutil.mjs';
import { readOwnerRecord, verifyInstalledOwner } from './owner-artifact.mjs';
import { spawnOwner, waitForOwnerSocket, waitForPathRemoval } from './owner-process.mjs';
import { readProductRecord, verifyInstalledProduct } from './product-artifact.mjs';
import { assertNativeProviders } from './native-providers.mjs';
import { activeTeam, allocateSession, readState, withStateLock, writeState } from './state.mjs';
import { readPublishedTeam } from './teams.mjs';

export const SOCKET_NAME = 'orchestrator-lifecycle.sock';
// The Claude Code OAuth token is not an env value: Owner reads it from nativeProviders.anthropic.
const PUBLIC_ENV_FROM_PROVIDER_FILE = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

/**
 * Owner's whole environment. Nothing is inherited: OpenCode profiles copy Owner's process.env, so
 * anything present here reaches every agent. Provider credentials come only from the root-only
 * provider env file; Codex and OpenCode logins live in the agent's own HOME.
 */
export function ownerEnvironment(config, installedRoot, providerValues = new Map(),
  opencodeConfigContent = null) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: config.agent.home, USER: config.agent.user,
    LOGNAME: config.agent.user, LANG: 'C.UTF-8', BUN_INSTALL: installedRoot, NODE_ENV: 'production',
  };
  if (config.agent.runtimeDir) {
    // Owner-managed OpenCode state (profiles, session store, host registry, locks) and temp files
    // live here instead of under HOME, so several Owners (or a desktop app) sharing one agent
    // HOME do not contend. Provider logins are still read from HOME and never copied by us.
    env.CLAUDE_MULTIMODEL_DATA_HOME = `${config.agent.runtimeDir}/data`;
    env.CLAUDE_MULTIMODEL_CACHE_HOME = `${config.agent.runtimeDir}/cache`;
    env.TMPDIR = `${config.agent.runtimeDir}/tmp`;
  }
  if (config.opencode) {
    env.HOSTED_OPENCODE_RUNTIME_MODE = config.opencode.runtimeMode;
    if (config.opencode.binaryPath) env.HOSTED_OPENCODE_BIN_PATH = config.opencode.binaryPath;
    if (opencodeConfigContent) env.OPENCODE_CONFIG_CONTENT = opencodeConfigContent;
  }
  for (const [key, value] of providerValues) {
    if (!PUBLIC_ENV_FROM_PROVIDER_FILE.has(key)) throw new Error(`hostedctl-provider-env-key-not-allowed:${key}`);
    env[key] = value;
  }
  return env;
}

async function prepareTeamDirectories(config, team) {
  const agent = { uid: config.agent.uid, gid: config.agent.gid, mode: 0o700 };
  for (const kind of ['teams', 'tasks']) {
    await ensureDirectory(join(config.claudeRoot, kind), agent);
    await ensureDirectory(join(config.claudeRoot, kind, team.legacyKey), agent);
  }
}

async function selectTeam(config, state) {
  const team = activeTeam(state);
  if (state.desiredTeam) {
    // A published team is only trusted while Product's publication marker still names it.
    const published = await readPublishedTeam(config.claudeRoot, team.legacyKey,
      { deploymentId: state.deploymentId, uid: config.agent.uid, gid: config.agent.gid });
    if (published.teamId !== team.teamId) throw new Error('hostedctl-desired-team-changed');
  }
  await prepareTeamDirectories(config, team);
  return team;
}

/**
 * One Owner generation plus the Product container bound to it. Product is always stopped before
 * a new Owner exists, and each generation is persisted before any process sees it.
 */
export async function startPair({ config, key, compose, providerValues, opencodeConfigContent, log,
  spawn = spawnOwner }) {
  const installed = await readOwnerRecord(config.stateDir);
  if (!installed) throw new Error('hostedctl-owner-not-installed');
  const files = await verifyInstalledOwner(installed);
  const product = await readProductRecord(config.stateDir);
  if (!product) throw new Error('hostedctl-product-not-installed');
  await verifyInstalledProduct(product, config.agent);

  await compose.stopProduct();
  const state = await withStateLock(config.stateDir, async () =>
    writeState(config.stateDir, allocateSession(await readState(config.stateDir))));
  const team = await selectTeam(config, state);
  if (config.agent.runtimeDir) {
    const agentDir = { uid: config.agent.uid, gid: config.agent.gid, mode: 0o700 };
    for (const path of ['', '/data', '/cache', '/tmp']) await ensureDirectory(`${config.agent.runtimeDir}${path}`, agentDir);
  }
  // /run is empty after a reboot; the agent must be able to traverse to its socket directory.
  await ensureDirectory(config.runDir, { mode: 0o755 });
  await ensureDirectory(config.logDir, { mode: 0o700 });
  const runDirectory = join(config.runDir, `owner-g${state.ownerGeneration}`);
  await rm(runDirectory, { recursive: true, force: true });
  await ensureDirectory(runDirectory, { uid: config.agent.uid, gid: config.agent.gid, mode: 0o700 });
  const socketPath = join(runDirectory, SOCKET_NAME);
  const identity = createSessionIdentity({ state, team, installed, workspaceRoot: config.workspaceRoot });
  log('owner-starting', { ownerGeneration: state.ownerGeneration, teamId: team.teamId,
    legacyKey: team.legacyKey, bootId: identity.bootId });
  let owner;
  try {
    owner = await spawn({
      ownerRoot: installed.root,
      files: { cli: [files.cli, files.sha256.cli], bun: [files.bun, files.sha256['bin/bun']],
        cliJs: [files.cliJs, files.sha256['dist/local-cli/cli.js']],
        launcher: [files.launcher, installed.executableDigest.slice('sha256:'.length)] },
      uid: config.agent.uid, gid: config.agent.gid, home: config.agent.home,
      env: ownerEnvironment(config, installed.root, providerValues, opencodeConfigContent),
      appMcp: product.mcp ?? null,
      nativeProviders: await assertNativeProviders(config.nativeProviders,
        { uid: config.agent.uid, claudeRoot: config.claudeRoot }),
      lease: launcherLease(identity, installed),
      header: ownerHeader(identity, { claudeRoot: config.claudeRoot, socketPath }),
      secret: identity.secret.toString('hex'),
      logPath: join(config.logDir, `owner-g${state.ownerGeneration}.log`),
      stopGraceSeconds: Math.ceil(config.timeouts.ownerStopMs / 1000),
    });
    const session = { owner, runDirectory, socketPath, ownerGeneration: state.ownerGeneration, team,
      bootId: identity.bootId };
    try {
      await waitForOwnerSocket(socketPath, { uid: config.agent.uid, gid: config.agent.gid, owner,
        timeoutMs: config.timeouts.ownerSocketMs });
      await publishAdmission({ identity, installed, key, runDirectory, socketPath,
        secretsDir: config.secretsDir, uid: config.agent.uid, gid: config.agent.gid });
      await writeSessionEnv(config, launcherComposeValues(config, state,
        { runDirectory, bootstrap: identity.bootstrap }));
      await writeActive(config, session);
      log('product-starting', { ownerGeneration: state.ownerGeneration });
      await compose.startProduct();
      log('pair-ready', { ownerGeneration: state.ownerGeneration, teamId: team.teamId });
      return session;
    } catch (error) {
      await stopPair({ compose, session, log }).catch(stopError =>
        log('stop-after-start-failure-failed', { reason: stopError.message }));
      throw error;
    }
  } finally {
    identity.secret.fill(0);
  }
}

/**
 * Product first, then the liveness lease. Revoking Owner while Product still runs would let
 * Product observe owner loss mid-request; the reverse order is the E2E rotation contract.
 */
export async function stopPair({ compose, session, log }) {
  let productError = null;
  try { await compose.stopProduct(); }
  catch (error) { productError = error; log('product-stop-failed', { reason: error.message }); }
  const exit = await session.owner.close();
  log('owner-stopped', { ownerGeneration: session.ownerGeneration, ...exit });
  if (!await waitForPathRemoval(session.socketPath)) log('owner-socket-left-behind', { path: session.socketPath });
  await rm(session.runDirectory, { recursive: true, force: true });
  if (productError) throw productError;
}

async function writeActive(config, session) {
  await atomicWriteFile(join(config.runDir, 'active.json'), `${JSON.stringify({
    ownerGeneration: session.ownerGeneration, teamId: session.team.teamId,
    legacyKey: session.team.legacyKey, bootId: session.bootId, ownerPid: session.owner.pid,
    helperPid: session.owner.helperPid, supervisorPid: process.pid, startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}
