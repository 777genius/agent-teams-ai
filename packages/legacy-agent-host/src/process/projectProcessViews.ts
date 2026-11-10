import type { ProcessCommandReceipt, TeamProcessView } from './registeredProcessContracts.js';
const fail = (): never => {
  throw new Error('process:hold');
};
/** Public view projection is an allowlist even for retained on-disk command results. */
export function projectProcessView(row: TeamProcessView): TeamProcessView {
  if (
    !row ||
    !['same-live', 'absent', 'stale', 'unknown', 'metadata-stopped'].includes(row.observation) ||
    typeof row.canTerminate !== 'boolean' ||
    !/^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(row.processRef) ||
    typeof row.id !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.registeredAt !== 'string' ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 1 ||
    row.pid > 0x7fffffff ||
    (row.canTerminate && (row.observation !== 'same-live' || row.pendingStop))
  )
    return fail();
  const pending = row.pendingStop;
  if (
    pending &&
    (!pending.commandId ||
      typeof pending.commandId !== 'string' ||
      !/^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(pending.originalProcessRef) ||
      !['unknown', 'accepted'].includes(pending.native))
  )
    return fail();
  const result: TeamProcessView = {
    id: row.id,
    pid: row.pid,
    label: row.label,
    registeredAt: row.registeredAt,
    processRef: row.processRef,
    observation: row.observation,
    canTerminate: row.canTerminate,
  };
  for (const key of ['url', 'command', 'registeredBy', 'stoppedAt'] as const) {
    const value = row[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) return fail();
      result[key] = value;
    }
  }
  if (row.port !== undefined) {
    if (!Number.isSafeInteger(row.port) || row.port < 1 || row.port > 65535) return fail();
    result.port = row.port;
  }
  if (pending)
    result.pendingStop = {
      commandId: pending.commandId,
      originalProcessRef: pending.originalProcessRef,
      native: pending.native,
    };
  return result;
}
export function projectProcessReceipt(row: ProcessCommandReceipt | null) {
  return row
    ? {
        commandId: row.commandId,
        operation: row.operation,
        phase: row.phase,
        state: { ...row.state },
        ...(row.processRef ? { originalProcessRef: row.processRef } : {}),
        ...(row.result
          ? {
              result: Array.isArray(row.result)
                ? row.result.map(projectProcessView)
                : projectProcessView(row.result),
            }
          : {}),
      }
    : null;
}
