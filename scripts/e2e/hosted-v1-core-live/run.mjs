#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm,
  writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { freemem, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConfiguredTeam, exerciseTeam, openProductBrowser,
  selectGrantedWorkspace } from './browser.mjs';
import { composeProjectName, CORE_LIVE_PRODUCT_SERVICE, writeSandboxCompose } from './compose.mjs';
import { captureSourceManifest } from './source-evidence.mjs';
import { startCoreSandbox } from '../hosted-v1-core-issuer/run.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const productionCompose = join(repo, 'docker', 'docker-compose.yml');
const providerEvidenceScript = join(repo, 'scripts', 'e2e', 'hosted-v1-core-live',
  'provider-evidence.ts');
const digest = /^sha256:[0-9a-f]{64}$/;
const pinned = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const MODEL = 'local-llama/qwen3-8b';
const OPENCODE_SHA256 = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080';
const EVIDENCE_BASE = '/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1/operator-evidence/core-live-20260924';
const HOST_PORT_BANDS = Object.freeze([[20_000, 29_999], [61_000, 65_000]]);
const DOCKER_HOST_PORT_BIND_FAILURE =
  /failed to bind host port (?:0\.0\.0\.0|\[::\]):\d+\/tcp: address already in use|bind for (?:0\.0\.0\.0|\[::\]):\d+ failed: port is already allocated/i;
const EVIDENCE_DIRECTORY_POLICY = Object.freeze([
  ['/', 0, 0, 0o755],
  ['/srv', 0, 0, 0o755],
  ['/srv/worker-state', 0, 987, 0o751],
  ['/srv/worker-state/jobs', 999, 987, 0o2771],
  ['/srv/worker-state/jobs/agent-teams-ai', 999, 987, 0o2771],
  ['/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1', 999, 987, 0o2771],
  ['/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1/operator-evidence', 0, 987, 0o2755],
  [EVIDENCE_BASE, 0, 0, 0o700],
]);

async function evidenceBaseCustody() {
  const custody = [];
  for (const [path, uid, gid, mode] of EVIDENCE_DIRECTORY_POLICY) {
    const stat = await lstat(path, { bigint: true }).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid) ||
        stat.gid !== BigInt(gid) || (stat.mode & 0o7777n) !== BigInt(mode) ||
        await realpath(path) !== path) {
      throw new Error('core-live-evidence-base-custody-invalid');
    }
    custody.push({ path, uid, gid, mode, device: stat.dev.toString(), inode: stat.ino.toString() });
  }
  return custody;
}

async function assertEvidenceBaseCustody(expected) {
  if (JSON.stringify(await evidenceBaseCustody()) !== JSON.stringify(expected)) {
    throw new Error('core-live-evidence-base-replaced');
  }
}

function ownerRuntimeAttestation(sandbox) {
  const value = sandbox.ownerRuntimeAttestation;
  if (value?.bunEnvironmentVerified !== true ||
      value.officialOpenCodeSha256 !== OPENCODE_SHA256 ||
      value.providerConfigSha256 !== sandbox.localProvider?.digest || value.model !== MODEL) {
    throw new Error('core-live-owner-bun-runtime-attestation-missing');
  }
  return value;
}

async function command(bin, args, options = {}) {
  try {
    const { stdout } = await exec(bin, args, {
      cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    // Do not leak pairing codes, bootstrap material or provider output in errors.
    throw new Error(`core-live-command-failed:${bin}:${args[0]}:${error.code ?? 'unknown'}`);
  }
}

async function requiredFile(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path ||
      await realpath(path).catch(() => null) !== path) {
    throw new Error(`core-live-${label}-absolute-realpath-required`);
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`core-live-${label}-regular-file-required`);
  }
  return path;
}

