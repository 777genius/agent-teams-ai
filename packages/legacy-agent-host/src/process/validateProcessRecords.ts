import type {
  DarwinProcessIdentity,
  ProcessCommandReceipt,
  RegisteredProcessCapture,
  TeamProcessRow,
} from './registeredProcessContracts.js';
const hold = (): never => {
  throw new Error('process:hold');
};
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && !!value && value.length <= max && !value.includes('\0');
function identity(value: DarwinProcessIdentity) {
  if (
    !value ||
    !Array.isArray(value.auditToken) ||
    value.auditToken.length !== 8 ||
    !value.auditToken.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) ||
    value.auditToken[5]! <= 1 ||
    value.auditToken[5]! > 0x7fffffff ||
    !Number.isSafeInteger(value.sessionId) ||
    value.sessionId <= 1 ||
    !text(value.bootId) ||
    !/^[a-f0-9-]{36}$/i.test(value.bootId) ||
    value.osBuild !== '24G90'
  )
    hold();
}
export function validateProcessCapture(capture: RegisteredProcessCapture): void {
  if (
    !capture ||
    (capture.version !== 1 && capture.version !== 2) ||
    !capture.registrar ||
    !['backendId', 'teamId', 'runId', 'memberId', 'generation'].every((key) =>
      text(capture.registrar[key as keyof typeof capture.registrar])
    )
  )
    hold();
  identity(capture.root);
  identity(capture.target);
  if (
    capture.root.auditToken[5] !== capture.root.sessionId ||
    (capture.version === 1
      ? capture.target.sessionId !== capture.root.sessionId || 'admission' in capture
      : capture.admission !== 'live-ancestry-v1' ||
        capture.target.sessionId === capture.root.sessionId ||
        capture.target.sessionId === capture.target.auditToken[5]) ||
    capture.target.auditToken[5] === capture.root.auditToken[5] ||
    capture.target.bootId !== capture.root.bootId ||
    capture.target.osBuild !== capture.root.osBuild
  )
    hold();
}
export function validateProcessRow(row: TeamProcessRow): TeamProcessRow {
  if (
    !row ||
    !text(row.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
    !text(row.label, 1024) ||
    !text(row.registeredAt, 128) ||
    !Number.isFinite(Date.parse(row.registeredAt)) ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 1 ||
    row.pid > 0x7fffffff ||
    (row.stoppedAt !== undefined &&
      (!text(row.stoppedAt, 128) || !Number.isFinite(Date.parse(row.stoppedAt)))) ||
    (row.registeredBy !== undefined && !text(row.registeredBy)) ||
    (row.url !== undefined && !text(row.url, 4096)) ||
    (row.command !== undefined && !text(row.command, 4096)) ||
    (row.port !== undefined &&
      (!Number.isSafeInteger(row.port) || row.port < 1 || row.port > 65535))
  )
    hold();
  if (row.capturedNative !== undefined || row.capturedByCommand !== undefined) {
    const capture = row.capturedNative;
    if (!capture || !text(row.capturedByCommand)) return hold();
    validateProcessCapture(capture);
    if (capture.target.auditToken[5] !== row.pid) hold();
  }
  return row;
}
export function processReceiptFingerprint(
  row: ProcessCommandReceipt,
  digest: (value: unknown) => string
) {
  return digest({
    binding: row.binding,
    principalId: row.principalId,
    commandId: row.commandId,
    operation: row.operation,
    requestDigest: row.requestDigest,
    ...(row.capture ? { capture: row.capture } : {}),
    ...(row.processRef ? { processRef: row.processRef } : {}),
    ...(row.original ? { original: row.original } : {}),
    ...(row.selected ? { selected: row.selected } : {}),
  });
}
export function processReceiptPhase(
  state: ProcessCommandReceipt['state']
): ProcessCommandReceipt['phase'] {
  return state.phase === 'requested'
    ? 'held'
    : state.phase === 'refused'
      ? 'rejected'
      : state.phase;
}
export function validateProcessReceipt(
  row: ProcessCommandReceipt,
  digest: (value: unknown) => string
): ProcessCommandReceipt {
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.family !== 'process' ||
    !text(row.commandId) ||
    !text(row.principalId) ||
    !row.binding ||
    !['backendId', 'teamId', 'teamName'].every((key) =>
      text(row.binding[key as keyof typeof row.binding])
    ) ||
    Object.keys(row.binding).length !== 3 ||
    !Number.isSafeInteger(row.authorityRevision) ||
    row.authorityRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(row.requestDigest) ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
    !['register', 'metadata-stop', 'unregister', 'terminate'].includes(row.operation) ||
    !row.state ||
    row.phase !== processReceiptPhase(row.state) ||
    !['prepared', 'requested', 'completed', 'refused'].includes(row.state.phase) ||
    row.fingerprint !== processReceiptFingerprint(row, digest) ||
    JSON.stringify(row).length > 128 * 1024
  )
    hold();
  if (row.state.phase === 'prepared' && row.state.native !== 'not-requested') hold();
  if (row.state.phase === 'refused' && !['not-requested', 'refused'].includes(row.state.native))
    hold();
  if (
    row.state.phase === 'completed' &&
    !['not-requested', 'observed-absent'].includes(row.state.native)
  )
    hold();
  if (
    row.state.native === 'observed-absent' &&
    (row.operation !== 'terminate' ||
      row.state.phase !== 'completed' ||
      !['unknown', true, false].includes(row.state.signalAccepted))
  )
    hold();
  if (
    row.selected &&
    (!Array.isArray(row.selected) ||
      row.selected.length > 1024 ||
      new Set(row.selected.map((item) => item.id)).size !== row.selected.length ||
      row.selected.some(
        (item) => !text(item.id) || !/^p1:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(item.processRef)
      ))
  )
    hold();
  if (row.capture) {
    validateProcessCapture(row.capture);
    if (
      row.capture.registrar.backendId !== row.binding.backendId ||
      row.capture.registrar.teamId !== row.binding.teamId
    )
      hold();
  }
  if (row.original) validateProcessRow(row.original);
  if (
    row.operation === 'terminate' &&
    (!row.capture ||
      !row.original ||
      !text(row.processRef) ||
      digest(row.capture) !== digest(row.original.capturedNative))
  )
    hold();
  if (
    row.state.phase === 'requested' &&
    (row.operation !== 'terminate' || !['unknown', 'accepted'].includes(row.state.native))
  )
    hold();
  if (
    row.operation === 'register' &&
    row.capture &&
    row.original &&
    digest(row.capture) !== digest(row.original.capturedNative)
  )
    hold();
  return row;
}
