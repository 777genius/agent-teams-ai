import { TextDecoder } from 'node:util';

const prefix = 'legacy-agent-host: claude-close ';
const stages = new Set([
  'custody-confirmed',
  'custody-unconfirmed',
  'custody-error',
  'sdk-close-completed',
  'sdk-close-error',
  'sdk-read-completed',
  'sdk-read-error',
  'capture-close-completed',
  'capture-close-error',
]);
const runtimeOpenPrefix = 'legacy-agent-host: runtime-open ';
const runtimeOpenPhases = {
  factory: new Set(['selection', 'authority', 'worktree', 'model-readiness', 'bindings',
    'endpoint', 'provider-prepare', 'provider-create', 'interactions', 'driver-open', 'driver-wrap']),
  runtime: new Set(['authority', 'driver-open', 'session-ref', 'publish', 'observe',
    'sealed-close', 'readiness', 'readiness-publish']),
};
const runtimeOpenCategories = new Set(['invalid', 'conflict', 'forbidden', 'held',
  'busy', 'aborted', 'deadline', 'unknown']);
export interface RuntimeOpenDiagnostic {
  readonly profileHash: string;
  readonly configurationHash: string;
  readonly source: 'factory' | 'runtime';
  readonly phase: string;
  readonly category: string;
  readonly observedAtMs: number;
}
const metadataPrefix = 'legacy-agent-host: opencode-metadata ';
const probePrefix = 'legacy-agent-host: opencode-probe ';
const probeClosePrefix = 'legacy-agent-host: opencode-probe-close-failed ';
const probeCloseRunStates = new Set(['not-started', 'pending', 'true', 'false', 'threw']);
const probeCloseOutcomes = new Set(['unobserved', 'succeeded', 'failed', 'cancelled', 'unknown']);
const probeCloseErrorClasses = new Set(['none', 'held', 'invalid', 'conflict', 'busy', 'unknown']);
const probeCloseStages = new Set(['request-drain', 'owner-client', 'driver-close', 'server-stop', 'namespace', 'close-result']);
const probeCloseReasons = new Set(['unconfirmed', 'threw', 'identity']);
const probeCloseCodes = new Set(['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
export interface OpenCodeProbeCloseDiagnostic {
  readonly profileHash: string;
  readonly commandHash: string;
  readonly probeDigest: string;
  readonly runState: string;
  readonly outcome: string;
  readonly errorClass: string;
  readonly stage: string;
  readonly reason: string;
  readonly runErrorCode?: string | null;
  readonly runCauseCode?: string | null;
}
const probePhases = new Set(['run', 'graph-start', 'graph-done', 'native-launch', 'native-ready',
  'credential', 'attestation', 'session-create', 'driver-open', 'first-submit']);
export interface OpenCodeProbeDiagnostic {
  readonly profileHash: string;
  readonly commandHash: string;
  readonly probeDigest: string;
  readonly phase: string;
  readonly sequence: number;
  readonly elapsedMs: number;
}
interface OpenCodeMetadataIdentity {
  readonly profileHash: string;
  readonly mode: 'directory' | 'provider';
  readonly providerHash: string | null;
}
interface OpenCodeMetadataLifecycleDiagnostic extends OpenCodeMetadataIdentity {
  readonly pid: number;
  readonly startIdentity: string;
  readonly stage: 'ready' | 'released' | 'cleanup-unknown';
}
interface OpenCodeMetadataReadFailureDiagnostic extends OpenCodeMetadataIdentity {
  readonly pid?: never;
  readonly startIdentity?: never;
  readonly stage: 'read-failed';
  readonly readStage: string;
  readonly reason: string;
  readonly elapsedMs: number;
  readonly deadlineExpired: boolean;
  readonly aborted: boolean | null;
}
export type OpenCodeMetadataDiagnostic =
  | OpenCodeMetadataLifecycleDiagnostic
  | OpenCodeMetadataReadFailureDiagnostic;
const metadataReadStages = new Set(['admission', 'native-client', 'identity', 'plugins',
  'permissions', 'mcp', 'credential', 'directory', 'activation-wait', 'current',
  'projection', 'dispose', 'result-current']);
const metadataReadReasons = new Set(['held', 'conflict', 'invalid', 'busy', 'deadline', 'cleanup_unknown',
  'transport_failure', 'authority_mismatch', 'disposed', 'http_failure', 'media_type', 'body_limit',
  'frame_limit', 'invalid_response', 'invalid_native_catalog', 'native_catalog_binding_mismatch',
  'capabilities_pending', 'unqualified_version', 'ABORT_ERR', 'unknown']);
const managementPrefix = 'legacy-agent-host: claude-management ';
const managementStages = new Set([
  'auth-cleanup',
  'host-metadata-guard',
  'host-metadata',
  'host-probe-guard',
  'host-probe',
  'host-cleanup',
  'host-result-current',
  'probe-target',
  'probe-current',
  'probe-aborted',
  'probe-namespace-held',
  'probe-live',
  'probe-metadata-missing',
  'probe-metadata-wait',
  'probe-host',
  'probe-native',
]);
const managementCodes = new Set([
  'management.invalid',
  'management.conflict',
  'management.busy',
  'management.held',
  'claude.probe.invalid-config',
  'claude.probe.cancelled',
  'claude.probe.timeout',
  'claude.probe.invalid-response',
  'claude.probe.output-limit',
  'claude.probe.unavailable',
  'claude.probe.cleanup-unconfirmed',
  'claude.metadata.invalid-config',
  'claude.metadata.cancelled',
  'claude.metadata.timeout',
  'claude.metadata.invalid-response',
  'claude.metadata.unavailable',
  'claude.metadata.cleanup-unconfirmed',
  'cleanup-unconfirmed',
  'unavailable',
]);
export interface ClaudeManagementDiagnostic {
  readonly profileHash: string;
  readonly namespaceHash: string;
  readonly commandHash: string | null;
  readonly stage: string;
  readonly code: string;
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bindingKeys = ['backendId', 'teamId', 'runId', 'memberId', 'generation'] as const;
type Binding = Readonly<Record<(typeof bindingKeys)[number], string>>;
export interface ClaudeCloseDiagnostic {
  readonly binding: Binding;
  readonly sessionRef: string;
  readonly stage: string;
  readonly physicalConfirmed: boolean;
}
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);

/** Private stderr is untrusted: discard everything except this bounded, fixed record shape. */
export function decodeClaudeCloseDiagnostics(
  retain: (value: ClaudeCloseDiagnostic) => void | Promise<void>,
  retainManagement?: (value: ClaudeManagementDiagnostic) => void | Promise<void>,
  retainMetadata?: (value: OpenCodeMetadataDiagnostic) => void | Promise<void>,
  retainProbe?: (value: OpenCodeProbeDiagnostic) => void | Promise<void>,
  retainRuntimeOpen?: (value: RuntimeOpenDiagnostic) => void | Promise<void>,
  retainProbeClose?: (value: OpenCodeProbeCloseDiagnostic) => void | Promise<void>
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  let discard = false;
  const emit = (line: Buffer): void => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      if (text.startsWith(runtimeOpenPrefix)) {
        if (!retainRuntimeOpen) return;
        const value: unknown = JSON.parse(text.slice(runtimeOpenPrefix.length));
        if (!exact(value, ['profileHash', 'configurationHash', 'source', 'phase', 'category', 'observedAtMs']) ||
            !hash(value.profileHash) || !hash(value.configurationHash) ||
            !(value.source === 'factory' || value.source === 'runtime') ||
            typeof value.phase !== 'string' || !runtimeOpenPhases[value.source].has(value.phase) ||
            typeof value.category !== 'string' || !runtimeOpenCategories.has(value.category) ||
            typeof value.observedAtMs !== 'number' || !Number.isSafeInteger(value.observedAtMs) ||
            value.observedAtMs < 0) return;
        const diagnostic: RuntimeOpenDiagnostic = Object.freeze({
          profileHash: value.profileHash, configurationHash: value.configurationHash,
          source: value.source, phase: value.phase, category: value.category,
          observedAtMs: value.observedAtMs,
        });
        void Promise.resolve(retainRuntimeOpen(diagnostic)).catch(() => {
          /* Diagnostic loss cannot settle an original Runtime open or cleanup. */
        });
        return;
      }
      if (text.startsWith(probeClosePrefix)) {
        if (!retainProbeClose || line.length + 1 > 768) return;
        const value: unknown = JSON.parse(text.slice(probeClosePrefix.length));
        const keys = ['profileHash', 'commandHash', 'probeDigest', 'runState', 'outcome', 'errorClass', 'stage', 'reason'];
        if (!exact(value, keys) && !exact(value, [...keys, 'runErrorCode', 'runCauseCode'])) return;
        if (!hash(value.profileHash) || !hash(value.commandHash) || !hash(value.probeDigest) ||
            typeof value.runState !== 'string' || !probeCloseRunStates.has(value.runState) ||
            typeof value.outcome !== 'string' || !probeCloseOutcomes.has(value.outcome) ||
            typeof value.errorClass !== 'string' || !probeCloseErrorClasses.has(value.errorClass) ||
            typeof value.stage !== 'string' || !probeCloseStages.has(value.stage) ||
            typeof value.reason !== 'string' || !probeCloseReasons.has(value.reason) ||
            (value.runState === 'threw') !== Object.hasOwn(value, 'runErrorCode')) return;
        const code = (field: unknown): field is string | null =>
          field === null || typeof field === 'string' && probeCloseCodes.has(field);
        let runCodes: { runErrorCode: string | null; runCauseCode: string | null } | undefined;
        if (value.runState === 'threw') {
          if (!code(value.runErrorCode) || !code(value.runCauseCode)) return;
          runCodes = { runErrorCode: value.runErrorCode, runCauseCode: value.runCauseCode };
        }
        const diagnostic: OpenCodeProbeCloseDiagnostic = Object.freeze({
          profileHash: value.profileHash, commandHash: value.commandHash, probeDigest: value.probeDigest,
          runState: value.runState, outcome: value.outcome, errorClass: value.errorClass,
          stage: value.stage, reason: value.reason,
          ...runCodes,
        });
        void Promise.resolve(retainProbeClose(diagnostic)).catch(() => {
          /* Failure observations never settle original probe cleanup or release debt. */
        });
        return;
      }
      if (text.startsWith(probePrefix)) {
        if (!retainProbe) return;
        const value: unknown = JSON.parse(text.slice(probePrefix.length));
        if (!exact(value, ['profileHash', 'commandHash', 'probeDigest', 'phase', 'sequence', 'elapsedMs']) ||
            !hash(value.profileHash) || !hash(value.commandHash) || !hash(value.probeDigest) ||
            typeof value.phase !== 'string' || !probePhases.has(value.phase) ||
            typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) ||
            value.sequence < 1 || value.sequence > 12 ||
            typeof value.elapsedMs !== 'number' || !Number.isSafeInteger(value.elapsedMs) ||
            value.elapsedMs < 0 || value.elapsedMs > 3_600_000) return;
        const diagnostic: OpenCodeProbeDiagnostic = Object.freeze({
          profileHash: value.profileHash, commandHash: value.commandHash, probeDigest: value.probeDigest,
          phase: value.phase, sequence: value.sequence, elapsedMs: value.elapsedMs,
        });
        void Promise.resolve(retainProbe(diagnostic)).catch(() => {
          /* Missing observations cannot settle the original probe or its cleanup. */
        });
        return;
      }
      if (text.startsWith(metadataPrefix)) {
        if (!retainMetadata) return;
        const value: unknown = JSON.parse(text.slice(metadataPrefix.length));
        if (exact(value, ['profileHash', 'mode', 'providerHash', 'stage', 'readStage', 'reason',
          'elapsedMs', 'deadlineExpired', 'aborted']) && value.stage === 'read-failed') {
          if (!hash(value.profileHash) || !(value.mode === 'directory' || value.mode === 'provider') ||
              !(value.providerHash === null || hash(value.providerHash)) ||
              ((value.mode === 'directory') !== (value.providerHash === null)) ||
              typeof value.readStage !== 'string' || !metadataReadStages.has(value.readStage) ||
              typeof value.reason !== 'string' || !metadataReadReasons.has(value.reason) ||
              typeof value.elapsedMs !== 'number' || !Number.isSafeInteger(value.elapsedMs) ||
              value.elapsedMs < 0 || value.elapsedMs > 3_600_000 ||
              typeof value.deadlineExpired !== 'boolean' ||
              !(value.aborted === null || typeof value.aborted === 'boolean')) return;
          const diagnostic: OpenCodeMetadataDiagnostic = Object.freeze({
            profileHash: value.profileHash, mode: value.mode, providerHash: value.providerHash,
            stage: 'read-failed', readStage: value.readStage, reason: value.reason,
            elapsedMs: value.elapsedMs, deadlineExpired: value.deadlineExpired, aborted: value.aborted,
          });
          void Promise.resolve(retainMetadata(diagnostic)).catch(() => {
            /* Failure diagnostics never determine the original read or cleanup outcome. */
          });
          return;
        }
        if (
          !exact(value, ['profileHash', 'mode', 'providerHash', 'pid', 'startIdentity', 'stage']) ||
          !hash(value.profileHash) ||
          !(value.mode === 'directory' || value.mode === 'provider') ||
          !(value.providerHash === null || hash(value.providerHash)) ||
          ((value.mode === 'directory') !== (value.providerHash === null)) ||
          typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
          !safeId(value.startIdentity) ||
          !(value.stage === 'ready' || value.stage === 'released' || value.stage === 'cleanup-unknown')
        )
          return;
        const diagnostic: OpenCodeMetadataDiagnostic = Object.freeze({
          profileHash: value.profileHash, mode: value.mode, providerHash: value.providerHash,
          pid: value.pid, startIdentity: value.startIdentity, stage: value.stage,
        });
        void Promise.resolve(retainMetadata(diagnostic)).catch(() => {
          /* A private observation never changes transport or cleanup outcomes. */
        });
        return;
      }
      if (text.startsWith(managementPrefix)) {
        if (!retainManagement) return;
        const value: unknown = JSON.parse(text.slice(managementPrefix.length));
        if (
          !exact(value, ['profileHash', 'namespaceHash', 'commandHash', 'stage', 'code']) ||
          !hash(value.profileHash) ||
          !hash(value.namespaceHash) ||
          !(value.commandHash === null || hash(value.commandHash)) ||
          typeof value.stage !== 'string' ||
          !managementStages.has(value.stage) ||
          typeof value.code !== 'string' ||
          !managementCodes.has(value.code)
        )
          return;
        const diagnostic = Object.freeze({
          profileHash: value.profileHash,
          namespaceHash: value.namespaceHash,
          commandHash: value.commandHash,
          stage: value.stage,
          code: value.code,
        });
        void Promise.resolve(retainManagement(diagnostic)).catch(() => {
          /* Never reject transport. */
        });
        return;
      }
      if (!text.startsWith(prefix)) return;
      const value: unknown = JSON.parse(text.slice(prefix.length));
      if (
        !exact(value, ['binding', 'sessionRef', 'stage', 'physicalConfirmed']) ||
        !exact(value.binding, bindingKeys) ||
        !Object.values(value.binding).every(safeId) ||
        !safeId(value.sessionRef) ||
        typeof value.stage !== 'string' ||
        !stages.has(value.stage) ||
        typeof value.physicalConfirmed !== 'boolean'
      )
        return;
      if (
        value.stage.startsWith('custody-') &&
        value.physicalConfirmed !== (value.stage === 'custody-confirmed')
      )
        return;
      const diagnostic = Object.freeze({
        binding: Object.freeze({ ...value.binding }) as Binding,
        sessionRef: value.sessionRef,
        stage: value.stage,
        physicalConfirmed: value.physicalConfirmed,
      });
      void Promise.resolve(retain(diagnostic)).catch(() => {
        /* Never reject transport. */
      });
    } catch {
      /* Malformed stderr and sink failures never determine command outcomes. */
    }
  };
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!discard) {
        if (pending.length + end - offset > 8192) {
          pending = Buffer.alloc(0);
          discard = true;
        } else pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
      }
      if (newline < 0) break;
      if (!discard) emit(pending);
      pending = Buffer.alloc(0);
      discard = false;
      offset = newline + 1;
    }
  };
}
