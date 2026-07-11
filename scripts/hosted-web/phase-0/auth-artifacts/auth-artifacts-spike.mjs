#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '../../../..');
const localRequire = createRequire(import.meta.url);

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(root, path = root) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(root, child) : [relative(root, child).replaceAll('\\', '/')];
  });
}

export function newAuthState() {
  return {
    processEpoch: 1,
    processAnchor: {
      status: 'ready',
      protocolVersion: 1,
      runtimeGeneration: 1,
      controlChannelRef: 'anchor-control-channel-ref-1',
      anchorIdentity: 'anchor-identity-ref-1',
      spawnNonceHash: 'spawn-nonce-hash-ref-1',
    },
    keyring: { status: 'ready', keyId: 'key-ref-1' },
    resetGeneration: 0,
    resetIntent: null,
    challenge: null,
    device: null,
    sessions: {},
    mutationAdmission: false,
  };
}

const activeAuthorityExists = (state) =>
  state.keyring.status === 'ready' &&
  Boolean(state.device?.familyRef) &&
  !state.device?.revokedReason &&
  Object.values(state.sessions).some((session) => session.active && !session.revokedReason);

export function validateDrainEvidence(state, evidence, purpose, resetGeneration, recorded = false) {
  void purpose;
  void resetGeneration;
  if (!evidence || evidence.kind !== 'w4_process_anchor_drain_evidence_v1') {
    return 'typed_drain_required';
  }
  const ready = evidence.ready;
  const drained = evidence.response;
  if (!ready || ready.type !== 'ready' || !drained || drained.type !== 'drained') {
    return 'runtime_state_unclassified';
  }
  if (
    Object.keys(evidence).sort().join(',') !== 'controlChannelRef,kind,ready,response,source' ||
    Object.keys(ready).sort().join(',') !==
      'anchorIdentity,mainPidfdReady,ownedProcessGroupReady,protocolVersion,runtimeGeneration,spawnNonceHash,type'
  ) {
    return 'drain_evidence_shape_mismatch';
  }
  if (
    Object.keys(drained).sort().join(',') !== 'protocolVersion,residualCount,runtimeGeneration,type'
  ) {
    return 'drain_response_shape_mismatch';
  }
  const anchor = state.processAnchor;
  if (anchor.status !== (recorded ? 'drained' : 'ready')) return 'drain_anchor_not_ready';
  if (
    evidence.source !== 'w4_process_anchor_control_channel' ||
    evidence.controlChannelRef !== anchor.controlChannelRef ||
    ready.anchorIdentity !== anchor.anchorIdentity ||
    ready.spawnNonceHash !== anchor.spawnNonceHash
  ) {
    return 'drain_provenance_mismatch';
  }
  if (
    ready.protocolVersion !== anchor.protocolVersion ||
    drained.protocolVersion !== anchor.protocolVersion
  ) {
    return 'drain_protocol_version_stale';
  }
  if (
    ready.runtimeGeneration !== anchor.runtimeGeneration ||
    drained.runtimeGeneration !== anchor.runtimeGeneration
  ) {
    return 'drain_runtime_generation_stale';
  }
  if (ready.mainPidfdReady !== true || ready.ownedProcessGroupReady !== true) {
    return 'drain_anchor_not_ready';
  }
  if (drained.residualCount !== 0) return 'runtime_residuals_present';
  return null;
}

function advanceProcessAnchorGeneration(state) {
  const runtimeGeneration = state.processAnchor.runtimeGeneration + 1;
  state.processAnchor = {
    status: 'ready',
    protocolVersion: state.processAnchor.protocolVersion,
    runtimeGeneration,
    controlChannelRef: `anchor-control-channel-ref-${runtimeGeneration}`,
    anchorIdentity: `anchor-identity-ref-${runtimeGeneration}`,
    spawnNonceHash: `spawn-nonce-hash-ref-${runtimeGeneration}`,
  };
}

