#!/usr/bin/env node
/* global process, setTimeout */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NOW = '2026-08-29T00:00:00.000Z';
const MODEL = 'deepinfra/deepseek-ai/DeepSeek-V3.2';
const CAPABILITY = 'issue443-capability-v2';
const SCENARIO = process.env.ISSUE443_FAKE_SCENARIO ?? 'valid';
const TRACE_FILE = process.env.ISSUE443_FAKE_TRACE_FILE;

if (!TRACE_FILE) throw new Error('ISSUE443_FAKE_TRACE_FILE is required');

const argv = process.argv.slice(2);
if (argv[0] === 'runtime' && argv[1] === 'status') {
  runProviderStatusCommand();
  process.exit(0);
}
if (argv[0] === 'runtime' && argv[1] === 'providers' && argv[2] === 'models') {
  await runProviderModelsCommand();
  process.exit(0);
}
if (argv[0] !== 'runtime' || argv[1] !== 'opencode-command') {
  rejectCommand('legacy full inventory/model/agent/plugin fanout is forbidden');
}

if (JSON.stringify(argv.slice(0, 3)) !== JSON.stringify(['runtime', 'opencode-command', '--json'])) {
  throw new Error(`Unexpected bridge argv prefix: ${JSON.stringify(argv)}`);
}

const inputPath = argumentValue('--input');
const outputPath = argumentValue('--output');
const inputRaw = readFileSync(inputPath, 'utf8');
const envelope = JSON.parse(inputRaw);
const baseTrace = {
  kind: 'bridge',
  pid: process.pid,
  argv,
  cwd: process.cwd(),
  inputPath,
  outputPath: outputPath ?? null,
  inputRaw,
  envelope,
  scenario: SCENARIO,
};

let data;
let proofValidation = null;
switch (envelope.command) {
  case 'opencode.handshake':
    data = handshake(envelope);
    break;
  case 'opencode.readiness':
    data = readiness(envelope.body);
    break;
  case 'opencode.commandStatus':
    data = {
      status: 'unknown',
      safeToRetry: false,
      accepted: false,
      originalRequestId: envelope.body.originalRequestId,
      diagnostics: ['fake executable has no authoritative completion record'],
    };
    break;
  case 'opencode.launchTeam':
    proofValidation = validateLaunchProof(envelope.body);
    if (!proofValidation.ok) {
      data = {
        runId: envelope.body.runId,
        teamLaunchState: 'failed',
        members: {},
        warnings: [],
        diagnostics: [{ code: 'fake_precondition_mismatch', severity: 'error', message: proofValidation.reason }],
        expectedBehaviorFingerprint: envelope.body.expectedBehaviorFingerprint,
        idempotencyKey: envelope.body.preconditions?.idempotencyKey,
        runtimeStoreManifestHighWatermark: 0,
        durableCheckpoints: [],
      };
      break;
    }
    data = successfulLaunch(envelope.body);
    break;
  default:
    throw new Error(`Unexpected fake bridge command ${envelope.command}`);
}

if (SCENARIO === 'unknown-outcome' && envelope.command === 'opencode.launchTeam') {
  trace({ ...baseTrace, proofValidation, outputRaw: '', sideEffectCommitted: true });
  process.exit(0);
}

const result = {
  ok: true,
  schemaVersion: 1,
  requestId: envelope.requestId,
  command: envelope.command,
  completedAt: NOW,
  durationMs: 0,
  runtime: runtimeSnapshot(envelope.body?.runId ?? null),
  diagnostics: [],
  data,
};
const outputRaw = `${JSON.stringify(result)}\n`;
if (outputPath) writeFileSync(outputPath, outputRaw, { mode: 0o600 });
else process.stdout.write(outputRaw);
trace({ ...baseTrace, proofValidation, outputRaw, sideEffectCommitted: envelope.command === 'opencode.launchTeam' });

function runProviderStatusCommand() {
  const expected = ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'];
  if (JSON.stringify(argv) !== JSON.stringify(expected)) {
    rejectCommand('only passive provider-scoped summary status is allowed');
  }
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex < 0 ? null : argv[providerIndex + 1];
  if (provider !== 'opencode') throw new Error(`Unexpected provider scope ${String(provider)}`);
  const payload = {
    providerId: 'opencode',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    canLoginFromUi: false,
    statusMessage: null,
    detailMessage: null,
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: [],
    modelCatalogRefreshState: 'loading',
    capabilities: { teamLaunch: false, oneShot: false, extensions: {} },
    backend: { kind: 'opencode', label: 'OpenCode' },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    modelCatalog: null,
  };
  const outputRaw = JSON.stringify({ schemaVersion: 2, providers: { opencode: payload } });
  trace({ kind: 'provider-status', pid: process.pid, argv, cwd: process.cwd(), outputRaw });
  process.stdout.write(outputRaw);
}

