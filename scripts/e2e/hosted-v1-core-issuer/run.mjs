import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chown, chmod, copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoreIdentity, observedOwnerSocket, publishCoreAdmission } from './admission.mjs';
import { EXACT_OWNER_COMMIT, extractPinnedImageFile, prepareOwnerImage } from './oci-image.mjs';

const helper = fileURLToPath(new URL('./descriptor-launcher.py', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OFFICIAL_OPENCODE_SHA256 = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function readPublishedFile(path, uid, gid) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(uid) ||
        before.gid !== BigInt(gid) || (before.mode & 0o077n) !== 0n ||
        before.size < 1n || before.size > 65536n) {
      throw new Error('core-issuer-published-team-file-custody-invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (BigInt(bytes.length) !== before.size || before.dev !== after.dev ||
        before.ino !== after.ino || before.ino !== named.ino || before.dev !== named.dev ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('core-issuer-published-team-file-changed');
    }
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}

export async function assertPublishedTeamIdentity(claudeRoot, teamId, legacyKey, deploymentId, uid, gid) {
  if (typeof legacyKey !== 'string' || !/^draft-[0-9a-f]{32}$/u.test(legacyKey) ||
      !/^team_[0-9a-f]{32}$/u.test(teamId)) {
    throw new Error('core-issuer-published-team-key-invalid');
  }
  const directory = join(claudeRoot, 'teams', legacyKey);
  const entry = await lstat(directory, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(uid) ||
      entry.gid !== BigInt(gid) || (entry.mode & 0o077n) !== 0n) {
    throw new Error('core-issuer-published-team-directory-custody-invalid');
  }
  const markerBytes = await readPublishedFile(join(directory, '.hosted-draft-publication.json'), uid, gid);
  const identityBytes = await readPublishedFile(join(directory, 'team.identity.json'), uid, gid);
  const marker = JSON.parse(markerBytes);
  const identity = JSON.parse(identityBytes);
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify([
    'schemaVersion', 'operationId', 'teamId', 'directoryFingerprint', 'rootFingerprint', 'teamsFingerprint'].sort()) ||
      marker.schemaVersion !== 1 || marker.operationId !== `adoption_${legacyKey.slice(6)}` ||
      marker.teamId !== teamId ||
      ![marker.directoryFingerprint, marker.rootFingerprint, marker.teamsFingerprint]
        .every(value => /^[0-9a-f]{64}$/u.test(value)) ||
      markerBytes !== `${JSON.stringify(marker)}\n` ||
      JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([
        'schemaVersion', 'teamId', 'createdAt', 'originDeploymentId'].sort()) ||
      identity.schemaVersion !== 1 || identity.teamId !== teamId ||
      identity.originDeploymentId !== deploymentId ||
      !Number.isFinite(Date.parse(identity.createdAt)) ||
      identityBytes !== `${JSON.stringify(identity, null, 2)}\n`) {
    throw new Error('core-issuer-published-team-identity-mismatch');
  }
  const current = await lstat(directory, { bigint: true });
  if (current.dev !== entry.dev || current.ino !== entry.ino ||
      current.mtimeNs !== entry.mtimeNs || current.ctimeNs !== entry.ctimeNs) {
    throw new Error('core-issuer-published-team-directory-changed');
  }
  return Object.freeze({ teamId, legacyKey, operationId: marker.operationId,
    directoryFingerprint: marker.directoryFingerprint });
}

async function stageLocalProvider(image, baseURL) {
  if (baseURL === undefined) return null;
  if (typeof baseURL !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/u.test(baseURL) ||
      Number(new URL(baseURL).port) > 65535) {
    throw new Error('core-issuer-local-provider-must-be-loopback-v1');
  }
  const content = JSON.stringify({ provider: { 'local-llama': {
    npm: '@ai-sdk/openai-compatible', options: { baseURL },
    models: { 'qwen3-8b': { name: 'Qwen3-8B', tool_call: true,
      options: { reasoningEffort: 'none' } } },
  } } });
  const directory = join(image.root, 'opencode-config');
  const child = join(directory, 'opencode');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(child, { mode: 0o700 });
  const path = join(child, 'opencode.json');
  await writeFile(path, `${content}\n`, { flag: 'wx', mode: 0o400 });
  await chmod(path, 0o444);
  await chmod(child, 0o555);
  await chmod(directory, 0o555);
  return Object.freeze({ directory, path, digest: hash(Buffer.from(`${content}\n`)), content,
    model: 'local-llama/qwen3-8b', baseURL });
}