async function preflight(environment) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() !== 0) {
    throw new Error('core-live-requires-linux-x64-root-docker-host');
  }
  const ownerRepo = environment.CORE_LIVE_OWNER_REPO;
  if (environment.CORE_LIVE_EVIDENCE_DIR !== EVIDENCE_BASE) {
    throw new Error('core-live-durable-evidence-directory-required');
  }
  const evidenceCustody = await evidenceBaseCustody();
  if (typeof ownerRepo !== 'string' || !ownerRepo.startsWith('/') ||
      await realpath(ownerRepo).catch(() => null) !== ownerRepo) {
    throw new Error('core-live-owner-repo-absolute-realpath-required');
  }
  const ownerCommit = environment.CORE_LIVE_OWNER_COMMIT;
  if (!/^[0-9a-f]{40}$/.test(ownerCommit ?? '')) {
    throw new Error('core-live-exact-owner-commit-required');
  }
  const registryImage = environment.CORE_LIVE_REGISTRY_IMAGE;
  const baseImage = environment.CORE_LIVE_BUN_IMAGE;
  if (!pinned.test(registryImage ?? '') || !pinned.test(baseImage ?? '')) {
    throw new Error('core-live-owner-images-must-be-digest-pinned');
  }
  const openCodeBinaryPath = await requiredFile(environment.CORE_LIVE_OPENCODE_BINARY,
    'official-opencode-binary');
  for (const key of ['NODE_IMAGE_DIGEST', 'KEYCLOAK_IMAGE_DIGEST',
    'CADDY_IMAGE_DIGEST', 'POSTGRES_IMAGE_DIGEST']) {
    if (!digest.test(environment[key] ?? '')) throw new Error(`core-live-${key}-required`);
  }
  if (environment.CORE_LIVE_MODEL !== undefined && environment.CORE_LIVE_MODEL !== MODEL) {
    throw new Error('core-live-model-must-be-local-llama-qwen3-8b');
  }
  const baseUrl = environment.CORE_LIVE_LOCAL_PROVIDER_BASE_URL;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(baseUrl ?? '')) {
    throw new Error('core-live-test-only-local-provider-required');
  }
  const models = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) })
    .then(response => response.ok ? response.json() : null).catch(() => null);
  if (!models?.data?.some(item => item.id === 'qwen3-8b')) {
    throw new Error('core-live-local-provider-model-unavailable');
  }
  await command('docker', ['compose', 'version']);
  return { ownerRepo, ownerCommit, registryImage, baseImage, openCodeBinaryPath,
    evidenceDirectory: EVIDENCE_BASE, evidenceCustody,
    localProviderBaseUrl: baseUrl };
}

async function hostEphemeralPortRange() {
  const value = await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');
  const match = /^(\d+)\s+(\d+)\s*$/.exec(value);
  if (!match) throw new Error('core-live-host-ephemeral-port-range-invalid');
  const range = [Number(match[1]), Number(match[2])];
  if (!Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) ||
      range[0] < 1_024 || range[0] > range[1] || range[1] > 65_535) {
    throw new Error('core-live-host-ephemeral-port-range-invalid');
  }
  return range;
}

function canBindHostPort(port, host, ipv6Only = false) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, ipv6Only, exclusive: true }, () =>
      server.close(() => resolve(true)));
  });
}

async function isHostPortAvailable(port) {
  return await canBindHostPort(port, '0.0.0.0') &&
    await canBindHostPort(port, '::', true);
}

export async function allocateCoreLivePorts({
  ephemeralRange = null,
  isPortAvailable = isHostPortAvailable,
  randomIndex = limit => randomBytes(4).readUInt32BE() % limit,
} = {}) {
  const range = ephemeralRange ?? await hostEphemeralPortRange();
  if (!Array.isArray(range) || range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < 1_024 || range[0] > range[1] ||
      range[1] > 65_535) {
    throw new Error('core-live-host-ephemeral-port-range-invalid');
  }
  const candidates = HOST_PORT_BANDS.flatMap(([start, end]) =>
    Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
    .filter(port => port < range[0] || port > range[1]);
  if (candidates.length < 2) throw new Error('core-live-safe-host-port-band-unavailable');
  const chosen = [];
  const checked = new Set();
  for (let attempt = 0; attempt < 128 && chosen.length < 2; attempt += 1) {
    const index = randomIndex(candidates.length);
    if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) {
      throw new Error('core-live-host-port-random-index-invalid');
    }
    const port = candidates[index];
    if (checked.has(port)) continue;
    checked.add(port);
    if (await isPortAvailable(port)) chosen.push(port);
  }
  if (chosen.length !== 2) throw new Error('core-live-safe-host-ports-unavailable');
  return Object.freeze(chosen);
}