async function runProviderModelsCommand() {
  const runtimeIndex = argv.indexOf('--runtime');
  const providerIndex = argv.indexOf('--provider');
  const runtime = runtimeIndex < 0 ? null : argv[runtimeIndex + 1];
  const provider = providerIndex < 0 ? null : argv[providerIndex + 1];
  const allowedFlags = new Set([
    '--runtime',
    '--provider',
    '--json',
    '--project-path',
    '--query',
    '--limit',
    '--cursor',
  ]);
  for (const argument of argv) {
    if (argument.startsWith('--') && !allowedFlags.has(argument)) {
      rejectCommand(`unexpected provider-model flag ${argument}`);
    }
  }
  if (runtime !== 'opencode' || !provider) {
    rejectCommand(`expected a concrete OpenCode source provider, received ${String(provider)}`);
  }
  if (provider === 'kiro' || provider === 'cursor-acp') {
    rejectCommand(`poisoned ${provider} provider route must not be queried`);
  }

  const modelByProvider = {
    deepinfra: MODEL,
    opencode: 'opencode/nemotron-3-super-free',
  };
  const cursorIndex = argv.indexOf('--cursor');
  const cursor = cursorIndex < 0 ? null : argv[cursorIndex + 1];
  if (SCENARIO === 'slow-catalog' && provider === 'deepinfra' && !cursor) {
    trace({ kind: 'provider-models-request', pid: process.pid, argv, cwd: process.cwd(), outputRaw: '' });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  const paginated = SCENARIO === 'paginated-catalog' && provider === 'deepinfra';
  const modelId = paginated && cursor === 'deepinfra-page-2'
    ? 'deepinfra/deepseek-ai/DeepSeek-R1'
    : (modelByProvider[provider] ?? `${provider}/scoped-model`);
  const nextCursor = paginated && !cursor ? 'deepinfra-page-2' : null;
  const output = {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: provider,
      models: [{
        modelId,
        providerId: provider,
        displayName: modelId.slice(modelId.indexOf('/') + 1),
        sourceLabel: provider === 'deepinfra' ? 'DeepInfra' : provider,
        free: provider === 'opencode',
        default: provider === 'deepinfra',
        availability: 'available',
        accessKind: provider === 'opencode' ? 'builtin_free' : 'credentialed',
        routeKind: provider === 'opencode' ? 'builtin_free' : 'connected_provider',
        proofState: 'not_required',
        requiresExecutionProof: false,
        accessReason: null,
      }],
      defaultModelId: modelId,
      diagnostics: [],
      catalogState: SCENARIO === 'stale-catalog' ? 'stale' : 'fresh',
      totalCount: paginated ? 2 : 1,
      returnedCount: 1,
      limit: null,
      cursor,
      nextCursor,
    },
  };
  const outputRaw = JSON.stringify(output);
  trace({ kind: 'provider-models', pid: process.pid, argv, cwd: process.cwd(), outputRaw });
  process.stdout.write(outputRaw);
}

function rejectCommand(reason) {
  const outputRaw = `Rejected command: ${reason}`;
  trace({ kind: 'rejected', pid: process.pid, argv, cwd: process.cwd(), outputRaw });
  throw new Error(`${outputRaw}: ${JSON.stringify(argv)}`);
}

function handshake(envelope) {
  const client = envelope.body.client;
  const server = {
    schemaVersion: 1,
    peer: 'agent_teams_orchestrator',
    appVersion: 'issue443-independent-fake',
    gitSha: null,
    buildId: 'issue443-fake-v2',
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: ['opencode.handshake', 'opencode.commandStatus', 'opencode.readiness', 'opencode.launchTeam'],
      opencodeAppManagedBootstrapContractVersion: 1,
      expectedBehaviorFingerprintSchemaVersion: SCENARIO === 'handshake-v1' ? 1 : 2,
    },
    runtime: {
      ...runtimeSnapshot(envelope.body.expectedRunId),
      runtimeStoreManifestHighWatermark: SCENARIO === 'stale-manifest' ? -1 : 0,
      activeRunId: envelope.body.expectedRunId,
    },
    featureFlags: { opencodeTeamLaunch: true, opencodeStateChangingCommands: true },
  };
  const unsigned = {
    schemaVersion: 1,
    requestId: envelope.requestId,
    client,
    server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.launchTeam'],
    serverTime: NOW,
  };
  return { ...unsigned, identityHash: stableHash(unsigned) };
}

