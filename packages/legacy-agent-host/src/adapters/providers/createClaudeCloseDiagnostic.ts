import { createHash } from 'node:crypto';
import { ManagementCommandError } from '../../management/commandRecords.js';
import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { RuntimeBinding } from '../../runtime/contracts.js';

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
