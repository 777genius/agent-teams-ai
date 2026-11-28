import { serviceSource, windowsServiceCaptureSchema, windowsServiceIntentSchema } from '../owned-process/retainedServiceContracts.js';
import type {
  DarwinProcessIdentity,
  LinuxProcessIdentity,
  LinuxWarmProcessIdentity,
  ProcessCommandReceipt,
  RegisteredProcessCapture,
  TeamProcessRow,
} from './registeredProcessContracts.js';
import { isQualifiedDarwinBuild } from './qualifiedDarwinBuild.js';
const hold: () => never = () => {
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
    !isQualifiedDarwinBuild(value.osBuild)
  )
    hold();
}
function linuxIdentity(value: LinuxProcessIdentity | LinuxWarmProcessIdentity, durable = true) {
  const decimal = (part: unknown) => typeof part === 'string' && /^[1-9]\d{0,19}$/.test(part) &&
    BigInt(part) <= 0xffffffffffffffffn;
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid > 0x7fffffff ||
      !Number.isSafeInteger(value.sessionId) || value.sessionId <= 1 || value.sessionId > 0x7fffffff ||
      (durable ? !('pidfdId' in value) || !decimal(value.pidfdId) : 'pidfdId' in value) ||
      !decimal(value.pidNamespaceId) ||
      !text(value.bootId) || !/^[a-f0-9-]{36}$/i.test(value.bootId)) hold();
}
export function validateProcessCapture(capture: RegisteredProcessCapture): void {
  if (
    !capture ||
    (capture.version !== 1 && capture.version !== 2 && capture.version !== 3 && capture.version !== 4 && capture.version !== 5) ||
    !capture.registrar ||
    !['backendId', 'teamId', 'runId', 'memberId', 'generation'].every((key) =>
      text(capture.registrar[key as keyof typeof capture.registrar])
    )
  )
    hold();
  if (capture.version === 5) {
    if (!windowsServiceCaptureSchema.safeParse(capture).success || capture.root.pid === capture.target.pid) hold();
    return;
  }
  if (capture.version === 4) {
    const uuid = (value: unknown) => typeof value === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
    if (capture.platform !== 'linux' || capture.admission !== 'owner-pidfd-v1' ||
        !uuid(capture.ownerInstance) || !uuid(capture.captureKey) ||
        Object.keys(capture.registrar).sort().join(',') !== 'backendId,generation,memberId,runId,teamId' ||
        Object.keys(capture).sort().join(',') !==
          'admission,captureKey,ownerInstance,platform,registrar,root,target,version') hold();
    linuxIdentity(capture.root, false); linuxIdentity(capture.target, false);
    for (const identity of [capture.root, capture.target])
      if (Object.keys(identity).sort().join(',') !== 'bootId,pid,pidNamespaceId,sessionId') hold();
    if (capture.root.sessionId !== capture.root.pid || capture.root.pid === capture.target.pid ||
        capture.root.bootId !== capture.target.bootId ||
        capture.root.pidNamespaceId !== capture.target.pidNamespaceId) hold();
    return;
  }
  if (capture.version === 3) {
    if (capture.platform !== 'linux') hold();
    linuxIdentity(capture.root); linuxIdentity(capture.target);
    if (capture.root.sessionId !== capture.root.pid || capture.root.pid === capture.target.pid ||
        capture.root.pidfdId === capture.target.pidfdId || capture.root.bootId !== capture.target.bootId ||
        capture.root.pidNamespaceId !== capture.target.pidNamespaceId) hold();
    return;
  }
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
    const pid = capture.version === 3 || capture.version === 4 || capture.version === 5 ? capture.target.pid : capture.target.auditToken[5];
    if (pid !== row.pid) hold();
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
    ...(row.nativeIntent ? { nativeIntent: row.nativeIntent } : {}),
    ...(row.originalRegistration ? { originalRegistration: row.originalRegistration } : {}),
    ...(row.nativeSettlement ? { nativeSettlement: row.nativeSettlement } : {}),
    ...(row.nativeSettlementNotDispatched !== undefined ? { nativeSettlementNotDispatched: row.nativeSettlementNotDispatched } : {}),
    ...(row.nativeSettlementConfirmed !== undefined ? { nativeSettlementConfirmed: row.nativeSettlementConfirmed } : {}),
    ...(row.nativeAbsence ? { nativeAbsence: row.nativeAbsence } : {}),
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
  validateWindowsProcessReceipt(row, digest);
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
    ((row.operation !== 'terminate' && !(row.operation === 'register' && row.nativeIntent && row.originalRegistration)) ||
      !['unknown', 'accepted'].includes(row.state.native) ||
      (row.operation === 'register' && row.state.native !== 'unknown'))
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

/** New optional fields are exact and fingerprinted; legacy receipts have no synthesized defaults. */
function validateWindowsProcessReceipt(row: ProcessCommandReceipt, digest: (value: unknown) => string): void {
  const intent = row.nativeIntent;
  const registration = row.originalRegistration;
  if (!intent) {
    if (registration || row.nativeSettlement || row.nativeSettlementNotDispatched !== undefined || row.nativeSettlementConfirmed !== undefined ||
        row.nativeAbsence !== undefined || row.capture?.version === 5) hold();
    return;
  }
  if (!windowsServiceIntentSchema.safeParse(intent).success ||
      (row.operation !== 'register' && row.operation !== 'terminate')) hold();
  const command = intent.command;
  if (row.operation === 'register') {
    if (command.operation !== 'capture' || !registration ||
        Object.keys(registration).sort().join(',') !== 'input,memberName,policyRequested' ||
        !text(registration.memberName) || typeof registration.policyRequested !== 'boolean') hold();
    const input = registration.input;
    if (!input || Object.keys(input).some(key => !['pid', 'label', 'port', 'url', 'command'].includes(key)) ||
        !Number.isSafeInteger(input.pid) || input.pid <= 1 || input.pid > 0x7fffffff ||
        !text(input.label, 1024) || !input.label.trim() || /[\0\r\n]/.test(input.label) ||
        (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535)) ||
        (input.url !== undefined && (typeof input.url !== 'string' || input.url.length > 4096 || input.url.includes('\0'))) ||
        (input.command !== undefined && (typeof input.command !== 'string' || input.command.length > 4096 || input.command.includes('\0'))) ||
        row.requestDigest !== digest(input) || command.pid !== input.pid ||
        command.registrar.backendId !== row.binding.backendId || command.registrar.teamId !== row.binding.teamId)
      hold();
    if (row.capture && (row.capture.version !== 5 ||
        digest(serviceSource(row.capture)) !== digest(serviceSource(intent)) ||
        row.capture.target.pid !== input.pid || digest(row.capture.registrar) !== digest(command.registrar))) hold();
    if (row.state.phase === 'completed' && (!registration.policyRequested || !row.capture || !row.original)) hold();
  } else {
    if (registration || command.operation !== 'stop' || !row.capture || row.capture.version !== 5 ||
        digest(command.capture) !== digest(row.capture) ||
        digest(serviceSource(intent)) !== digest(serviceSource(row.capture))) hold();
  }
  if (row.nativeAbsence !== undefined) {
    const absence = row.nativeAbsence;
    if (!absence || Object.keys(absence).sort().join(',') !== 'captureDigest,evidence,kind,schemaVersion,settlement' ||
        absence.schemaVersion !== 1 || absence.kind !== 'windows-service-absence-v1' ||
        !['native-scope', 'retained-terminal', 'original-whole-job'].includes(absence.evidence) ||
        !['unprepared', 'requested', 'not-dispatched', 'settled'].includes(absence.settlement) ||
        row.operation !== 'register' || row.state.phase !== 'completed' || row.state.native !== 'not-requested' ||
        !row.capture || row.capture.version !== 5 || absence.captureDigest !== digest(row.capture) ||
        (absence.settlement === 'unprepared' ? row.nativeSettlement !== undefined : !row.nativeSettlement)) hold();
  }
  if (row.nativeSettlement) {
    const settlement = row.nativeSettlement;
    const terminated = row.operation === 'terminate' && row.state.phase === 'completed' &&
      row.state.native === 'observed-absent';
    const natural = row.operation === 'register' && row.nativeAbsence &&
      row.nativeAbsence.settlement !== 'unprepared';
    if (!windowsServiceIntentSchema.safeParse(settlement).success || settlement.command.operation !== 'settle' ||
        (!terminated && !natural) ||
        !row.capture || row.capture.version !== 5 || digest(settlement.command.capture) !== digest(row.capture) ||
        digest(serviceSource(settlement)) !== digest(serviceSource(row.capture))) hold();
  }
  if (row.nativeSettlementNotDispatched !== undefined &&
      (row.nativeSettlementNotDispatched !== true || !row.nativeSettlement || row.operation !== 'terminate' ||
        row.state.phase !== 'completed' || row.state.native !== 'observed-absent' || row.capture?.version !== 5)) hold();
  if (row.nativeSettlementConfirmed !== undefined &&
      (row.nativeSettlementConfirmed !== true || !row.nativeSettlement || row.nativeSettlementNotDispatched !== undefined ||
        row.operation !== 'terminate' || row.state.phase !== 'completed' ||
        row.state.native !== 'observed-absent' || row.capture?.version !== 5)) hold();
}
