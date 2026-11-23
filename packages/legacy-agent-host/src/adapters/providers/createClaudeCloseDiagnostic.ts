import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { ManagementCommandError } from '../../management/commandRecords.js';
import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { RuntimeBinding } from '../../runtime/contracts.js';
import type { OpenCodeV2GraphPhase } from './OpenCodeV2EmbeddedGraph.js';
import type { OpenCodeCurrentnessPhase, OpenCodeCurrentnessStats } from './OpenCodeCurrentnessTiming.js';

const prefix = 'legacy-agent-host: claude-close ';
let stderrObserved = false;
const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const writeDiagnostic = (line: string): void => {
  if (!stderrObserved) {
    stderrObserved = true;
    process.stderr.on('error', () => { /* A diagnostic pipe cannot determine custody. */ });
  }
  process.stderr.write(line, () => { /* Async write failures are diagnostics only. */ });
};

const catalogRequestPhases = new Set(['queued', 'started', 'returned']);
/** Only joins the original RPC to its existing catalog queue; never grants custody. */
export function createOpenCodeCatalogDiagnostic(requestId: unknown,
  input: { providerId?: string | undefined; includeModels?: boolean | undefined },
  write: (line: string) => void = writeDiagnostic) {
  let identity: { requestIdHash: string; inputKind: string } | undefined;
  try {
    if (typeof requestId === 'string') identity = {
      requestIdHash: createHash('sha256').update(requestId, 'utf8').digest('hex'),
      inputKind: input.providerId !== undefined ? 'explicit-provider' : input.includeModels === true ? 'include-models' : 'directory',
    };
  } catch { /* A diagnostic construction failure cannot reject the catalog. */ }
  return (phase: 'queued' | 'started' | 'returned'): void => {
    try {
      if (identity && catalogRequestPhases.has(phase))
        write(`legacy-agent-host: opencode-catalog ${JSON.stringify({ ...identity, phase })}\n`);
    } catch { /* Observations never change the original queue or read outcome. */ }
  };
}

/** Captures identifiers once; neither current selectors nor provider error text enter stderr. */
export function createClaudeCloseDiagnostic(
  selected: RuntimeBinding,
  sessionRef: string,
  write: (line: string) => void = writeDiagnostic
): NonNullable<ClaudeConfig['observeClose']> {
  const binding = Object.freeze({ backendId: selected.backendId, teamId: selected.teamId,
    runId: selected.runId, memberId: selected.memberId, generation: selected.generation });
  const valid = [...Object.values(binding), sessionRef].every(safeId);
  let physicalConfirmed = false;
  let count = 0;
  return (observation) => {
    try {
      if (!valid || count >= 4) return;
      count++;
      if (observation.stage === 'custody') physicalConfirmed = observation.outcome === 'confirmed';
      const stage = `${observation.stage}-${observation.outcome}`;
      write(`${prefix}${JSON.stringify({ binding, sessionRef, stage, physicalConfirmed })}\n`);
    } catch { /* Logging never changes the existing close receipt or cleanup sequence. */ }
  };
}

export type ClaudeManagementStage = 'auth-cleanup' | 'host-metadata-guard' | 'host-metadata' | 'host-probe-guard' | 'host-probe'
  | 'host-cleanup' | 'host-result-current' | 'probe-target' | 'probe-current' | 'probe-aborted'
  | 'probe-namespace-held' | 'probe-live' | 'probe-metadata-missing' | 'probe-metadata-wait' | 'probe-host' | 'probe-native';
const managementStages = new Set<ClaudeManagementStage>(['auth-cleanup', 'host-metadata-guard', 'host-metadata', 'host-probe-guard', 'host-probe',
  'host-cleanup', 'host-result-current', 'probe-target', 'probe-current', 'probe-aborted', 'probe-namespace-held',
  'probe-live', 'probe-metadata-missing', 'probe-metadata-wait', 'probe-host', 'probe-native']);