export function drainEvidenceFor(state, purpose, resetGeneration, overrides = {}) {
  void purpose;
  void resetGeneration;
  const responseOverrides = overrides.response ?? {};
  const readyOverrides = overrides.ready ?? {};
  const envelopeOverrides = { ...overrides };
  delete envelopeOverrides.response;
  delete envelopeOverrides.ready;
  return {
    kind: 'w4_process_anchor_drain_evidence_v1',
    source: 'w4_process_anchor_control_channel',
    controlChannelRef: state.processAnchor.controlChannelRef,
    ready: {
      type: 'ready',
      protocolVersion: state.processAnchor.protocolVersion,
      spawnNonceHash: state.processAnchor.spawnNonceHash,
      runtimeGeneration: state.processAnchor.runtimeGeneration,
      anchorIdentity: state.processAnchor.anchorIdentity,
      mainPidfdReady: true,
      ownedProcessGroupReady: true,
      ...readyOverrides,
    },
    response: {
      type: 'drained',
      protocolVersion: state.processAnchor.protocolVersion,
      runtimeGeneration: state.processAnchor.runtimeGeneration,
      residualCount: 0,
      ...responseOverrides,
    },
    ...envelopeOverrides,
  };
}

const deviceCookie = (operation) => ({
  cookie: '__Secure-atd',
  operation,
  attributes: ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/api/hosted/v1/auth/renew'],
  domain: null,
});

const sessionCookie = (operation) => ({
  cookie: '__Host-ats',
  operation,
  attributes: ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'],
  domain: null,
});

function revokeAll(state, reason) {
  if (state.device) state.device.revokedReason = reason;
  for (const session of Object.values(state.sessions)) session.revokedReason = reason;
  state.mutationAdmission = false;
}

/**
 * Executable Phase 0 model. References are deliberately symbolic: the model never creates or emits
 * a credential value. Persistent records survive restart; process-local readiness does not.
 */