function composeEnvironment(source, sandbox, name, httpsPort, redirectPort) {
  const domain = `${name}.localhost`;
  return {
    ...source,
    COMPOSE_PROJECT_NAME: name,
    COMPOSE_PROFILES: 'personal',
    CLAUDE_DIR: sandbox.claudeRoot,
    HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR: sandbox.runDirectory,
    AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP:
      sandbox.productEnvironment.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP,
    HOSTED_SECRETS_DIR: sandbox.trustDirectory,
    HOSTED_DOMAIN: domain,
    HOSTED_PUBLIC_ORIGIN: `https://${domain}:${httpsPort}`,
    HOSTED_HTTPS_PORT: String(httpsPort),
    HOSTED_REDIRECT_PORT: String(redirectPort),
    HOSTED_OPENCODE_RUNTIME_MODE: 'official-v1.18.32',
  };
}

async function renderProduction(sandbox, name, runRoot, environment, phase) {
  const rendered = JSON.parse(await command('docker', [
    'compose', '-f', productionCompose, '--profile', 'personal', 'config', '--format', 'json',
  ], { env: environment, timeoutMs: 60_000 }));
  const path = join(runRoot, `production-${phase}.json`);
  const selected = await writeSandboxCompose(path, rendered, sandbox, name);
  return { path, selected };
}

async function compose(args, file, environment, timeoutMs = 60_000) {
  return command('docker', ['compose', '-f', file, ...args], { env: environment, timeoutMs });
}

const COMPOSE_FAILURE_CODES = Object.freeze([
  ['hosted-state-metadata-invalid', /hosted-state-startup-refused:state_metadata_invalid|hosted_state_header_missing_from_unproven_state/i],
  ['hosted-state-artifact-invalid', /hosted-state-startup-refused:artifact_manifest_(?:invalid|integrity_failed)/i],
  ['caddy-data-permission-denied', /(?:mkdir|open|write)\s+\/data\/caddy\/pki(?:\/[^\s:]*)?: permission denied/i],
  ['opencode-runtime-unavailable', /(?:error|failed|refused):?\s+(?:hosted_opencode_[a-z_]+|(?:install|download|verify)\s+(?:official\s+)?opencode\b[^\n]{0,100}(?:failed|checksum mismatch))/i],
  ['owner-admission-rejected', /lifecycle.owner.admission|owner.admission|trust.anchor|bootstrap.binding/i],
  ['bind-mount-failed', /invalid mount config|bind source path does not exist|not a directory.*mount/i],
  ['port-unavailable', /port is already allocated|bind: address already in use/i],
  ['network-failed', /failed to create network|pool overlaps|address already in use.*network/i],
  ['image-build-failed', /failed to solve|failed to build|buildx build failed/i],
  ['container-unhealthy', /container .* is unhealthy|dependency failed to start/i],
]);
const PRODUCT_READINESS_STAGES = new Set(['startup_before_http', 'lifecycle_composition',
  'socket_inspection', 'signed_handshake', 'high_water_admission', 'owner_acquisition',
  'owner_loss']);
const PRODUCT_READINESS_OUTCOMES = new Set(['started', 'succeeded', 'failed', 'skipped']);
const PRODUCT_READINESS_CODES = new Set(['none', 'unavailable', 'composition_created',
  'socket_not_found', 'socket_access_denied', 'connection_refused', 'handshake_timeout',
  'acquisition_rejected', 'high_water_rejected', 'owner_connection_lost']);
const PRODUCT_READINESS_PROBE = `const finish=value=>process.stdout.write(JSON.stringify(value));
fetch('http://127.0.0.1:3456/api/auth/status',{signal:AbortSignal.timeout(3000),redirect:'error'})
  .then(response=>{const status=response.status;
    const readinessHeaderReady=response.headers.get('x-agent-teams-lifecycle-owner-readiness')==='ready';
    void response.body?.cancel().catch(()=>{});
    finish({status,readinessHeaderReady,transport:'ok'});
  }).catch(error=>finish({status:null,readinessHeaderReady:false,
    transport:error?.name==='TimeoutError'?'timeout':'error'}));`;

export function parseProductReadinessProbe(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return { probe: 'invalid-output' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (value.status !== null && (!Number.isInteger(value.status) ||
        value.status < 100 || value.status > 599)) ||
      typeof value.readinessHeaderReady !== 'boolean' ||
      !['ok', 'timeout', 'error'].includes(value.transport) ||
      (value.transport === 'ok') !== (value.status !== null) ||
      (value.transport !== 'ok' && value.readinessHeaderReady)) {
    return { probe: 'invalid-output' };
  }
  return { probe: value.transport, httpStatus: value.status,
    readinessHeaderReady: value.readinessHeaderReady };
}