function readiness(body) {
  const evidence = behaviorEvidence(body.projectPath, body.selectedModel);
  const unsignedProof = {
    schemaVersion: 1,
    providerId: 'opencode',
    modelId: body.selectedModel,
    projectPath: body.projectPath,
    profileRootKey: 'issue443-disposable-profile',
    projectBehaviorFingerprint: evidence.projectBehaviorFingerprint,
    managedConfigFingerprint: evidence.effectiveConfigFingerprint,
    managedAuthFingerprint: evidence.effectiveSelectedAuthFingerprint,
    binaryPath: '/fake/opencode',
    binaryFingerprint: sha256('issue443-fake-binary'),
    opencodeVersion: '1.0.0-fake',
    capabilitySnapshotId: CAPABILITY,
    credentialMode: 'none',
    reusable: false,
    verifiedAt: NOW,
    expiresAt: SCENARIO === 'stale-proof' ? '2020-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
    expectedBehaviorEvidence: evidence,
  };
  return {
    state: 'ready',
    launchAllowed: true,
    modelId: body.selectedModel,
    availableModels: [body.selectedModel],
    opencodeVersion: '1.0.0-fake',
    installMethod: 'unknown',
    binaryPath: '/fake/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'production_supported',
    missing: [],
    diagnostics: [],
    executionProof: { ...unsignedProof, proofHash: sha256(stableJson(unsignedProof)) },
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: '/experimental/tool/ids',
      observedMcpTools: ['agent'],
      runtimeStoreReadinessReason: null,
    },
  };
}

function behaviorEvidence(projectPath, model) {
  const tuple = {
    canonicalProjectPathFingerprint: sha256(path.resolve(realpathSync(projectPath))),
    modelProviderId: model.split('/')[0],
    fullModelId: model,
    projectBehaviorFingerprint: sha256('issue443-project-behavior-v2'),
    effectiveConfigFingerprint: sha256('issue443-effective-config-v2'),
    effectiveSelectedAuthFingerprint: sha256('issue443-selected-auth-v2'),
  };
  return {
    ...tuple,
    expectedBehaviorFingerprint: sha256(JSON.stringify([
      'agent-teams.opencode.expected-behavior/v2',
      tuple.canonicalProjectPathFingerprint,
      tuple.modelProviderId,
      tuple.fullModelId,
      tuple.projectBehaviorFingerprint,
      tuple.effectiveConfigFingerprint,
      tuple.effectiveSelectedAuthFingerprint,
    ])),
  };
}

function validateLaunchProof(body) {
  const independentlyExpected = behaviorEvidence(body.projectPath, body.selectedModel).expectedBehaviorFingerprint;
  if (body.expectedBehaviorFingerprint !== independentlyExpected) return { ok: false, reason: 'body fingerprint mismatch' };
  if (body.preconditions?.expectedBehaviorFingerprint !== independentlyExpected) return { ok: false, reason: 'precondition fingerprint mismatch' };
  if (body.executionProof?.expectedBehaviorEvidence?.expectedBehaviorFingerprint !== independentlyExpected) return { ok: false, reason: 'execution proof fingerprint mismatch' };
  if (body.preconditions?.expectedRunId !== body.runId) return { ok: false, reason: 'run precondition mismatch' };
  if (body.preconditions?.expectedCapabilitySnapshotId !== CAPABILITY) return { ok: false, reason: 'capability precondition mismatch' };
  return { ok: true, independentlyExpected, membersObservedBeforeProof: false };
}

function successfulLaunch(body) {
  const fingerprint = SCENARIO === 'mismatch-echo' ? 'f'.repeat(64) : body.expectedBehaviorFingerprint;
  return {
    runId: body.runId,
    teamLaunchState: 'ready',
    members: {
      alice: { sessionId: 'issue443-fake-session', launchState: 'confirmed_alive', model: MODEL, evidence: [] },
    },
    warnings: [],
    diagnostics: [],
    expectedBehaviorFingerprint: fingerprint,
    idempotencyKey: body.preconditions.idempotencyKey,
    runtimeStoreManifestHighWatermark: 0,
    durableCheckpoints: ['required_tools_proven', 'delivery_ready', 'member_ready', 'run_ready']
      .map((name) => ({ name, observedAt: NOW })),
  };
}

function runtimeSnapshot(activeRunId) {
  return {
    providerId: 'opencode',
    binaryPath: '/fake/opencode',
    binaryFingerprint: sha256('issue443-fake-binary'),
    version: '1.0.0-fake',
    capabilitySnapshotId: CAPABILITY,
    activeRunId,
  };
}

function argumentValue(name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`Missing ${name}`);
  return argv[index + 1];
}

function stableHash(value) {
  return sha256(JSON.stringify(normalizeStable(value)));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeStable(value) {
  if (Array.isArray(value)) return value.map(normalizeStable);
  if (!value || typeof value !== 'object') return Number.isFinite(value) || typeof value !== 'number' ? value : String(value);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, normalizeStable(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function trace(entry) {
  appendFileSync(TRACE_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