export function authTransition(input, action) {
  const state = structuredClone(input);
  const reject = (code) => ({ state, outcome: 'rejected', code });
  const accept = (code) => ({ state, outcome: 'accepted', code });

  switch (action.type) {
    case 'bootstrap':
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (state.device && !state.device.revokedReason) return accept('existing_device_reused');
      {
        const drainError = validateDrainEvidence(state, action.drainEvidence, 'pairing', 0);
        if (drainError) return reject(drainError);
      }
      state.processAnchor.status = 'drained';
      state.challenge = { ref: `challenge-ref-${state.resetGeneration}`, consumed: false };
      return accept('challenge_issued');
    case 'pair':
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (!state.challenge || state.challenge.consumed) return reject('challenge_invalid');
      state.challenge.consumed = true;
      state.device = { familyRef: 'device-family-ref-1', generation: 1, predecessor: null };
      state.sessions = { 'session-ref-1': { generation: 1, active: true } };
      state.mutationAdmission = true;
      advanceProcessAnchorGeneration(state);
      return {
        ...accept('paired_device_and_session'),
        cookieTransitions: [deviceCookie('set'), sessionCookie('set')],
      };
    case 'restart':
      state.processEpoch += 1;
      state.mutationAdmission = !state.resetIntent && activeAuthorityExists(state);
      return accept(state.mutationAdmission ? 'authority_reloaded' : 'auth_not_ready');
    case 'lose_keyring':
      state.keyring = { status: 'missing', keyId: null };
      state.mutationAdmission = false;
      return accept('keyring_marked_missing');
    case 'expire_session': {
      const session = state.sessions[action.sessionRef];
      if (!session) return reject('session_unknown');
      session.active = false;
      session.expiredBy = action.deadline;
      state.mutationAdmission = false;
      return accept('session_expired');
    }
    case 'renew': {
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (!state.device || state.device.revokedReason) return reject('device_revoked');
      const current = state.device.generation;
      const predecessor = state.device.predecessor;
      const currentAccepted = action.presentedGeneration === current;
      const graceAccepted =
        predecessor?.generation === action.presentedGeneration && predecessor.remainingUses > 0;
      if (!currentAccepted && !graceAccepted) {
        revokeAll(state, 'predecessor_replay_outside_grace');
        return reject('device_family_revoked_replay');
      }
      state.device.predecessor = { generation: current, remainingUses: 1 };
      state.device.generation = current + 1;
      for (const session of Object.values(state.sessions)) {
        if (session.active) {
          session.active = false;
          session.revokedReason = 'session_rotation';
        }
      }
      const sessionRef = `session-ref-${state.device.generation}`;
      state.sessions[sessionRef] = { generation: state.device.generation, active: true };
      state.mutationAdmission = true;
      return {
        ...accept(graceAccepted ? 'predecessor_grace_rotated_forward' : 'device_rotated'),
        cookieTransitions: [deviceCookie('rotate'), sessionCookie('rotate')],
        response: action.responseLost
          ? { delivered: false, sessionRef: null, deviceGeneration: null }
          : { delivered: true, sessionRef, deviceGeneration: state.device.generation },
      };
    }
    case 'logout':
      if (state.sessions[action.sessionRef]) {
        state.sessions[action.sessionRef].revokedReason = 'logout';
        state.sessions[action.sessionRef].active = false;
      }
      state.mutationAdmission = false;
      return { ...accept('session_revoked'), cookieTransitions: [sessionCookie('clear')] };
    case 'forget_device':
      revokeAll(state, 'forget_device');
      return {
        ...accept('device_family_revoked'),
        cookieTransitions: [deviceCookie('clear'), sessionCookie('clear')],
      };
    case 'begin_reset':
      if (action.generation <= state.resetGeneration) return reject('reset_generation_not_newer');
      state.mutationAdmission = false;
      state.resetIntent = {
        generation: action.generation,
        stage: 'requested',
        drainEvidence: null,
      };
      return accept('reset_requested');
    case 'record_drain_evidence': {
      const intent = state.resetIntent;
      if (!intent) return reject('reset_not_requested');
      const drainError = validateDrainEvidence(
        state,
        action.evidence,
        'host_reset',
        intent.generation
      );
      if (drainError) {
        intent.stage = 'draining';
        return reject(drainError);
      }
      intent.stage = 'drained';
      intent.drainEvidence = structuredClone(action.evidence);
      state.processAnchor.status = 'drained';
      return accept('typed_drain_recorded');
    }
    case 'advance_reset': {
      const intent = state.resetIntent;
      if (!intent) return reject('reset_not_requested');
      if (['requested', 'draining'].includes(intent.stage)) {
        intent.stage = 'draining';
        return reject('typed_drain_required');
      }
      if (intent.stage === 'drained') {
        const drainError = validateDrainEvidence(
          state,
          intent.drainEvidence,
          'host_reset',
          intent.generation,
          true
        );
        if (drainError) return reject(drainError);
        intent.stage = 'new_key_staged';
        return accept('new_key_staged');
      }
      if (intent.stage === 'new_key_staged') {
        revokeAll(state, 'host_reset');
        intent.stage = 'authority_revoked';
        return accept('authority_revoked');
      }
      if (intent.stage === 'authority_revoked') {
        state.resetGeneration = intent.generation;
        state.keyring = { status: 'ready', keyId: `key-ref-reset-${intent.generation}` };
        intent.stage = 'key_activated';
        return accept('key_activated');
      }
      if (intent.stage === 'key_activated') {
        state.challenge = { ref: `challenge-ref-${intent.generation}`, consumed: false };
        intent.stage = 'challenge_issued';
        return accept('challenge_issued');
      }
      if (intent.stage === 'challenge_issued') {
        state.resetIntent = null;
        return accept('reset_completed');
      }
      throw new Error(`unknown reset stage: ${intent.stage}`);
    }
    default:
      throw new Error(`unknown auth action: ${action.type}`);
  }
}