export function classifyProductReadinessDiagnostic(logs) {
  if (typeof logs !== 'string') return null;
  let last = null;
  let lastFailure = null;
  for (const line of logs.slice(-128 * 1024).split('\n').slice(-200)) {
    const match = /Hosted readiness diagnostic stage=([a-z_]+) outcome=([a-z_]+) code=([a-z_]+)/
      .exec(line);
    if (match && PRODUCT_READINESS_STAGES.has(match[1]) &&
        PRODUCT_READINESS_OUTCOMES.has(match[2]) && PRODUCT_READINESS_CODES.has(match[3])) {
      const diagnostic = { stage: match[1], outcome: match[2], code: match[3] };
      if (diagnostic.outcome === 'failed') lastFailure = diagnostic;
      last = diagnostic;
    }
  }
  return lastFailure ?? last;
}

async function productReadinessProbe(containerName) {
  try {
    const { stdout } = await exec('docker', ['exec', containerName, 'node', '-e',
      PRODUCT_READINESS_PROBE], { timeout: 6_000, maxBuffer: 4 * 1024 });
    return parseProductReadinessProbe(stdout.trim());
  } catch {
    return { probe: 'exec-failed' };
  }
}

export function classifyComposeFailure({ containerOutputs = [], composeOutputs = [],
  daemonOutputs = [] }) {
  // Container diagnostics outrank build output. Classify each bounded tail separately
  // so a benign build mention cannot mask the actual startup failure.
  if (daemonOutputs.some(value =>
    typeof value === 'string' && DOCKER_HOST_PORT_BIND_FAILURE.test(value.slice(-128 * 1024)))) {
    return 'port-unavailable';
  }
  for (const outputs of [containerOutputs, composeOutputs]) {
    for (const value of outputs.filter(value => typeof value === 'string').slice(-16)) {
      const tail = value.slice(-128 * 1024);
      const match = COMPOSE_FAILURE_CODES.find(([, pattern]) => pattern.test(tail));
      if (match) return match[0];
    }
  }
  return 'unclassified';
}

function safeDockerError(error) {
  if (typeof error !== 'string' || !error) return null;
  if (DOCKER_HOST_PORT_BIND_FAILURE.test(error)) return 'port-unavailable';
  if (/permission denied|operation not permitted|EACCES/i.test(error)) return 'permission-denied';
  if (/invalid mount config|bind source path does not exist|not a directory.*mount/i.test(error)) {
    return 'mount-rejected';
  }
  if (/port is already allocated|bind: address already in use/i.test(error)) {
    return 'port-unavailable';
  }
  return 'other';
}

async function composeStartupFailure(projectName, composeError, stage) {
  const composeOutputs = [composeError?.stderr, composeError?.stdout];
  const containerOutputs = [];
  const daemonOutputs = [composeError?.stderr];
  const containers = [];
  let inspection = 'completed';
  try {
    const { stdout } = await exec('docker', ['ps', '-a', '--filter',
      `label=com.docker.compose.project=${projectName}`, '--format', '{{json .}}'],
    { timeout: 10_000, maxBuffer: 64 * 1024 });
    for (const line of stdout.trim().split('\n').filter(Boolean).slice(0, 8)) {
      try {
        const listed = JSON.parse(line);
        const name = listed.Names;
        if (typeof name !== 'string' || !name.startsWith(`${projectName}-`)) continue;
        const { stdout: raw } = await exec('docker', ['inspect', name, '--format', '{{json .}}'],
          { timeout: 10_000, maxBuffer: 512 * 1024 });
        const inspected = JSON.parse(raw);
        const state = inspected.State ?? {};
        daemonOutputs.push(state.Error);
        const service = inspected.Config?.Labels?.['com.docker.compose.service'];
        const healthLogs = Array.isArray(state.Health?.Log) ? state.Health.Log.slice(-5) : [];
        containerOutputs.push(state.Error, ...healthLogs.map(item => item.Output));
        const product = stage === 'rotation' && service === CORE_LIVE_PRODUCT_SERVICE;
        const containerEvidence = { service: ['agent-teams-personal', 'caddy-personal',
          'caddy-personal-volume-owner-init'].includes(service) ? service : 'unknown',
          state: ['created', 'running', 'exited', 'dead', 'paused', 'restarting'].includes(state.Status)
            ? state.Status : 'unknown',
          exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode : null,
          restartCount: Number.isSafeInteger(inspected.RestartCount) && inspected.RestartCount >= 0
            ? inspected.RestartCount : null,
          stateError: safeDockerError(state.Error),
          health: ['healthy', 'unhealthy', 'starting'].includes(state.Health?.Status)
            ? state.Health.Status : null,
          healthFailingStreak: Number.isSafeInteger(state.Health?.FailingStreak) &&
            state.Health.FailingStreak >= 0 ? state.Health.FailingStreak : null,
          healthLogEntries: healthLogs.length,
          healthLastExitCode: Number.isSafeInteger(healthLogs.at(-1)?.ExitCode)
            ? healthLogs.at(-1).ExitCode : null };
        if (product) containerEvidence.readiness = await productReadinessProbe(name);
        containers.push(containerEvidence);
        const { stdout: logs, stderr } = await exec('docker', ['logs', '--tail', '100', name],
          { timeout: 10_000, maxBuffer: 256 * 1024 });
        containerOutputs.push(logs, stderr);
        if (product) {
          containerEvidence.readinessDiagnostic = classifyProductReadinessDiagnostic(`${logs}\n${stderr}`);
        }
      } catch {
        inspection = 'partial';
      }
    }
  } catch {
    inspection = 'partial';
  }
  return { phase: 'compose-up', classification: classifyComposeFailure({ containerOutputs,
    composeOutputs, daemonOutputs }),
    composeExitCode: Number.isSafeInteger(composeError?.code) ? composeError.code : null,
    inspection, containers };
}