const managementCodes = new Set(['invalid', 'conflict', 'busy', 'held']);
const nativeCodes = new Set(['claude.probe.invalid-config', 'claude.probe.cancelled', 'claude.probe.timeout',
  'claude.probe.invalid-response', 'claude.probe.output-limit', 'claude.probe.unavailable', 'claude.probe.cleanup-unconfirmed',
  'claude.metadata.invalid-config', 'claude.metadata.cancelled', 'claude.metadata.timeout',
  'claude.metadata.invalid-response', 'claude.metadata.unavailable', 'claude.metadata.cleanup-unconfirmed', 'cleanup-unconfirmed']);
/** Private observations only: no raw IDs, paths, error strings, stderr or auth enter the sink. */
export function createClaudeManagementDiagnostic(
  selected: { profileId: string; configRevision: string; environment: Record<string, string> },
  commandId?: string,
  write: (line: string) => void = writeDiagnostic
): (stage: ClaudeManagementStage, error: unknown) => void {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const identity = Object.freeze({ profileHash: hash([selected.profileId, selected.configRevision]),
    namespaceHash: hash([selected.environment.HOME, selected.environment.CLAUDE_CONFIG_DIR ?? null]),
    commandHash: commandId === undefined ? null : hash(commandId) });
  let count = 0;
  return (stage, error) => {
    try {
      if (count >= 4 || !managementStages.has(stage)) return;
      count++;
      const code = error instanceof ManagementCommandError && managementCodes.has(error.code)
        ? 'management.' + error.code
        : error instanceof Error && nativeCodes.has(error.message) ? error.message : 'unavailable';
      write(`legacy-agent-host: claude-management ${JSON.stringify({ ...identity, stage, code })}\n`);
    } catch { /* Observations never change admission, model results or physical cleanup. */ }
  };
}

export type MetadataReadStage = 'admission' | 'native-client' | 'identity' | 'plugins' | 'permissions' | 'mcp'
  | 'credential' | 'directory' | 'activation-wait' | 'current' | 'projection' | 'dispose' | 'result-current';
export const metadataFailureReasons: ReadonlySet<string> = new Set(['held', 'conflict', 'invalid', 'busy', 'deadline', 'cleanup_unknown',
  'transport_failure', 'authority_mismatch', 'disposed', 'http_failure', 'media_type', 'body_limit',
  'frame_limit', 'invalid_response', 'invalid_native_catalog', 'native_catalog_binding_mismatch',
  'capabilities_pending', 'unqualified_version', 'ABORT_ERR']);
const metadataReadStages = new Set<MetadataReadStage>(['admission', 'native-client', 'identity',
  'plugins', 'permissions', 'mcp', 'credential', 'directory', 'activation-wait', 'current',
  'projection', 'dispose', 'result-current']);

/** Catalog observation only; these captured facts never grant process or cleanup authority. */
export function createOpenCodeMetadataDiagnostic(
  selected: { profileId: string; configRevision: string },
  providerId?: string,
  write: (line: string) => void = writeDiagnostic
) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const identity = Object.freeze({ profileHash: hash([selected.profileId, selected.configRevision]),
    mode: providerId === undefined ? 'directory' : 'provider',
    providerHash: providerId === undefined ? null : hash(providerId) });
  let original: Readonly<{ pid: number; startIdentity: string }> | undefined;
  let closed = false;
  const emit = (stage: 'ready' | 'released' | 'cleanup-unknown') => {
    try {
      if (original) write(`legacy-agent-host: opencode-metadata ${JSON.stringify({ ...identity, ...original, stage })}\n`);
    } catch { /* Missing diagnostics cannot confirm custody or change the catalog result. */ }
  };
  return Object.freeze({
    readFailed(observation: {
      stage: MetadataReadStage; reason: string; elapsedMs: number;
      deadlineExpired: boolean; aborted: boolean | null;
    }): void {
      try {
        const { stage, reason, elapsedMs, deadlineExpired, aborted } = observation;
        if (!metadataReadStages.has(stage) ||
            (reason !== 'unknown' && !metadataFailureReasons.has(reason)) ||
            !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 3_600_000 ||
            typeof deadlineExpired !== 'boolean' || !(aborted === null || typeof aborted === 'boolean')) return;
        write('legacy-agent-host: opencode-metadata ' + JSON.stringify({
          ...identity, stage: 'read-failed', readStage: stage, reason, elapsedMs, deadlineExpired, aborted,
        }) + '\n');
      } catch { /* The original read error and cleanup do not depend on this diagnostic sink. */ }
    },
    ready(value: { pid: number; startIdentity: string }): void {
      if (original || closed || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !safeId(value.startIdentity)) return;
      original = Object.freeze({ pid: value.pid, startIdentity: value.startIdentity });
      emit('ready');
    },
    closed(confirmed: boolean): void {
      if (closed) return;
      closed = true;
      emit(confirmed ? 'released' : 'cleanup-unknown');
    },
  });
}