export function runAuthSchedule(actions) {
  let state = newAuthState();
  const trace = [];
  for (const action of actions) {
    const result = authTransition(state, action);
    state = result.state;
    trace.push({ action: action.type, outcome: result.outcome, code: result.code });
  }
  return { state, trace };
}

const multiValue = (value) =>
  Array.isArray(value) || (typeof value === 'string' && value.includes(','));

/** Security-order spike: all rejection paths return before cookie/body/idempotency work. */
export function evaluateProxyRequest(request, config) {
  const rejected = (code, stage) => ({
    accepted: false,
    code,
    stage,
    cookieLookup: false,
    bodyParsed: false,
    idempotencyClaimed: false,
  });
  if (request.surface && request.surface !== 'browser') {
    return rejected('browser_runtime_trust_surfaces_disjoint', 'surface');
  }
  let publicOrigin;
  try {
    publicOrigin = new URL(config.publicOrigin);
  } catch {
    return rejected('public_origin_invalid', 'readiness');
  }
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash
  ) {
    return rejected('public_origin_invalid', 'readiness');
  }
  if (config.corsOrigin !== publicOrigin.origin) {
    return rejected('cors_origin_must_equal_public_origin', 'readiness');
  }

  const forwarded = request.forwarded ?? {};
  const hasForwarded = Object.values(forwarded).some(Boolean);
  const trustedProxy = config.trustedProxyPeers.includes(request.peer);
  if (hasForwarded && !trustedProxy) return rejected('forwarded_header_spoof', 'transport');
  if (multiValue(forwarded.proto) || multiValue(forwarded.host)) {
    return rejected('ambiguous_forwarded_authority', 'transport');
  }
  const secure = request.socketEncrypted || (trustedProxy && forwarded.proto === 'https');
  if (!secure) return rejected('direct_http_forbidden', 'transport');
  const authority = trustedProxy ? forwarded.host : request.host;
  if (authority !== publicOrigin.host) return rejected('unexpected_authority', 'authority');
  if (request.browserRequest && request.origin !== publicOrigin.origin) {
    return rejected(request.origin ? 'unexpected_origin' : 'origin_required', 'origin');
  }
  return {
    accepted: true,
    code: 'origin_and_authority_accepted',
    stage: 'auth_next',
    cookieLookup: false,
    bodyParsed: false,
    idempotencyClaimed: false,
  };
}

export function evaluateAuthorityCookieInput(input) {
  const rejected = (code) => ({ accepted: false, code, cookieLookup: false });
  if (input.headerBytes > input.maxHeaderBytes) return rejected('cookie_header_oversized');
  if (input.parseStatus !== 'parsed') return rejected('cookie_header_malformed');
  const authorityNames = new Set(['__Secure-atd', '__Host-ats']);
  const seen = new Set();
  for (const name of input.cookieNames) {
    if (!authorityNames.has(name)) continue;
    if (seen.has(name)) return rejected('duplicate_authority_cookie');
    seen.add(name);
  }
  return { accepted: true, code: 'cookie_shape_accepted', cookieLookup: false };
}