async function composeUp(args, file, environment, timeoutMs, evidence, stage) {
  try {
    const { stdout } = await exec('docker', ['compose', '-f', file, ...args],
      { env: environment, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    evidence.composeFailure = { stage,
      ...await composeStartupFailure(environment.COMPOSE_PROJECT_NAME, error, stage) };
    throw new Error(`core-live-compose-${stage}-failed:${evidence.composeFailure.classification}`);
  }
}

async function imageEvidence(containerName) {
  const raw = await command('docker', ['inspect', containerName, '--format', '{{json .}}']);
  const container = JSON.parse(raw);
  if (!/^sha256:[0-9a-f]{64}$/.test(container.Image ?? '')) {
    throw new Error('core-live-product-image-identity-invalid');
  }
  return { containerId: container.Id, imageId: container.Image,
    imageReference: container.Config?.Image, startedAt: container.State?.StartedAt };
}

async function workspaceMountEvidence(containerName, workspaceRoot, identity) {
  const host = await lstat(workspaceRoot, { bigint: true });
  if (!host.isDirectory() || host.isSymbolicLink() || host.uid !== 1000n || host.gid !== 1000n ||
      identity.declaredRootHash !== createHash('sha256').update(workspaceRoot).digest('hex')) {
    throw new Error('core-live-signed-workspace-root-invalid');
  }
  const container = JSON.parse(await command('docker', ['inspect', containerName,
    '--format', '{{json .}}']));
  const matches = container.Mounts?.filter(mount => mount.Type === 'bind' &&
    mount.Source === workspaceRoot && mount.Destination === workspaceRoot && mount.RW === true);
  if (matches?.length !== 1) throw new Error('core-live-product-workspace-bind-mismatch');
  const inside = JSON.parse(await command('docker', ['exec', containerName, 'node', '-e',
    "const s=require('node:fs').statSync(process.argv[1],{bigint:true});process.stdout.write(JSON.stringify({dev:s.dev.toString(),ino:s.ino.toString(),uid:s.uid.toString(),gid:s.gid.toString()}))",
    workspaceRoot]));
  if (inside.dev !== host.dev.toString() || inside.ino !== host.ino.toString() ||
      inside.uid !== '1000' || inside.gid !== '1000') {
    throw new Error('core-live-product-workspace-inode-mismatch');
  }
  return { source: workspaceRoot, destination: workspaceRoot,
    device: inside.dev, inode: inside.ino, uid: 1000, gid: 1000,
    declaredRootHash: identity.declaredRootHash };
}

async function containerStopped(containerName) {
  const state = await command('docker', ['ps', '-a', '--filter', `name=^/${containerName}$`,
    '--format', '{{.State}}']);
  return state === '' || state === 'exited' || state === 'dead';
}

async function pairingCode(containerName) {
  const raw = await command('docker', ['exec', containerName, 'cat', '/run/agent-teams/pairing.json']);
  const document = JSON.parse(raw);
  if (!/^[A-Za-z0-9_-]{16,}$/.test(document.pairingCode ?? '') ||
      document.expiresAt <= Date.now()) throw new Error('core-live-pairing-challenge-invalid');
  return document.pairingCode;
}

async function grantSandboxWorkspace(containerName, sandbox, userId) {
  const runtimeWorkspaceId = sandbox.identity.workspaceId;
  if (!/^workspace_[0-9a-f]{32}$/.test(runtimeWorkspaceId) ||
      sandbox.productEnvironment.HOSTED_WORKSPACE_IDS !== runtimeWorkspaceId ||
      !/^usr_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(userId)) {
    throw new Error('core-live-sandbox-workspace-grant-input-invalid');
  }
  const grant = JSON.parse(await command('docker', ['exec', containerName, 'node',
    'scripts/hosted-auth-cli.mjs', 'workspaces', 'grant', userId, runtimeWorkspaceId]));
  if (grant.userId !== userId || grant.runtimeWorkspaceId !== runtimeWorkspaceId ||
      !/^workspace_[0-9a-f]{32}$/.test(grant.workspaceId) ||
      grant.grantGeneration !== sandbox.identity.restoreGeneration ||
      grant.grantedBy !== 'local-cli') {
    throw new Error('core-live-sandbox-workspace-grant-mismatch');
  }
  return grant.workspaceId;
}

async function officialProductBinary(containerName) {
  const raw = await command('docker', ['exec', containerName, 'cat',
    '/data/.agent-teams/data/hosted-opencode-runtime/current.json']);
  const manifest = JSON.parse(raw);
  if (manifest.version !== '1.18.32' || manifest.platform !== 'linux-x64' ||
      manifest.binarySha256 !== OPENCODE_SHA256) {
    throw new Error('core-live-product-opencode-manifest-invalid');
  }
  const actual = await command('docker', ['exec', containerName, 'sha256sum', manifest.binaryPath]);
  if (!actual.startsWith(`${manifest.binarySha256}  `)) {
    throw new Error('core-live-product-opencode-binary-mismatch');
  }
  return { version: manifest.version, platform: manifest.platform,
    archiveSha256: manifest.archiveSha256, binarySha256: manifest.binarySha256,
    sourceCommit: manifest.sourceCommit };
}

async function machineEvidence(containerName) {
  const container = await command('docker', ['stats', '--no-stream', '--format',
    '{{json .}}', containerName], { timeoutMs: 15_000 });
  const stats = JSON.parse(container);
  return { loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    productCpuPercent: stats.CPUPerc, productMemoryUsage: stats.MemUsage };
}

async function requireCommandProof(workspaceRoot, marker, issuedAtMs) {
  const path = join(workspaceRoot, 'command-proof.txt');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== 1000 || stat.gid !== 1000 || stat.mtimeMs < issuedAtMs - 1000 ||
      (await readFile(path, 'utf8')) !== marker) {
    throw new Error('core-live-sandbox-command-file-proof-invalid');
  }
  return { path, uid: stat.uid, gid: stat.gid, mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(marker).digest('hex') };
}

async function archiveEvidence(runRoot, base, projectName, evidence, custody) {
  const destination = join(base, projectName);
  const staging = join(base, `.staging-${projectName}`);
  await assertEvidenceBaseCustody(custody);
  if (await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) {
    throw new Error('core-live-evidence-destination-exists');
  }
  await mkdir(staging, { mode: 0o700 });
  try {
    const available = new Set(await readdir(runRoot));
    for (const name of ['product-source-manifest.json', 'runner-phase.log',
      'team-created.png', 'team-completed.png']) {
      if (!available.has(name)) {
        if (name.endsWith('.png')) continue;
        throw new Error('core-live-required-evidence-artifact-missing');
      }
      await copyFile(join(runRoot, name), join(staging, name));
      await chmod(join(staging, name), 0o600);
    }
    await writeFile(join(staging, 'evidence.json'),
      `${JSON.stringify({ ...evidence, status: 'archiving' }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
    await assertEvidenceBaseCustody(custody);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

async function publishFinalEvidence(directory, evidence, custody) {
  await assertEvidenceBaseCustody(custody);
  const temporary = join(directory, `.evidence-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'evidence.json'));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main() {
  const inputs = await preflight(process.env);
  const runRoot = await mkdtemp('/tmp/hosted-core-live-');
  const projectName = composeProjectName();
  let httpsPort;
  let redirectPort;
  const sourceManifest = await captureSourceManifest(repo);
  await writeFile(join(runRoot, 'product-source-manifest.json'),
    `${JSON.stringify(sourceManifest, null, 2)}\n`, { mode: 0o600 });
  const evidence = { schemaVersion: 1, status: 'running', projectName,
    hostSupervisorTrustBoundary: 'uid999-gid987-controls-an-ancestor-of-root-owned-evidence-base',
    productSourceHead: await command('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    productSourceManifestSha256: sourceManifest.sha256,
    productSourceManifestFileCount: sourceManifest.fileCount,
    productSourceManifestFile: 'product-source-manifest.json',
    ownerSourceHead: inputs.ownerCommit, model: MODEL, phases: [] };
  let sandbox;
  let composeFile;
  let composeEnv;
  let session;
  let productStopped = true;
  try {
    sandbox = await startCoreSandbox(inputs);
    [httpsPort, redirectPort] = await allocateCoreLivePorts();
    evidence.hostPorts = { httpsPort, redirectPort };
    evidence.initialOwnerRuntimeAttestation = ownerRuntimeAttestation(sandbox);
    const containerName = `${projectName}-product`;
    composeEnv = composeEnvironment(process.env, sandbox, projectName, httpsPort, redirectPort);
    ({ path: composeFile } = await renderProduction(sandbox, projectName, runRoot, composeEnv, 'initial'));
    productStopped = false;
    await composeUp(['up', '-d', '--build', '--wait'], composeFile, composeEnv,
      30 * 60_000, evidence, 'initial');
    evidence.phases.push('product-started');
    evidence.owner = { imageReference: sandbox.image.imageReference,
      imageDigest: sandbox.image.ownerArtifactDigest,
      executableDigest: sandbox.image.ownerExecutableDigest,
      cliSha256: sandbox.image.cliSha256, bunSha256: sandbox.image.bunSha256 };
    evidence.product = await imageEvidence(containerName);
    evidence.initialWorkspaceMount = await workspaceMountEvidence(containerName,
      sandbox.workspaceRoot, sandbox.identity);
    evidence.product.opencode = await officialProductBinary(containerName);
    evidence.machineAtStart = await machineEvidence(containerName);
    session = await openProductBrowser(composeEnv.HOSTED_PUBLIC_ORIGIN,
      await pairingCode(containerName));
    evidence.phases.push('chromium-paired');
    const publicWorkspaceId = await grantSandboxWorkspace(containerName, sandbox, session.userId);
    await selectGrantedWorkspace(session, publicWorkspaceId);
    evidence.phases.push('sandbox-workspace-granted-and-selected');
    const team = await createConfiguredTeam(session, {
      model: MODEL, claudeRoot: sandbox.claudeRoot,
    });
    evidence.team = { teamId: team.teamId, workspaceId: team.workspaceId,
      legacyKey: team.legacyKey, publication: team.publication, model: team.model };
    await session.page.screenshot({ path: join(runRoot, 'team-created.png'), fullPage: true });
    evidence.phases.push('team-created-and-published');
    await compose(['stop', CORE_LIVE_PRODUCT_SERVICE], composeFile, composeEnv, 90_000);
    productStopped = true;
    await sandbox.rotateToTeam(team.teamId, {
      legacyKey: team.legacyKey,
      assertProductStopped: () => containerStopped(containerName),
      localProviderBaseUrl: inputs.localProviderBaseUrl,
    });
    evidence.rotation = sandbox.rotationHistory;
    evidence.activeOwnerRuntimeAttestation = ownerRuntimeAttestation(sandbox);
    evidence.phases.push('owner-rotated-to-created-team');
    composeEnv = composeEnvironment(process.env, sandbox, projectName, httpsPort, redirectPort);
    ({ path: composeFile } = await renderProduction(sandbox, projectName, runRoot, composeEnv, 'rotated'));
    await composeUp(['up', '-d', '--force-recreate', '--wait'], composeFile, composeEnv,
      10 * 60_000, evidence, 'rotation');
    productStopped = false;
    evidence.productAfterRotation = await imageEvidence(containerName);
    evidence.activeWorkspaceMount = await workspaceMountEvidence(containerName,
      sandbox.workspaceRoot, sandbox.identity);
    const commandProofPath = join(sandbox.workspaceRoot, 'command-proof.txt');
    const priorProof = await lstat(commandProofPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (priorProof !== null) throw new Error('core-live-command-proof-existed-before-command');
    const outcome = await exerciseTeam(session, team, { claudeRoot: sandbox.claudeRoot,
      workspaceRoot: sandbox.workspaceRoot });
    evidence.outcome = outcome;
    evidence.commandFile = await requireCommandProof(sandbox.workspaceRoot,
      outcome.commandMarker, outcome.commandIssuedAtMs);
    await session.page.screenshot({ path: join(runRoot, 'team-completed.png'), fullPage: true });
    evidence.phases.push('team-message-and-task-completed');
    evidence.provider = JSON.parse(await command(sandbox.image.bun, ['run',
      providerEvidenceScript, sandbox.claudeRoot, team.marker, outcome.commandMarker,
      sandbox.workspaceRoot],
    { timeoutMs: 30_000 }));
    evidence.machineAtCompletion = await machineEvidence(containerName);
    evidence.phases.push('official-opencode-model-request-proven');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = error instanceof Error ? error.message : 'unknown';
    throw error;
  } finally {
    await session?.browser.close().catch(() => {
      evidence.cleanupError = 'core-live-browser-close-failed';
    });
    if (composeFile && composeEnv) {
      try {
        await compose(['down', '--volumes', '--remove-orphans'], composeFile, composeEnv, 120_000);
        productStopped = await containerStopped(`${projectName}-product`).catch(() => false);
      } catch {
        productStopped = await containerStopped(`${projectName}-product`).catch(() => false);
        evidence.cleanupError = 'core-live-compose-down-failed';
      }
    }
    if (productStopped) await sandbox?.close().catch(() => {
      evidence.cleanupError = 'core-live-owner-cleanup-failed';
    });
    else if (sandbox) evidence.cleanupError = 'core-live-product-still-running-owner-preserved';
    try {
      const finalManifest = await captureSourceManifest(repo);
      if (finalManifest.sha256 !== sourceManifest.sha256) {
        evidence.cleanupError = 'core-live-product-source-changed-during-run';
      }
    } catch {
      evidence.cleanupError = 'core-live-product-source-recheck-failed';
    }
    if (evidence.cleanupError) {
      evidence.status = 'failed';
      process.exitCode = 1;
    }
    evidence.artifactDirectory = join(inputs.evidenceDirectory, projectName);
    evidence.artifacts = ['evidence.json', 'product-source-manifest.json', 'runner-phase.log',
      ...(await readdir(runRoot)).filter(name => ['team-created.png', 'team-completed.png'].includes(name))];
    await writeFile(join(runRoot, 'evidence.json'),
      `${JSON.stringify({ ...evidence, status: 'archiving' }, null, 2)}\n`,
      { mode: 0o600 });
    await writeFile(join(runRoot, 'runner-phase.log'),
      `${evidence.phases.map(phase => `phase=${phase}`).join('\n')}\n` +
      (evidence.failure ? `failure=${evidence.failure}\n` : '') +
      (evidence.cleanupError ? `cleanup=${evidence.cleanupError}\n` : ''), { mode: 0o600 });
    let archived;
    try {
      archived = await archiveEvidence(runRoot, inputs.evidenceDirectory, projectName,
        evidence, inputs.evidenceCustody);
    } catch {
      evidence.status = 'failed';
      evidence.cleanupError = 'core-live-evidence-archive-failed';
      process.exitCode = 1;
      await writeFile(join(runRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 });
      process.stderr.write(`core-live-evidence-recovery:${join(runRoot, 'evidence.json')}\n`);
    }
    if (archived) {
      if (!evidence.cleanupError) {
        await rm(runRoot, { recursive: true, force: true }).catch(() => {
          evidence.status = 'failed';
          evidence.cleanupError = 'core-live-run-scratch-removal-failed';
          process.exitCode = 1;
        });
      }
      try {
        await publishFinalEvidence(archived, evidence, inputs.evidenceCustody);
        process.stderr.write(`core-live-evidence:${join(archived, 'evidence.json')}\n`);
      } catch {
        process.exitCode = 1;
        process.stderr.write(`core-live-evidence-incomplete:${join(archived, 'evidence.json')}\n`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'core-live-unknown-failure'}\n`);
    process.exitCode = 1;
  });
}