async function assertOwnerEnvironment(pid, localProvider, officialOpenCodePath) {
  if (!localProvider && !officialOpenCodePath) return;
  const bytes = await readFile(`/proc/${pid}/environ`);
  const values = new Map(bytes.toString('utf8').split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  if (officialOpenCodePath && (values.get('HOSTED_OPENCODE_RUNTIME_MODE') !== 'official-v1.18.32' ||
      values.get('HOSTED_OPENCODE_BIN_PATH') !== officialOpenCodePath)) {
    throw new Error('core-issuer-owner-opencode-env-mismatch');
  }
  if (localProvider && (values.get('XDG_CONFIG_HOME') !== localProvider.directory ||
      hash(Buffer.from(`${values.get('OPENCODE_CONFIG_CONTENT')}\n`)) !== localProvider.digest ||
      hash(await readFile(localProvider.path)) !== localProvider.digest)) {
    throw new Error('core-issuer-owner-provider-config-mismatch');
  }
}

export async function stageOfficialOpenCode(image, sourcePath) {
  if (sourcePath === undefined) return null;
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || await realpath(sourcePath) !== sourcePath) {
    throw new Error('core-issuer-official-opencode-source-invalid');
  }
  const source = await lstat(sourcePath);
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) {
    throw new Error('core-issuer-official-opencode-source-invalid');
  }
  const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  if (digest !== OFFICIAL_OPENCODE_SHA256) throw new Error('core-issuer-official-opencode-digest-mismatch');
  const directory = join(image.root, 'official-opencode');
  await mkdir(directory, { mode: 0o700 });
  const installed = join(directory, 'opencode');
  await copyFile(sourcePath, installed, constants.COPYFILE_EXCL);
  await chown(installed, 0, 0);
  const installedStat = await lstat(installed);
  if (!installedStat.isFile() || installedStat.isSymbolicLink() || installedStat.uid !== 0 ||
      installedStat.gid !== 0 || installedStat.nlink !== 1 ||
      createHash('sha256').update(await readFile(installed)).digest('hex') !== OFFICIAL_OPENCODE_SHA256) {
    throw new Error('core-issuer-official-opencode-stage-invalid');
  }
  await chmod(installed, 0o555);
  await chmod(directory, 0o555);
  return installed;
}

const NODE_24_SLIM_IMAGE = /^node:24\.[0-9]+\.[0-9]+-slim@sha256:[0-9a-f]{64}$/u;

async function rootImmutableFile(path, mode, expectedSha256) {
  await chown(path, 0, 0);
  const staged = await lstat(path);
  const digest = hash(await readFile(path));
  if (!staged.isFile() || staged.isSymbolicLink() || staged.uid !== 0 || staged.gid !== 0 ||
      staged.nlink !== 1 || staged.size === 0 || (expectedSha256 && digest !== expectedSha256)) {
    throw new Error('core-issuer-agent-teams-mcp-stage-invalid');
  }
  await chmod(path, mode);
  return digest;
}

/**
 * Stages the host-local app MCP for trusted_process agents: the Product-built
 * stdio bundle and a Node 24 binary taken from a digest-pinned Node image, both
 * root-owned below the issuer root. Owner receives only this pinned descriptor.
 */
export async function stageAgentTeamsMcp(image, { entrySource, entrySha256, nodeImage },
  { extractFile = extractPinnedImageFile } = {}) {
  if (entrySource === undefined && entrySha256 === undefined && nodeImage === undefined) return null;
  if (typeof entrySource !== 'string' || !isAbsolute(entrySource) ||
      await realpath(entrySource) !== entrySource || !/^[0-9a-f]{64}$/u.test(entrySha256 ?? '')) {
    throw new Error('core-issuer-agent-teams-mcp-entry-source-invalid');
  }
  if (typeof nodeImage !== 'string' || !NODE_24_SLIM_IMAGE.test(nodeImage)) {
    throw new Error('core-issuer-agent-teams-mcp-node-image-must-be-pinned-node-24-slim');
  }
  const source = await lstat(entrySource);
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) {
    throw new Error('core-issuer-agent-teams-mcp-entry-source-invalid');
  }
  const directory = join(image.root, 'agent-teams-mcp');
  await mkdir(directory, { mode: 0o700 });
  const entry = join(directory, 'index.js');
  const command = join(directory, 'node');
  // The copy, not the source, is hashed: later source edits cannot reach Owner.
  await copyFile(entrySource, entry, constants.COPYFILE_EXCL);
  await rootImmutableFile(entry, 0o444, entrySha256);
  await extractFile({ image: nodeImage, source: '/usr/local/bin/node', destination: command });
  const commandSha256 = await rootImmutableFile(command, 0o555);
  await chmod(directory, 0o555);
  return Object.freeze({ command, commandSha256, entry, entrySha256 });
}