export function scanStandalone(root = repoRoot) {
  const pkg = JSON.parse(read(root, 'package.json'));
  const standaloneConfig = read(root, 'docker/vite.standalone.config.ts');
  const electronConfig = read(root, 'electron.vite.config.ts');
  const standaloneEntry = read(root, 'src/main/standalone.ts');
  const httpServer = read(root, 'src/main/services/infrastructure/HttpServer.ts');
  const dockerfile = read(root, 'docker/Dockerfile');
  const compose = read(root, 'docker/docker-compose.yml');
  const routeIndex = read(root, 'src/main/http/index.ts');
  const terminalNodePackage = read(
    root,
    'vendor/terminal-platform/terminal-platform-node-stub/package.json'
  );
  const migrations = read(
    root,
    'src/features/internal-storage/main/infrastructure/worker/internalStorageMigrations.ts'
  );
  const buildRoot = join(root, 'dist-standalone');
  const buildFiles = walk(buildRoot).filter((path) => path.endsWith('.cjs'));
  const buildText = buildFiles
    .map((path) => readFileSync(join(buildRoot, path), 'utf8'))
    .join('\n');

  return {
    schemaVersion: 1,
    recordType: 'w6-observed-artifact-scan',
    phaseStartSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    source: {
      standaloneInput: 'src/main/standalone.ts',
      rendererOutput: 'out/renderer',
      externalPackages: ['fastify', '@fastify/cors', '@fastify/static', 'agent-teams-controller'],
      nativeCatchAllEmptyStub:
        standaloneConfig.includes("source.endsWith('.node')") &&
        standaloneConfig.includes('export default {}'),
      broadElectronStub: standaloneConfig.includes('function electronStub()'),
      standaloneServiceStubs:
        standaloneEntry.includes('updaterServiceStub') &&
        standaloneEntry.includes('sshConnectionManagerStub'),
      terminalNodeInstallStub: terminalNodePackage.includes('Install-time stub'),
      terminalRuntimeArtifactPresent: walk(join(root, 'resources/terminal-platform')).some(
        (path) => path !== '.gitkeep'
      ),
      standaloneWorkerEntry: standaloneConfig.includes("'internal-storage-worker':"),
      electronWorkerEntry: electronConfig.includes("'internal-storage-worker':"),
      internalWorkerRuntimeFilename: 'internal-storage-worker.cjs',
      defaultWildcardCors:
        standaloneEntry.includes("process.env.CORS_ORIGIN = '*'") &&
        httpServer.includes('origin: true, credentials: true'),
      directHttpPublished: compose.includes('"3456:3456"') && dockerfile.includes('EXPOSE 3456'),
      productionNodeModulesCopiedWhole: dockerfile.includes(
        'COPY --from=prod-deps /app/node_modules ./node_modules'
      ),
      terminalPackages: Object.keys(pkg.dependencies)
        .filter(
          (name) => name.startsWith('@terminal-platform/') || name === 'terminal-platform-node'
        )
        .sort(),
      cookiePlugin: pkg.dependencies['@fastify/cookie'] ?? null,
      versions: {
        fastify: pkg.dependencies.fastify,
        fastifyCors: pkg.dependencies['@fastify/cors'],
        betterSqlite3: pkg.dependencies['better-sqlite3'],
        electron: pkg.devDependencies.electron,
        node: pkg.engines?.node ?? '24.x (from Docker ARG and .node-version)',
      },
      terminalHttpRegistration: /terminal/i.test(routeIndex),
      terminalMigration: /terminal/i.test(migrations),
    },
    emitted: {
      observed: buildFiles.length > 0,
      files: buildFiles.sort().map((path) => ({
        path: `dist-standalone/${path}`,
        bytes: statSync(join(buildRoot, path)).size,
        sha256: sha256(join(buildRoot, path)),
      })),
      internalStorageWorkerPresent: buildFiles.some((path) =>
        path.endsWith('internal-storage-worker.cjs')
      ),
      electronEmptyStubPresent:
        buildText.includes('isEncryptionAvailable: () => false') &&
        buildText.includes('decryptString: () => ""'),
      terminalServiceMarkerPresent: buildText.includes('class PtyTerminalService'),
      terminalPlatformMarkerPresent: buildText.includes('terminal-platform-node'),
    },
  };
}

