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
  retainManagement?: (value: ClaudeManagementDiagnostic) => void | Promise<void>
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  let discard = false;
  const emit = (line: Buffer): void => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
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