export type OpenCodeProbePhase = OpenCodeV2GraphPhase | OpenCodeCurrentnessPhase | 'run' | 'graph-start' | 'graph-done' | 'native-launch'
  | 'native-launch-returned' | 'native-endpoint-resolved' | 'startup-timer-aborted'
  | 'startup-parent-aborted' | 'startup-lifecycle-aborted' | 'startup-failed'
  | 'identity-start' | 'identity-request-start' | 'identity-custody-start' | 'identity-custody-returned' | 'identity-request-admitted'
  | `catalog-${1 | 2 | 3}-${'request-start' | 'custody-start' | 'custody-returned' | 'request-admitted' | 'lease-released'}`
  | `credential-${'catalog' | 'directory' | 'connect' | 'restore' | 'dispose'}-${'start' | 'returned'}`
  | 'credential-returned' | 'catalog-read-returned' | 'catalog-current-returned' | 'catalog-repeat'
  | 'attestation-observe-returned' | 'session-current-returned' | 'session-create-returned'
  | 'native-ready' | 'credential' | 'attestation' | 'attestation-returned' | 'session-create' | 'driver-open' | 'first-submit'
  | 'driver-open-returned' | 'first-submit-current-returned' | 'first-submit-returned';
const probePhases = new Set<OpenCodeProbePhase>(['run', 'graph-start', 'graph-done', 'native-launch',
  'graph-manifest-verified', 'graph-inventory-indexed', 'graph-census-returned',
  'graph-files-quarter', 'graph-files-half', 'graph-files-three-quarters', 'graph-files-returned',
  'native-launch-returned', 'native-endpoint-resolved', 'startup-timer-aborted',
  'startup-parent-aborted', 'startup-lifecycle-aborted', 'startup-failed',
  'identity-start', 'identity-request-start', 'identity-custody-start', 'identity-custody-returned', 'identity-request-admitted',
  'catalog-1-request-start', 'catalog-1-custody-start', 'catalog-1-custody-returned', 'catalog-1-request-admitted', 'catalog-1-lease-released',
  'catalog-2-request-start', 'catalog-2-custody-start', 'catalog-2-custody-returned', 'catalog-2-request-admitted', 'catalog-2-lease-released',
  'catalog-3-request-start', 'catalog-3-custody-start', 'catalog-3-custody-returned', 'catalog-3-request-admitted', 'catalog-3-lease-released',
  'credential-catalog-start', 'credential-catalog-returned', 'credential-directory-start', 'credential-directory-returned',
  'credential-connect-start', 'credential-connect-returned', 'credential-restore-start', 'credential-restore-returned',
  'credential-dispose-start', 'credential-dispose-returned', 'credential-returned',
  'catalog-read-returned', 'catalog-current-returned', 'catalog-repeat',
  'attestation-observe-returned', 'session-current-returned', 'session-create-returned',
  'native-ready', 'credential', 'attestation', 'attestation-returned', 'session-create', 'driver-open', 'first-submit',
  'driver-open-returned', 'first-submit-current-returned', 'first-submit-returned']);
const currentnessPhases = new Set<OpenCodeProbePhase>(['identity-currentness-summary',
  'catalog-1-currentness-summary', 'catalog-2-currentness-summary', 'catalog-3-currentness-summary',
  'credential-catalog-currentness-summary', 'credential-directory-currentness-summary', 'credential-connect-currentness-summary']);