export function evaluateV1TerminalAbsence(scan) {
  const violations = [];
  if (scan.source.terminalPackages.length)
    violations.push('terminal_sdk_dependencies_in_production_manifest');
  if (scan.source.terminalNodeInstallStub) violations.push('terminal_node_install_stub');
  if (scan.source.productionNodeModulesCopiedWhole)
    violations.push('unpruned_production_node_modules');
  if (scan.source.terminalHttpRegistration) violations.push('terminal_http_route_registered');
  if (scan.source.terminalMigration) violations.push('terminal_migration_present');
  if (scan.source.terminalRuntimeArtifactPresent)
    violations.push('terminal_runtime_artifact_present');
  if (scan.emitted.terminalServiceMarkerPresent)
    violations.push('terminal_service_in_server_bundle');
  if (scan.emitted.terminalPlatformMarkerPresent)
    violations.push('terminal_platform_in_server_bundle');
  return { passes: violations.length === 0, violations };
}

const REQUIRED_ARTIFACT_OWNERS = new Map([
  ['hosted-server', 'w6'],
  ['hosted-renderer', 'w6'],
  ['internal-storage-worker', 'w6'],
  ['node-sqlite-addon', 'w6'],
  ['agent-teams-controller-helper', 'w6'],
  ['agent-teams-mcp-helper', 'w6'],
  ['agent-teams-instance-lock', 'w4'],
  ['agent-teams-workspace-guard', 'w4'],
  ['agent-teams-process-anchor', 'w4'],
]);

const W4_NATIVE_ARTIFACTS = new Map([
  [
    'agent-teams-instance-lock',
    {
      targetPath: '/opt/agent-teams/bin/agent-teams-instance-lock',
      protocolManifestPath:
        'docs/research/hosted-web/phase-0/host-primitives/instance-lock.protocol.json',
      protocolSha256: 'ded8949371646d490ba5175cf2992cb308df6fdca44537d91d728345be3b139f',
      spikeSourcePath:
        'scripts/hosted-web/phase-0/host-primitives/instance-lock/instance_lock_spike.c',
      spikeSourceSha256: 'd9cc83ae82e3a1c11e654db39ecf6ddceea78f23f455db707cb5876652118c57',
      imageOrder: 'pre_node',
    },
  ],
  [
    'agent-teams-workspace-guard',
    {
      targetPath: '/opt/agent-teams/bin/agent-teams-workspace-guard',
      protocolManifestPath:
        'docs/research/hosted-web/phase-0/host-primitives/workspace-guard.protocol.json',
      protocolSha256: 'd73abe4570fb87f42824c22e84a184fd617bd42384f097e4fae341c1d33b02c3',
      spikeSourcePath:
        'scripts/hosted-web/phase-0/host-primitives/workspace-guard/workspace_guard_spike.c',
      spikeSourceSha256: '66f7c58d1188fd8d4be09bdd890458002dbbe40bf94b153155f1f9a54366ab43',
      imageOrder: 'per_admitted_workspace_effect',
    },
  ],
  [
    'agent-teams-process-anchor',
    {
      targetPath: '/opt/agent-teams/bin/agent-teams-process-anchor',
      protocolManifestPath:
        'docs/research/hosted-web/phase-0/host-primitives/process-anchor.protocol.json',
      protocolSha256: 'c3c7a381ed6e0550d52b43ff0abcc125d09137f566011eb1aac72b99618659db',
      spikeSourcePath:
        'scripts/hosted-web/phase-0/host-primitives/process-anchor/process_anchor_spike.c',
      spikeSourceSha256: '655ab14fbdf86e644b42692c78ec3ca6d8a6d496e93a230830d4ace9a69ba8a4',
      imageOrder: 'after_lease_before_provider_spawn',
    },
  ],
]);

const hasOwn = (value, key) => Object.hasOwn(value ?? {}, key);

function requireProperties(violations, value, prefix, properties) {
  for (const property of properties) {
    if (!hasOwn(value, property)) violations.push(`${prefix}:${property}`);
  }
}