async function ownedDirectory(path, uid, gid) {
  await mkdir(path, { mode: 0o700 });
  await chown(path, uid, gid);
  await chmod(path, 0o700);
}

function agentTeamsMcpAttested(attested, staged) {
  if (!staged) return attested === null;
  return attested?.commandSha256 === staged.commandSha256 &&
    attested.entrySha256 === staged.entrySha256 &&
    /^v24\.(?:1[5-9]|[2-9][0-9])\.[0-9]+$/u.test(attested.nodeVersion ?? '');
}

function lines(stream, onLine, onError) {
  let pending = '';
  stream.on('data', bytes => {
    pending += bytes.toString('utf8');
    if (pending.length > 8192) { onError(new Error('core-issuer-launcher-output-too-large')); return; }
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { onLine(JSON.parse(line)); }
      catch (error) { onError(error); return; }
    }
  });
}

async function launchDescriptors(image, identity, { uid, gid, home, socketPath, officialOpenCodePath, localProvider,
  agentTeamsMcp }) {
  const launcherLeaseId = `launcher-lease_${randomBytes(12).toString('hex')}`;
  const lease = {
    format: 'agent-teams.hosted-control.launcher-lease/v1', launcherLeaseId,
    ownerArtifactDigest: image.ownerArtifactDigest,
    ownerExecutableDigest: image.ownerExecutableDigest,
    bootstrapDigest: identity.bootstrapBinding.bootstrapDigest,
    proofKeyId: identity.bootstrapBinding.proofKeyId,
    ownerGeneration: identity.ownerGeneration, ownerSessionId: identity.ownerSessionId,
  };
  const header = {
    format: 'agent-teams.hosted-control.bootstrap/v1',
    admissionKind: 'core-lifecycle-v1',
    restoreGeneration: identity.restoreGeneration,
    teamId: identity.teamId,
    declaredRootHash: identity.declaredRootHash,
    ownerAuthority: identity.ownerAuthority,
    ownerGeneration: identity.ownerGeneration,
    ownerSessionId: identity.ownerSessionId,
    claudeRoot: home,
    socketPath,
    legacyKey: identity.legacyKey,
    bootstrapBinding: identity.bootstrapBinding,
    leaseEvidence: null,
  };
  const child = spawn('python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  } });
  let spawned;
  let failed;
  const ready = new Promise((resolve, reject) => { spawned = resolve; failed = reject; });
  const timer = setTimeout(() => failed(new Error('core-issuer-launcher-timeout')), 10_000);
  child.once('error', failed);
  child.once('exit', code => failed(new Error(`core-issuer-launcher-exit:${code}`)));
  lines(child.stdout, value => {
    if (value?.kind === 'spawned' && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        value.attestation?.bunEnvironmentVerified === true &&
        value.attestation.officialOpenCodeSha256 === (officialOpenCodePath ? OFFICIAL_OPENCODE_SHA256 : null) &&
        value.attestation.providerConfigSha256 === (localProvider?.digest ?? null) &&
        value.attestation.model === (localProvider?.model ?? null) &&
        agentTeamsMcpAttested(value.attestation.agentTeamsMcp, agentTeamsMcp)) {
      clearTimeout(timer);
      spawned({ pid: value.pid, attestation: value.attestation });
    } else if (value?.kind === 'launcher-error') {
      clearTimeout(timer);
      failed(new Error(`core-issuer-launcher:${value.reason}`));
    }
  }, failed);
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-2000); });
  child.stdin.write(`${JSON.stringify({
    cli: image.cli, bun: image.bun, cliSha256: image.cliSha256, bunSha256: image.bunSha256,
    uid, gid, home, officialOpenCodePath, localProvider, agentTeamsMcp,
    lease, header, secret: identity.secret.toString('hex'),
    logPath: join(image.root, 'owner.log'),
  })}\n`);
  const { pid, attestation } = await ready.catch(error => { child.stdin.end(); throw new Error(`${error.message}:${stderr}`); });
  return { child, pid, attestation: Object.freeze({ ...attestation }), close: async () => {
    child.stdin.end();
    if (child.exitCode !== null) return;
    const completed = new Promise(resolve => child.once('exit', resolve));
    await Promise.race([completed, sleep(12_000)]);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([completed, sleep(5_000)]);
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  } };
}