function currentnessStats(value: unknown): OpenCodeCurrentnessStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields, 'currentCalls') ||
      !Object.hasOwn(fields, 'currentElapsedMs') || !fields.currentCalls || !fields.currentElapsedMs ||
      !('value' in fields.currentCalls) || !('value' in fields.currentElapsedMs)) return;
  const calls: unknown = fields.currentCalls.value, elapsed: unknown = fields.currentElapsedMs.value;
  if (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 0 || calls > 1_000_000 ||
      typeof elapsed !== 'number' || !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 3_600_000) return;
  return { currentCalls: calls, currentElapsedMs: elapsed };
}

const submitFailureCodes = new Set(['invalid-config', 'unavailable', 'dependency-unavailable', 'backpressure',
  'stale', 'unsupported', 'checkpoint-incompatible', 'checkpoint-missing', 'provider-failure', 'output-limit', 'unknown']);
interface ProbeSubmitSummary {
  readonly submitStatus: 'ok' | 'refused' | 'unclassified';
  readonly submitCode: string | null;
  readonly submitDelivery: 'known-not-sent' | 'unobserved';
}
function submitSummary(reply: unknown): ProbeSubmitSummary {
  const unobserved = { submitStatus: 'unclassified', submitCode: null, submitDelivery: 'unobserved' } as const;
  // Never reflect through a Proxy or inspect a success payload, even for diagnostics.
  if (!reply || typeof reply !== 'object' || types.isProxy(reply) || Array.isArray(reply)) return unobserved;
  const own = (key: string): unknown => {
    const field = Object.getOwnPropertyDescriptor(reply, key);
    return field && Object.hasOwn(field, 'value') ? field.value : undefined;
  };
  const ok = own('ok');
  if (ok === true) return { ...unobserved, submitStatus: 'ok' };
  if (ok !== false) return unobserved;
  const code = own('code'), delivery = own('delivery');
  return { submitStatus: 'refused', submitCode: typeof code === 'string' && submitFailureCodes.has(code) ? code : null,
    submitDelivery: delivery === 'known-not-sent' ? 'known-not-sent' : 'unobserved' };
}

/** Phase and bounded SPI return only; no provider acceptance, readiness, process identity or release authority. */
export function createOpenCodeProbeDiagnostic(
  selected: { profileId: string; configRevision: string },
  commandId: string,
  probeDigest: string,
  write: (line: string) => void = writeDiagnostic,
  now: () => number = () => performance.now()
): (phase: OpenCodeProbePhase, detail?: OpenCodeCurrentnessStats | { readonly ok: boolean }) => void {
  try {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const identity = Object.freeze({ profileHash: hash([selected.profileId, selected.configRevision]),
      commandHash: hash(commandId), probeDigest });
    const valid = typeof probeDigest === 'string' && /^[a-f0-9]{64}$/.test(probeDigest);
    const observed = new Set<OpenCodeProbePhase>();
    const summaries = new Set<OpenCodeProbePhase>();
    let started: number | undefined, count = 0;
    return (phase, detail) => {
      try {
        if (currentnessPhases.has(phase)) {
          const stats = currentnessStats(detail);
          if (!valid || started === undefined || !stats || summaries.has(phase)) return;
          summaries.add(phase);
          const at = now(), elapsedMs = Math.round(at - started);
          if (!Number.isFinite(at) || at < 0 || !Number.isSafeInteger(elapsedMs) ||
              elapsedMs < 0 || elapsedMs > 3_600_000) return;
          // Reference the last original phase; summaries never consume its sequence slots.
          write('legacy-agent-host: opencode-probe ' + JSON.stringify({ ...identity,
            phase, sequence: count, elapsedMs, ...stats }) + '\n');
          return;
        }
        if (detail !== undefined && phase !== 'first-submit-returned') return;
        if (!valid || count >= probePhases.size || !probePhases.has(phase) || observed.has(phase)) return;
        observed.add(phase); count++;
        if (count > 1 && started === undefined) return;
        const at = now();
        if (!Number.isFinite(at) || at < 0) return;
        started ??= at;
        const elapsedMs = Math.round(at - started);
        if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 3_600_000) return;
        write('legacy-agent-host: opencode-probe ' + JSON.stringify({ ...identity,
          phase, sequence: count, elapsedMs,
          ...(phase === 'first-submit-returned' ? submitSummary(detail) : {}) }) + '\n');
      } catch { /* Diagnostics cannot replace an original probe operation or error. */ }
    };
  } catch { return () => {}; }
}