export function evaluateHostedArtifactContract(contract) {
  const violations = [];
  if (contract.recordType !== 'w6-hosted-artifact-contract') violations.push('record_type');
  if (contract.target?.runtime !== 'node24-linux-x64') violations.push('target_runtime');
  if (contract.target?.nodeModuleAbi !== Number(process.versions.modules)) {
    violations.push('node_abi');
  }
  if (
    !contract.target?.nonRoot ||
    !contract.target?.minimalInit ||
    !contract.target?.finalSeccomp
  ) {
    violations.push('final_topology');
  }
  requireProperties(violations, contract.target, 'target_shape', [
    'uid',
    'gid',
    'initOrder',
    'seccompProfileSha256',
    'imageDigest',
  ]);
  if (contract.target?.initOrder?.[0] !== 'agent-teams-instance-lock') {
    violations.push('launcher_not_first');
  }
  const build = contract.nativeBuildContract;
  requireProperties(violations, build, 'native_build_shape', [
    'recipeId',
    'builderImageDigest',
    'compilerIdentity',
    'targetAbi',
    'compileFlags',
    'deterministicBuildsRequired',
  ]);
  if (build?.recipeId !== 'w4-native-c17-v1') violations.push('native_build_recipe');
  if (build?.deterministicBuildsRequired !== 2) violations.push('native_determinism');
  const imageEvidence = contract.finalImageEvidence;
  requireProperties(violations, imageEvidence, 'final_image_evidence_shape', [
    'compilerPresent',
    'sourcePresent',
    'headersPresent',
    'objectFilesPresent',
    'buildCachePresent',
  ]);
  const rows = new Map((contract.artifacts ?? []).map((row) => [row.id, row]));
  for (const [id, producerOwner] of REQUIRED_ARTIFACT_OWNERS) {
    const row = rows.get(id);
    if (!row) {
      violations.push(`missing_artifact:${id}`);
      continue;
    }
    if (row.producerOwner !== producerOwner || row.packagingOwner !== 'w6') {
      violations.push(`artifact_owner:${id}`);
    }
    if (!row.targetPath || !row.probe || !Object.hasOwn(row, 'sha256')) {
      violations.push(`artifact_shape:${id}`);
    }
    const w4 = W4_NATIVE_ARTIFACTS.get(id);
    if (w4) {
      requireProperties(violations, row, `native_artifact_shape:${id}`, [
        'protocolManifestPath',
        'protocolSha256',
        'spikeSourcePath',
        'spikeSourceSha256',
        'buildRecipeId',
        'builderImageDigest',
        'compilerIdentity',
        'targetAbi',
        'uid',
        'gid',
        'mode',
        'stripped',
        'twoCleanBuildsMatch',
        'imageOrder',
        'seccompProbe',
        'abiLoadProbe',
      ]);
      for (const key of [
        'targetPath',
        'protocolManifestPath',
        'protocolSha256',
        'spikeSourcePath',
        'spikeSourceSha256',
        'imageOrder',
      ]) {
        if (row[key] !== w4[key]) violations.push(`native_artifact_value:${id}:${key}`);
      }
      if (row.buildRecipeId !== 'w4-native-c17-v1') {
        violations.push(`native_artifact_value:${id}:buildRecipeId`);
      }
    }
  }
  const targets = [...rows.values()].map(({ targetPath }) => targetPath);
  if (new Set(targets).size !== targets.length) violations.push('duplicate_target_path');
  if (targets.some((path) => /terminal/i.test(path))) violations.push('terminal_target');
  const unresolved = [...rows.values()].filter(
    (row) =>
      row.emitted !== true ||
      !/^[0-9a-f]{64}$/.test(row.sha256 ?? '') ||
      row.probe !== 'passed' ||
      (row.producerOwner === 'w4' &&
        (row.builderImageDigest !== build?.builderImageDigest ||
          row.compilerIdentity !== build?.compilerIdentity ||
          row.targetAbi !== build?.targetAbi ||
          row.uid !== contract.target?.uid ||
          row.gid !== contract.target?.gid ||
          row.mode !== '0755' ||
          row.stripped !== true ||
          row.twoCleanBuildsMatch !== true ||
          row.seccompProbe !== 'passed' ||
          row.abiLoadProbe !== 'passed'))
  );
  const releaseImageEvidenceComplete =
    imageEvidence?.compilerPresent === false &&
    imageEvidence?.sourcePresent === false &&
    imageEvidence?.headersPresent === false &&
    imageEvidence?.objectFilesPresent === false &&
    imageEvidence?.buildCachePresent === false &&
    /^[0-9a-f]{64}$/.test(contract.target?.imageDigest ?? '') &&
    /^[0-9a-f]{64}$/.test(contract.target?.seccompProfileSha256 ?? '') &&
    /^[0-9a-f]{64}$/.test(build?.builderImageDigest ?? '') &&
    typeof build?.compilerIdentity === 'string' &&
    build.compilerIdentity.length > 0;
  return {
    contractPasses: violations.length === 0,
    releasePasses:
      violations.length === 0 && unresolved.length === 0 && releaseImageEvidenceComplete,
    violations,
    unresolvedArtifactIds: unresolved.map(({ id }) => id).sort(),
  };
}

