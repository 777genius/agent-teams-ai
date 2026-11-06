/** Public process records contain metadata and opaque original selections only. */
export interface BackendProcess {
  id: string;
  pid: number;
  label: string;
  registeredAt: string;
  stoppedAt?: string;
  registeredBy?: string;
  port?: number;
  url?: string;
  command?: string;
  processRef: string;
  observation: 'same-live' | 'absent' | 'stale' | 'unknown' | 'metadata-stopped';
  canTerminate: boolean;
  pendingStop?: { commandId: string; originalProcessRef: string; native: 'unknown' | 'accepted' };
}
export interface BackendProcessReceipt {
  commandId: string;
  operation: 'register' | 'metadata-stop' | 'unregister' | 'terminate';
  phase: 'prepared' | 'held' | 'completed' | 'rejected';
  originalProcessRef?: string;
  state:
    | { phase: 'prepared'; native: 'not-requested' }
    | { phase: 'requested'; native: 'unknown' | 'accepted' }
    | { phase: 'completed'; native: 'not-requested' }
    | { phase: 'completed'; native: 'observed-absent'; signalAccepted: boolean | 'unknown' }
    | { phase: 'refused'; native: 'not-requested' | 'refused' };
  result?: BackendProcess | BackendProcess[];
}
export interface BackendProcessOperationPayloads {
  'process.list': Record<string, never>;
  'process.pending.read': Record<string, never>;
  'process.lookup': { originalCommandId: string };
  'process.terminate': { processRef: string };
}
/** Existing UI stop carries its displayed original row; PID is display consistency only. */
export type ProcessStopSelection = import('@shared/types/team').CapturedTeamProcessStop;
export const isProcessRef = (value: unknown): value is string =>
  typeof value === 'string' && /^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(value);
export function assertOriginalProcessStop(
  value: unknown,
  original: { commandId: string; processRef: string }
): BackendProcessReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid original process outcome');
  const row = value as BackendProcessReceipt;
  if (
    row.commandId !== original.commandId ||
    row.operation !== 'terminate' ||
    row.originalProcessRef !== original.processRef ||
    !row.state ||
    !['requested', 'completed', 'refused'].includes(row.state.phase) ||
    (row.state.phase === 'requested' &&
      (!['accepted', 'unknown'].includes(row.state.native) || row.phase !== 'held')) ||
    (row.state.phase === 'completed' &&
      (row.state.native !== 'observed-absent' ||
        row.phase !== 'completed' ||
        !['unknown', true, false].includes(row.state.signalAccepted))) ||
    (row.state.phase === 'refused' &&
      (row.phase !== 'rejected' || !['not-requested', 'refused'].includes(row.state.native)))
  )
    throw new Error('Invalid original process outcome');
  return row;
}
export function readBackendProcess(value: unknown): BackendProcess {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid process record');
  const row = value as Record<string, unknown>;
  const text = (key: string, max = 4096) => {
    const found = row[key];
    if (typeof found !== 'string' || !found || found.length > max || found.includes('\0'))
      throw new Error('Invalid process metadata');
    return found;
  };
  if (
    !Number.isSafeInteger(row.pid) ||
    (row.pid as number) <= 1 ||
    (row.pid as number) > 0x7fffffff ||
    !isProcessRef(row.processRef) ||
    typeof row.canTerminate !== 'boolean' ||
    !['same-live', 'absent', 'stale', 'unknown', 'metadata-stopped'].includes(
      String(row.observation)
    )
  )
    throw new Error('Invalid process record');
  const result: BackendProcess = {
    id: text('id', 256),
    pid: row.pid as number,
    label: text('label', 1024),
    registeredAt: text('registeredAt', 128),
    processRef: row.processRef,
    canTerminate: row.canTerminate,
    observation: row.observation as BackendProcess['observation'],
  };
  for (const key of ['stoppedAt', 'registeredBy', 'url', 'command'] as const)
    if (row[key] !== undefined) result[key] = text(key);
  if (row.port !== undefined) {
    if (!Number.isSafeInteger(row.port) || (row.port as number) < 1 || (row.port as number) > 65535)
      throw new Error('Invalid process port');
    result.port = row.port as number;
  }
  if (row.pendingStop !== undefined) {
    const p = row.pendingStop as Record<string, unknown>;
    if (
      !p ||
      typeof p.commandId !== 'string' ||
      !p.commandId ||
      p.commandId.length > 256 ||
      p.commandId.includes('\0') ||
      !isProcessRef(p.originalProcessRef) ||
      (p.native !== 'unknown' && p.native !== 'accepted')
    )
      throw new Error('Invalid original stop');
    result.pendingStop = {
      commandId: p.commandId,
      originalProcessRef: p.originalProcessRef,
      native: p.native,
    };
  }
  if (result.canTerminate && (result.observation !== 'same-live' || result.pendingStop))
    throw new Error('Invalid process capability');
  return result;
}
export function readBackendProcesses(value: unknown): BackendProcess[] {
  if (!Array.isArray(value) || value.length > 1024) throw new Error('Invalid process inventory');
  const rows = value.map(readBackendProcess);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('Duplicate process identity');
  return rows;
}

export type BackendProcessControlRequest = { handle: { handleId: string }; commandId: string } & (
  | { operation: 'process.terminate'; payload: { processRef: string } }
  | { operation: 'process.lookup'; payload: { originalCommandId: string } }
);

export interface BackendProcessPending {
  commandId: string;
  originalProcessRef: string;
  state: { phase: 'requested'; native: 'unknown' | 'accepted' };
}
