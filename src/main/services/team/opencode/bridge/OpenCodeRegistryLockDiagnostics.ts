import type { OpenCodeBridgeDiagnosticsSink } from './OpenCodeBridgeCommandClient';
import type { OpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandContract';

const PREFIX = '[opencode-registry-lock] ';
const OPERATIONS = new Set([
  'upsert_host',
  'remove_host',
  'endpoint_snapshot',
  'endpoint_confirm',
  'cursor_reap',
  'operation_pin',
  'operation_unpin',
  'retain_lease',
  'release_lease',
  'absent_recovery',
  'ensure_read',
  'refresh_read',
  'dispose_read',
  'dispose_host',
  'reconcile_snapshot',
  'reconcile_host',
  'reconcile_artifacts',
  'release_read',
]);
const KEYS = [
  'operation',
  'phase',
  'stage',
  'lockAttemptId',
  'pid',
  'processStartedAtMs',
  'atMs',
  'waitMs',
  'heldMs',
  'errorCode',
  'lockMtimeAgeMs',
];
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Accept only the payload-free debug vocabulary; raw stderr never reaches this sink. */
export async function appendRegistryLockDiagnostics(
  stderr: string,
  env: NodeJS.ProcessEnv,
  sink: OpenCodeBridgeDiagnosticsSink | null,
  envelope: OpenCodeBridgeCommandEnvelope<unknown>
): Promise<void> {
  if (env.CLAUDE_MULTIMODEL_DEBUG_OPENCODE_COMMAND !== '1' || !sink) return;
  for (const line of stderr
    .split('\n')
    .filter((row) => row.startsWith(PREFIX))
    .slice(-64)) {
    if (line.length > 1536) continue;
    try {
      const row: unknown = JSON.parse(line.slice(PREFIX.length));
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const value: Record<string, unknown> = Object.fromEntries(Object.entries(row));
      if (
        Object.keys(value).length !== KEYS.length ||
        KEYS.some((key) => !Object.hasOwn(value, key)) ||
        typeof value.operation !== 'string' ||
        !OPERATIONS.has(value.operation) ||
        typeof value.phase !== 'string' ||
        !['waiting', 'acquired', 'releasing', 'released', 'failed'].includes(value.phase) ||
        typeof value.stage !== 'string' ||
        !['acquire', 'callback', 'release'].includes(value.stage) ||
        typeof value.lockAttemptId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          value.lockAttemptId
        ) ||
        !nonnegative(value.pid) ||
        value.pid === 0 ||
        !nonnegative(value.atMs) ||
        !(value.processStartedAtMs === null || nonnegative(value.processStartedAtMs)) ||
        !nonnegative(value.waitMs) ||
        !nonnegative(value.heldMs) ||
        !(value.lockMtimeAgeMs === null || nonnegative(value.lockMtimeAgeMs)) ||
        !(
          value.errorCode === null ||
          (typeof value.errorCode === 'string' &&
            ['ELOCKED', 'ECOMPROMISED', 'OTHER'].includes(value.errorCode))
        )
      )
        continue;
      const body = envelope.body;
      const runId =
        body && typeof body === 'object' && 'runId' in body && typeof body.runId === 'string'
          ? body.runId
          : undefined;
      void sink
        .append({
          type: 'opencode_registry_lock',
          providerId: 'opencode',
          runId,
          severity: value.phase === 'failed' ? 'warning' : 'info',
          message: `OpenCode registry lock ${value.phase}`,
          data: { ...value, command: envelope.command, requestId: envelope.requestId },
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    } catch {
      /* Parsing or diagnostic storage cannot change bridge command outcomes. */
    }
  }
}