export function evaluateFinalImageTerminalAbsence(image) {
  const violations = [];
  const surfaces = [
    ['package', image.packages],
    ['file', image.files],
    ['route', image.routes],
    ['migration', image.migrations],
    ['capability', image.capabilities],
    ['process', image.processes],
    ['renderer_chunk', image.rendererChunks],
    ['port', image.ports],
    ['volume', image.volumes],
  ];
  for (const [kind, values] of surfaces) {
    if (!Array.isArray(values)) {
      violations.push(`unscanned_surface:${kind}`);
      continue;
    }
    for (const value of values) {
      if (/terminal|pty|xterm/i.test(String(value))) violations.push(`${kind}:${value}`);
    }
  }
  return { passes: violations.length === 0, violations };
}

function sqliteProbe(packageName, databasePath) {
  const Database = localRequire(packageName);
  let database = new Database(databasePath);
  database.exec('CREATE TABLE abi_probe(value TEXT NOT NULL)');
  database.prepare('INSERT INTO abi_probe(value) VALUES (?)').run(packageName);
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();
  database = new Database(databasePath, { readonly: true });
  const reopenedValue = database.prepare('SELECT value FROM abi_probe').get().value;
  database.close();
  const packageJson = JSON.parse(
    readFileSync(localRequire.resolve(`${packageName}/package.json`), 'utf8')
  );
  return { packageName, version: packageJson.version, sqliteVersion, reopenedValue };
}

export function runAbiSmokeProbe() {
  const directory = mkdtempSync(join(tmpdir(), 'w6-abi-probe-'));
  try {
    const rebuildRequire = createRequire(localRequire.resolve('@electron/rebuild'));
    const nodeAbi = rebuildRequire('node-abi');
    const electronVersion = JSON.parse(
      readFileSync(localRequire.resolve('electron/package.json'), 'utf8')
    ).version;
    return {
      runtime: {
        node: process.versions.node,
        nodeModuleAbi: Number(process.versions.modules),
        napi: Number(process.versions.napi),
        electron: electronVersion,
        electronModuleAbi: Number(nodeAbi.getAbi(electronVersion, 'electron')),
      },
      sqlite: [
        sqliteProbe('better-sqlite3', join(directory, 'production.sqlite')),
        sqliteProbe('better-sqlite3-node', join(directory, 'node-alias.sqlite')),
      ],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const outputArg = process.argv.indexOf('--output');
  const scan = scanStandalone(repoRoot);
  const output = `${JSON.stringify({ ...scan, terminalAbsence: evaluateV1TerminalAbsence(scan) }, null, 2)}\n`;
  if (outputArg >= 0) writeFileSync(resolve(repoRoot, process.argv[outputArg + 1]), output);
  else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
