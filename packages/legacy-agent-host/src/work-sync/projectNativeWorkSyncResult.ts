import { createHash } from 'node:crypto';
import { TeamOwnerError } from '../team/contracts.js';
import { validateWorkSyncCommandReceipt } from './commandContracts.js';
import { decodeMemberWorkSyncStoredStatus } from './storage/decodeMemberWorkSyncStoredStatus.js';

import type { JsonValue } from '../contracts.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { MemberWorkSyncStatus } from './policy/contracts/index.js';

const resultBytes = 240 * 1024;
const receiptBytes = 512 * 1024;
const detailsNotice = 'Details are omitted from this response. Use task_briefing for the current working queue, team_get with all continuations for the current task board, and task_get for task details. Later reads do not replace the original agenda or report token.';
const wholeAgendaNotice = 'The report covers the entire original agenda; taskIds is omitted.';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const held = (): never => { throw new TeamOwnerError('hold'); };

function pick(value: object, names: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

/** A prescribed STATUS call must be usable for this authenticated original command. */
function assertOriginalCall(value: JsonValue, commandId: string): void {
  if (!object(value) || !object(value.nextRequiredToolCall) ||
      value.nextRequiredToolCall.tool !== 'member_work_sync_report') return;
  const input = value.nextRequiredToolCall.arguments;
  if (!object(input) ||
      input.commandId !== 'work-sync-report:' + createHash('sha256').update(commandId).digest('hex') ||
      typeof input.reportToken !== 'string' || input.reportToken.length < 1 || input.reportToken.length > 4096 ||
      typeof input.agendaFingerprint !== 'string' || input.agendaFingerprint.length < 1 ||
      input.agendaFingerprint.length > 256) return held();
}

/** Exact complete-receipt framing, including every original header and payload field. */
export function workSyncResultBudget(original: Readonly<WorkSyncCommandReceipt>): number {
  return Math.min(resultBytes, receiptBytes - (bytes({ ...original, phase: 'completed', result: null }) - 4));
}

export function assertWorkSyncReceiptCapacity(original: Readonly<WorkSyncCommandReceipt>): void {
  // The placeholder is a capacity witness only. It is never written or returned.
  if (workSyncResultBudget(original) < 96 * 1024) held();
  validateWorkSyncCommandReceipt({
    ...original, phase: 'completed', result: 'x'.repeat(96 * 1024 - 2),
  });
}

const generatedReserve = 16 * 1024;
const excess = (value: unknown, ceiling: number) =>
  value === undefined ? 0 : Math.max(0, bytes(value) - ceiling);

function admissionFacts(value: unknown) {
  if (value === undefined) return undefined;
  if (!object(value) || typeof value.state !== 'string' ||
      !['applied', 'pending', 'unknown', 'superseded'].includes(value.state) ||
      value.controlRevision !== undefined && (typeof value.controlRevision !== 'number' ||
        !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 1)) return held();
  return pick(value, ['state', 'controlRevision']);
}

function recoveryFacts(health: MemberWorkSyncStatus['recoveryHealth']) {
  if (!health) return undefined;
  // The canonical decoder has validated the original recovery state. Preserve
  // its raw revision representation; omit potentially large reasons/episodes.
  const latch = health.autoResumeStopLatch;
  return {
    schemaVersion: 1,
    autoResumeStopped: latch !== undefined,
    ...pick(health, ['controlRevision']),
    ...(latch === undefined ? {} : { autoResumeStopLatch: pick(latch, ['stoppedAt', 'controlRevision']) }),
    detailsOmitted: true,
  };
}

/** Pure per-slot excess: generated replacements cannot be charged a second time. */
export function assertNativeWorkSyncStatusBudget(options: {
  operation: WorkSyncCommandReceipt['operation'];
  status: MemberWorkSyncStatus | null;
  identity: { teamName: string; memberName: string; incarnation: string };
  budget: number;
}): void {
  if (options.budget < generatedReserve) held();
  if (!options.status) return;
  // Prospective domain writes can carry the prior CAS/checkpoint metadata.
  // The existing storage authority validates and assigns that metadata itself.
  const { statusRevision: _revision, pendingReportReceipt: _receipt, ...raw } = options.status;
  const status = (() => {
    try { return decodeMemberWorkSyncStoredStatus(raw, options.identity); }
    catch { return held(); }
  })();
  const copies = options.operation === 'status' ? 2 : 1;
  const reportExcess = (report: MemberWorkSyncStatus['report']) => report === undefined ? 0 :
    excess(report.state, 15) + excess(report.agendaFingerprint, 1538) +
    excess(report.reportedAt, 29) + excess(report.expiresAt, 29) +
    excess(report.source, 6) + excess(report.accepted, 5);
  const report = reportExcess(status.report);
  const last = status.lastAcceptedReport === undefined
    ? (status.report?.accepted === true ? report : 0)
    : reportExcess(status.lastAcceptedReport);
  const admission = admissionFacts(status.runtimeAdmission);
  const latch = status.recoveryHealth?.autoResumeStopLatch;
  const total = generatedReserve +
    excess(status.teamName, 130) + excess(status.memberName, 130) +
    excess(status.agenda.teamName, 130) + excess(status.agenda.memberName, 130) +
    excess(status.state, 15) + excess(status.providerId, 11) +
    excess(status.evaluatedAt, 29) + excess(status.agenda.generatedAt, 29) +
    copies * (excess(status.agenda.fingerprint, 76) + excess(status.reportToken, 637)) +
    excess(status.reportTokenExpiresAt, 29) + report + last +
    excess(admission?.state, 12) + excess(admission?.controlRevision, 24) +
    excess(status.recoveryHealth?.controlRevision, 24) + excess(latch?.stoppedAt, 29) +
    excess(latch?.controlRevision, 24);
  if (total > options.budget) held();
}

/** The exact existing follow-up remains bound to the complete original agenda/token. */
function followUp(value: Record<string, unknown>, status: MemberWorkSyncStatus,
  operation: WorkSyncCommandReceipt['operation'], count = status.agenda.items.length) {
  const hasCall = value.nextRequiredToolCall !== undefined;
  // A compact status with an original token must retain its prescribed report.
  // Report results carry status/token data, but never a prescribed follow-up.
  if (operation === 'status' ? Boolean(status.reportToken) !== hasCall : hasCall) return held();
  if (value.nextRequiredToolCall === undefined) {
    if (value.statusOnlyIncomplete !== undefined || value.nextRequiredAction !== undefined) held();
    return {};
  }
  const call = value.nextRequiredToolCall;
  if (!object(call) || call.tool !== 'member_work_sync_report' || !object(call.arguments)) return held();
  const input = call.arguments;
  if (value.statusOnlyIncomplete !== true || typeof value.nextRequiredAction !== 'string' ||
      typeof input.commandId !== 'string' || input.commandId.length === 0 || input.commandId.length > 256 ||
      input.commandId.trim() !== input.commandId ||
      input.state !== (count ? 'still_working' : 'caught_up') ||
      typeof status.reportToken !== 'string' || input.reportToken !== status.reportToken ||
      input.agendaFingerprint !== status.agenda.fingerprint ||
      Object.keys(input).some(key => !['commandId', 'state', 'agendaFingerprint', 'reportToken', 'taskIds'].includes(key)) ||
      input.taskIds !== undefined && (!Array.isArray(input.taskIds) ||
        input.taskIds.length !== status.agenda.items.length ||
        input.taskIds.some((id, index) => id !== status.agenda.items[index]!.taskId))) return held();
  return {
    statusOnlyIncomplete: true,
    nextRequiredAction: value.nextRequiredAction,
    reportScope: wholeAgendaNotice,
    nextRequiredToolCall: {
      tool: call.tool,
      arguments: pick(input, ['commandId', 'state', 'agendaFingerprint', 'reportToken']),
    },
  };
}

const compactMarker = { version: 1, kind: 'compact' } as const;
const kinds = ['work', 'review', 'clarification', 'blocked_dependency'] as const;
const statusFields = ['teamName', 'memberName', 'state', 'evaluatedAt', 'providerId',
  'reportToken', 'reportTokenExpiresAt'] as const;
const agendaFields = ['teamName', 'memberName', 'generatedAt', 'fingerprint'] as const;
const reportFields = ['state', 'agendaFingerprint', 'reportedAt', 'expiresAt', 'source', 'accepted', 'wait'] as const;
const keysOnly = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every(key => allowed.includes(key));
const countValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCompactMarker = (value: unknown) =>
  object(value) && keysOnly(value, ['version', 'kind']) &&
  value.version === compactMarker.version && value.kind === compactMarker.kind;

/** Validate new retained compact receipts, without deriving an agenda from omitted items. */
function validateCompactStatus(value: Record<string, unknown>,
  identity: { teamName: string; memberName: string; incarnation: string },
  operation: WorkSyncCommandReceipt['operation']) {
  if (!isCompactMarker(value.workSyncProjection) || value.detailsOmitted !== true ||
      value.detailsNotice !== detailsNotice ||
      !keysOnly(value, [...statusFields, 'agenda', 'workSyncProjection', 'detailsOmitted', 'detailsNotice',
        'statusOnlyIncomplete', 'nextRequiredAction', 'reportScope', 'nextRequiredToolCall',
        'report', 'lastAcceptedReport', 'runtimeAdmission', 'recoveryHealth']) ||
      !object(value.agenda)) return held();
  const agenda = value.agenda;
  if (!keysOnly(agenda, [...agendaFields, 'totalItems', 'byKind', 'itemsOmitted']) ||
      agenda.itemsOmitted !== true || !countValue(agenda.totalItems) ||
      !object(agenda.byKind) || !keysOnly(agenda.byKind, kinds)) return held();
  let sum = 0;
  for (const kind of kinds) {
    const count = agenda.byKind[kind];
    if (!countValue(count)) return held();
    sum += count;
  }
  if (sum !== agenda.totalItems) return held();

  // This shape is used only for existing scalar/identity validation, never
  // as an agenda or stored result. The actual count remains the checked total.
  const validation: Record<string, unknown> = {
    ...pick(value, statusFields), diagnostics: [],
    agenda: { ...pick(agenda, agendaFields), items: [], diagnostics: [] },
  };
  for (const field of ['report', 'lastAcceptedReport'] as const) {
    const report = value[field];
    if (report === undefined) continue;
    if (!object(report) || report.detailsOmitted !== true ||
        !keysOnly(report, [...reportFields, 'detailsOmitted'])) return held();
    validation[field] = { ...pick(report, reportFields), teamName: value.teamName, memberName: value.memberName };
  }
  const health = value.recoveryHealth;
  if (health !== undefined) {
    if (!object(health) || health.schemaVersion !== 1 || health.detailsOmitted !== true ||
        !keysOnly(health, ['schemaVersion', 'autoResumeStopped', 'controlRevision', 'autoResumeStopLatch', 'detailsOmitted']) ||
        health.autoResumeStopped !== (health.autoResumeStopLatch !== undefined)) return held();
    const latch = health.autoResumeStopLatch;
    if (latch !== undefined && (!object(latch) || !keysOnly(latch, ['stoppedAt', 'controlRevision']))) return held();
    validation.recoveryHealth = {
      schemaVersion: 1, episodes: [], ...pick(health, ['controlRevision']),
      ...(latch === undefined ? {} : { autoResumeStopLatch: { ...latch, reason: 'validation-only' } }),
    };
  }
  if (value.runtimeAdmission !== undefined &&
      (!object(value.runtimeAdmission) || !keysOnly(value.runtimeAdmission, ['state', 'controlRevision']))) return held();
  admissionFacts(value.runtimeAdmission);
  const status = (() => {
    try { return decodeMemberWorkSyncStoredStatus(validation, identity); }
    catch { return held(); }
  })();
  if (value.nextRequiredToolCall !== undefined) {
    const call = value.nextRequiredToolCall;
    if (value.reportScope !== wholeAgendaNotice || !object(call) ||
        !keysOnly(call, ['tool', 'arguments']) || !object(call.arguments) ||
        call.arguments.taskIds !== undefined) return held();
  } else if (value.reportScope !== undefined) return held();
  followUp(value, status, operation, agenda.totalItems);
}

function compactStatus(value: Record<string, unknown>, status: MemberWorkSyncStatus,
  operation: WorkSyncCommandReceipt['operation']) {
  const summary = {
    ...pick(status, statusFields),
    agenda: {
      ...pick(status.agenda, agendaFields),
      totalItems: status.agenda.items.length,
      byKind: Object.fromEntries(kinds.map(kind =>
        [kind, status.agenda.items.filter(item => item.kind === kind).length])),
      itemsOmitted: true,
    },
    workSyncProjection: compactMarker,
    detailsOmitted: true,
    detailsNotice,
    ...followUp(value, status, operation),
  };
  for (const field of ['report', 'lastAcceptedReport'] as const) {
    const report = status[field];
    if (report !== undefined) Object.assign(summary, { [field]: {
      ...pick(report, reportFields),
      detailsOmitted: true,
    } });
  }
  const admission = admissionFacts(value.runtimeAdmission);
  if (admission !== undefined) Object.assign(summary, { runtimeAdmission: admission });
  const recoveryHealth = recoveryFacts(status.recoveryHealth);
  if (recoveryHealth !== undefined) Object.assign(summary, { recoveryHealth });
  return summary;
}

/** Pure wire/receipt projection; canonical policy state, tokens and command replay remain authoritative. */
export function projectNativeWorkSyncResult(options: {
  operation: WorkSyncCommandReceipt['operation'];
  commandId: string;
  value: JsonValue;
  identity: { teamName: string; memberName: string; incarnation: string };
  original?: Readonly<WorkSyncCommandReceipt>;
}): JsonValue {
  const budget = options.original === undefined ? resultBytes : workSyncResultBudget(options.original);
  const fits = (value: JsonValue) => bytes(value) <= budget;
  const readStatus = (value: unknown) => {
    try { return decodeMemberWorkSyncStoredStatus(value, options.identity); } catch { return held(); }
  };
  let value = options.value;
  if (options.original !== undefined && options.original.commandId !== options.commandId) return held();
  // Check before full-fit and compact replay returns. REPORT tokens are retained scalars, not suggested input.
  if (options.operation === 'status') assertOriginalCall(value, options.commandId);
  // Older already-completed compact receipts have no version marker and retain
  // their original replay behavior. New versioned variants are checked strictly.
  if (object(value)) {
    const markedStatus = options.operation === 'status' ? value : value.status;
    if (object(markedStatus) && markedStatus.workSyncProjection !== undefined ||
        options.operation === 'report' && value.workSyncProjection !== undefined) {
      if (!object(markedStatus)) return held();
      validateCompactStatus(markedStatus, options.identity, options.operation);
      if (options.operation === 'report' &&
          (!isCompactMarker(value.workSyncProjection) ||
            !keysOnly(value, ['accepted', 'code', 'message', 'projectionDegraded', 'status', 'workSyncProjection']) ||
            typeof value.accepted !== 'boolean' || typeof value.code !== 'string' || typeof value.message !== 'string' ||
            value.projectionDegraded !== undefined && typeof value.projectionDegraded !== 'boolean' ||
            markedStatus.nextRequiredToolCall !== undefined)) return held();
      if (!fits(value)) return held();
      return value;
    }
  }
  // Old completed receipts may contain a small but invalid >200-ID prescribed call.
  // Repair only the response; never rewrite the original receipt or execute its policy again.
  if (options.operation === 'status' && object(value) && object(value.nextRequiredToolCall) &&
      object(value.nextRequiredToolCall.arguments) && Array.isArray(value.nextRequiredToolCall.arguments.taskIds) &&
      value.nextRequiredToolCall.arguments.taskIds.length > 200) {
    value = json({ ...value, ...followUp(value, readStatus(value), options.operation) });
  }
  if (fits(value)) return value;
  if (!object(value)) return held();
  if (options.operation === 'status') {
    value = json(compactStatus(value, readStatus(value), options.operation));
  } else {
    if (typeof value.accepted !== 'boolean' || typeof value.code !== 'string' || typeof value.message !== 'string' ||
        value.projectionDegraded !== undefined && typeof value.projectionDegraded !== 'boolean' ||
        !object(value.status)) return held();
    value = json({
      ...pick(value, ['accepted', 'code', 'message', 'projectionDegraded']),
      workSyncProjection: compactMarker,
      status: compactStatus(value.status, readStatus(value.status), options.operation),
    });
  }
  if (!fits(value)) return held();
  return value;
}
