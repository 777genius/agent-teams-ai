#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm,
  writeFile } from 'node:fs/promises';
import { freemem, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConfiguredTeam, exerciseTeam, openProductBrowser } from './browser.mjs';
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
const EVIDENCE_BASE = '/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1/operator-evidence/chain-20260924';

async function evidenceBaseCustody() {
  const parts = EVIDENCE_BASE.split('/').filter(Boolean);
  const paths = ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)];
  const custody = [];
  for (const path of paths) {
    const stat = await lstat(path, { bigint: true }).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n ||
        (stat.mode & 0o022n) !== 0n || await realpath(path) !== path) {
      throw new Error('core-live-evidence-base-custody-invalid');
    }
    custody.push({ path, device: stat.dev.toString(), inode: stat.ino.toString() });
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
  const httpsPort = 49_152 + randomBytes(2).readUInt16BE() % 16_000;
  const redirectPort = 30_000 + randomBytes(2).readUInt16BE() % 16_000;
  const sourceManifest = await captureSourceManifest(repo);
  await writeFile(join(runRoot, 'product-source-manifest.json'),
    `${JSON.stringify(sourceManifest, null, 2)}\n`, { mode: 0o600 });
  const evidence = { schemaVersion: 1, status: 'running', projectName,
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
    evidence.initialOwnerRuntimeAttestation = ownerRuntimeAttestation(sandbox);
    const containerName = `${projectName}-product`;
    composeEnv = composeEnvironment(process.env, sandbox, projectName, httpsPort, redirectPort);
    ({ path: composeFile } = await renderProduction(sandbox, projectName, runRoot, composeEnv, 'initial'));
    productStopped = false;
    await compose(['up', '-d', '--build', '--wait'], composeFile, composeEnv, 30 * 60_000);
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
    await compose(['up', '-d', '--force-recreate', '--wait'], composeFile, composeEnv, 10 * 60_000);
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

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'core-live-unknown-failure'}\n`);
  process.exitCode = 1;
});