const probeCloseRunStates = new Set(['not-started', 'pending', 'true', 'false', 'threw']);
const probeCloseOutcomes = new Set(['unobserved', 'succeeded', 'failed', 'cancelled', 'unknown']);
const probeCloseErrorClasses = new Set(['none', 'held', 'invalid', 'conflict', 'busy', 'unknown']);
const probeCloseStages = new Set(['request-drain', 'owner-client', 'driver-close', 'server-stop', 'namespace', 'close-result']);
const probeCloseReasons = new Set(['unconfirmed', 'threw', 'identity']);
const probeCloseCodes = new Set(['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'cleanup_unknown', 'authority_or_deadline', 'authority_mismatch', 'transport_failure',
  'http_failure', 'invalid_response', 'disposed']);

/** One already captured failed-close observation; no clock, authority read or error unwrapping. */
export function createOpenCodeProbeCloseDiagnostic(
  selected: { profileId: string; configRevision: string },
  commandId: string,
  probeDigest: string,
  write: (line: string) => void = writeDiagnostic
): (observation: unknown) => void {
  try {
    const profile = Object.getOwnPropertyDescriptor(selected, 'profileId');
    const revision = Object.getOwnPropertyDescriptor(selected, 'configRevision');
    if (!profile || !('value' in profile) || !revision || !('value' in revision) ||
        ![profile.value, revision.value, commandId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) ||
        typeof probeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(probeDigest)) return () => {};
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const identity = Object.freeze({ profileHash: hash([profile.value, revision.value]),
      commandHash: hash(commandId), probeDigest });
    let emitted = false;
    return observation => {
      try {
        if (emitted || !observation || typeof observation !== 'object' || Array.isArray(observation)) return;
        const fields = Object.getOwnPropertyDescriptors(observation);
        const read = (key: string): unknown => {
          const field = fields[key]; return field && 'value' in field ? field.value : undefined;
        };
        const runState = read('runState'), outcome = read('outcome'), errorClass = read('errorClass');
        const stage = read('stage'), reason = read('reason');
        const keys = ['probeDigest', 'runState', 'outcome', 'errorClass', 'stage', 'reason',
          ...(runState === 'threw' ? ['runErrorCode', 'runCauseCode'] : [])];
        if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => {
          const field = fields[key]; return !Object.hasOwn(fields, key) || !field || !('value' in field);
        }) ||
            read('probeDigest') !== probeDigest ||
            typeof runState !== 'string' || !probeCloseRunStates.has(runState) ||
            typeof outcome !== 'string' || !probeCloseOutcomes.has(outcome) ||
            typeof errorClass !== 'string' || !probeCloseErrorClasses.has(errorClass) ||
            typeof stage !== 'string' || !probeCloseStages.has(stage) ||
            typeof reason !== 'string' || !probeCloseReasons.has(reason)) return;
        const runErrorCode = read('runErrorCode'), runCauseCode = read('runCauseCode');
        if (runState === 'threw' && ![runErrorCode, runCauseCode].every(value =>
          value === null || typeof value === 'string' && probeCloseCodes.has(value))) return;
        const line = 'legacy-agent-host: opencode-probe-close-failed ' + JSON.stringify({
          ...identity, runState, outcome, errorClass, stage, reason,
          ...(runState === 'threw' ? { runErrorCode, runCauseCode } : {}),
        }) + '\n';
        if (Buffer.byteLength(line) > 768) return;
        emitted = true; // A lost sink write cannot select a later failure instead.
        write(line);
      } catch { /* Private observation cannot alter the original failed close or channel. */ }
    };
  } catch { return () => {}; }
}