async function waitForSocket(path, uid, gid, launcher, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launcher.child.exitCode !== null) throw new Error('core-issuer-owner-exited-before-socket');
    try { return await observedOwnerSocket(path, uid, gid); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(100);
  }
  throw new Error('core-issuer-owner-socket-timeout');
}

async function waitForSocketRemoval(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (entry === null) return;
    await sleep(100);
  }
  throw new Error('core-issuer-old-owner-socket-still-present');
}

function productEnvironment(identity) {
  return {
    HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock',
    HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE: '/run/agent-teams-orchestrator/lifecycle-owner-admission.json',
    HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: '/run/agent-teams-lifecycle-trust/trust-anchor',
    HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE: '/run/agent-teams-lifecycle-trust/release-owner-pin.json',
    AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: identity.bootstrap,
    AUTH_DEPLOYMENT_ID: identity.deploymentId,
    AUTH_RESTORE_GENERATION: String(identity.restoreGeneration),
    HOSTED_WORKSPACE_IDS: identity.workspaceId,
  };
}

/**
 * A disposable, test-only Owner issuer. Product startup is deliberately left
 * to the caller, which receives only bind paths and its read bootstrap.
 */
export async function startCoreSandbox({ ownerRepo, ownerCommit, registryImage, baseImage,
  teamId, deploymentId, workspaceId, ownerGeneration = 1, restoreGeneration = 0,
  openCodeBinaryPath, localProviderBaseUrl, agentTeamsMcpEntry, agentTeamsMcpEntrySha256,
  agentTeamsMcpNodeImage, uid = 1000, gid = 1000 }) {
  if (ownerCommit !== EXACT_OWNER_COMMIT) throw new Error('core-issuer-exact-owner-commit-mismatch');
  const image = await prepareOwnerImage({ ownerRepo, ownerCommit, registryImage, baseImage });
  let launcher;
  try {
    // Root remains the only writer. Bun requires readable traversal of this
    // root-owned ancestor to preserve its selected runtime environment.
    await chmod(image.root, 0o755);
    const claudeRoot = join(image.root, 'claude');
    const runDirectory = join(image.root, 'owner-run');
    const trustDirectory = join(image.root, 'trust');
    const workspaceRoot = join(image.root, 'sandbox-project');
    await ownedDirectory(claudeRoot, uid, gid);
    await ownedDirectory(runDirectory, uid, gid);
    await ownedDirectory(workspaceRoot, uid, gid);
    const identity = createCoreIdentity({ image, claudeRoot: '/data/.claude',
      workspaceRoot, teamId, deploymentId, workspaceId,
      ownerGeneration, restoreGeneration });
    identity.legacyKey = `sandbox_${randomBytes(8).toString('hex')}`;
    await ownedDirectory(join(claudeRoot, 'teams'), uid, gid);
    await ownedDirectory(join(claudeRoot, 'tasks'), uid, gid);
    await ownedDirectory(join(claudeRoot, 'teams', identity.legacyKey), uid, gid);
    await ownedDirectory(join(claudeRoot, 'tasks', identity.legacyKey), uid, gid);
    const officialOpenCodePath = await stageOfficialOpenCode(image, openCodeBinaryPath);
    const localProvider = await stageLocalProvider(image, localProviderBaseUrl);
    const agentTeamsMcp = await stageAgentTeamsMcp(image, { entrySource: agentTeamsMcpEntry,
      entrySha256: agentTeamsMcpEntrySha256, nodeImage: agentTeamsMcpNodeImage });
    const socketPath = join(runDirectory, 'orchestrator-lifecycle.sock');
    launcher = await launchDescriptors(image, identity, {
      uid, gid, home: claudeRoot, socketPath, officialOpenCodePath, localProvider, agentTeamsMcp,
    });
    await waitForSocket(socketPath, uid, gid, launcher);
    await assertOwnerEnvironment(launcher.pid, localProvider, officialOpenCodePath);
    const admission = await publishCoreAdmission({ identity, runDirectory, trustDirectory, socketPath,
      productSocketPath: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock', uid, gid });
    let closed = false;
    const sandbox = {
      image, identity, launcher, admission, claudeRoot, runDirectory, trustDirectory, workspaceRoot,
      officialOpenCodePath, agentTeamsMcp, ownerLogPath: join(image.root, 'owner.log'),
      ownerRuntimeAttestation: launcher.attestation,
      _localProvider: localProvider,
      localProvider: localProvider && { digest: localProvider.digest, baseURL: localProvider.baseURL,
        model: localProvider.model, configPath: localProvider.path },
      rotationHistory: [],
      productEnvironment: productEnvironment(identity),
      async rotateToTeam(nextTeamId, { legacyKey, assertProductStopped, openCodeBinaryPath: nextOpenCodeBinaryPath,
        localProviderBaseUrl: nextLocalProviderBaseUrl } = {}) {
        if (closed) throw new Error('core-issuer-closed');
        if (typeof assertProductStopped !== 'function' || await assertProductStopped() !== true) {
          throw new Error('core-issuer-product-must-be-stopped-before-rotation');
        }
        if (!/^team_[0-9a-f]{32}$/u.test(nextTeamId) || nextTeamId === sandbox.identity.teamId) {
          throw new Error('core-issuer-rotation-team-id-invalid');
        }
        const prior = sandbox.identity;
        const priorRunDirectory = sandbox.runDirectory;
        const publishedTeam = await assertPublishedTeamIdentity(claudeRoot, nextTeamId,
          legacyKey, prior.deploymentId, uid, gid);
        await sandbox.launcher.close();
        await waitForSocketRemoval(join(sandbox.runDirectory, 'orchestrator-lifecycle.sock'));
        prior.secret.fill(0);
        const next = createCoreIdentity({ image, claudeRoot: '/data/.claude',
          workspaceRoot, deploymentId: prior.deploymentId,
          workspaceId: prior.workspaceId, teamId: nextTeamId,
          ownerAuthority: prior.ownerAuthority,
          ownerGeneration: prior.ownerGeneration + 1,
          restoreGeneration: prior.restoreGeneration,
          mountGeneration: prior.mountGeneration + 1 });
        next.legacyKey = publishedTeam.legacyKey;
        const nextRun = join(image.root, `owner-run-g${next.ownerGeneration}`);
        const nextTrust = join(image.root, `trust-g${next.ownerGeneration}`);
        await ownedDirectory(nextRun, uid, gid);
        const nextSocket = join(nextRun, 'orchestrator-lifecycle.sock');
        let nextLauncher;
        try {
          const nextOfficialOpenCodePath = sandbox.officialOpenCodePath ??
            await stageOfficialOpenCode(image, nextOpenCodeBinaryPath);
          const nextLocalProvider = sandbox._localProvider ??
            await stageLocalProvider(image, nextLocalProviderBaseUrl);
          nextLauncher = await launchDescriptors(image, next, { uid, gid, home: claudeRoot,
            socketPath: nextSocket, officialOpenCodePath: nextOfficialOpenCodePath,
            localProvider: nextLocalProvider, agentTeamsMcp: sandbox.agentTeamsMcp });
          await waitForSocket(nextSocket, uid, gid, nextLauncher);
          await assertOwnerEnvironment(nextLauncher.pid, nextLocalProvider, nextOfficialOpenCodePath);
          const nextAdmission = await publishCoreAdmission({ identity: next,
            runDirectory: nextRun, trustDirectory: nextTrust, socketPath: nextSocket,
            productSocketPath: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock', uid, gid });
          sandbox.identity = next;
          sandbox.launcher = nextLauncher;
          sandbox.ownerRuntimeAttestation = nextLauncher.attestation;
          sandbox.admission = nextAdmission;
          sandbox.runDirectory = nextRun;
          sandbox.trustDirectory = nextTrust;
          sandbox.officialOpenCodePath = nextOfficialOpenCodePath;
          sandbox._localProvider = nextLocalProvider;
          sandbox.localProvider = nextLocalProvider && { digest: nextLocalProvider.digest,
            baseURL: nextLocalProvider.baseURL, model: nextLocalProvider.model,
            configPath: nextLocalProvider.path };
          sandbox.productEnvironment = productEnvironment(next);
          sandbox.rotationHistory.push(Object.freeze({
            from: { teamId: prior.teamId, ownerGeneration: prior.ownerGeneration,
              bootId: prior.bootId, runDirectory: priorRunDirectory },
            to: { teamId: next.teamId, ownerGeneration: next.ownerGeneration,
              bootId: next.bootId, runDirectory: nextRun,
              legacyKey: publishedTeam.legacyKey, operationId: publishedTeam.operationId,
              directoryFingerprint: publishedTeam.directoryFingerprint },
            oldOwnerSocketRemoved: true,
          }));
          return sandbox;
        } catch (error) {
          await nextLauncher?.close().catch(() => undefined);
          next.secret.fill(0);
          throw error;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await sandbox.launcher.close();
        sandbox.identity.secret.fill(0);
        await image.close();
      },
    };
    return sandbox;
  } catch (error) {
    await launcher?.close().catch(() => undefined);
    await image.close();
    throw error;
  }
}
