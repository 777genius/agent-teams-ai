import { TeamOwnerError } from '../team/contracts.js';
import { readMemberWorkSyncReportReceipt } from './policy/core/domain/MemberWorkSyncReportReceipt.js';
import { readMemberWorkSyncStatusRevision } from './policy/core/domain/MemberWorkSyncStatusRevision.js';
import { decodeMemberWorkSyncStoredStatus } from './storage/decodeMemberWorkSyncStoredStatus.js';

import type { JsonValue } from '../contracts.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { MemberWorkSyncStatus } from './policy/contracts/index.js';

const resultBytes = 240 * 1024;
const receiptBytes = 512 * 1024;
const detailsNotice = 'Details are omitted from this response. Use task_briefing for the current working queue and task_get for full task details; follow their continuations when present.';
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

/** The exact existing follow-up remains bound to the complete original agenda/token. */
function followUp(value: Record<string, unknown>, status: MemberWorkSyncStatus) {
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
      input.state !== (status.agenda.items.length ? 'still_working' : 'caught_up') ||
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

function compactStatus(value: Record<string, unknown>, status: MemberWorkSyncStatus) {
  const revision = readMemberWorkSyncStatusRevision(status);
  const summary = {
    ...pick(status, ['teamName', 'memberName', 'state', 'evaluatedAt', 'providerId',
      'reportToken', 'reportTokenExpiresAt']),
    ...(revision ? { statusRevision: revision } : {}),
    ...(status.pendingReportReceipt === undefined ? {} : {
      pendingReportReceipt: readMemberWorkSyncReportReceipt(status.pendingReportReceipt, revision),
    }),
    agenda: {
      ...pick(status.agenda, ['teamName', 'memberName', 'generatedAt', 'fingerprint', 'sourceRevision']),
      totalItems: status.agenda.items.length,
      itemsOmitted: true,
    },
    detailsOmitted: true,
    detailsNotice,
    ...followUp(value, status),
  };
  for (const field of ['report', 'lastAcceptedReport'] as const) {
    const report = status[field];
    if (report !== undefined) Object.assign(summary, { [field]: {
      ...pick(report, ['teamName', 'memberName', 'state', 'agendaFingerprint', 'reportedAt',
        'expiresAt', 'source', 'accepted', 'rejectionCode', 'wait']),
      detailsOmitted: true,
    } });
  }
  const admission = value.runtimeAdmission;
  if (admission !== undefined) {
    if (!object(admission) || typeof admission.state !== 'string' ||
        !['applied', 'pending', 'unknown', 'superseded'].includes(admission.state) ||
        admission.controlRevision !== undefined && (typeof admission.controlRevision !== 'number' ||
          !Number.isSafeInteger(admission.controlRevision) || admission.controlRevision < 1)) return held();
    Object.assign(summary, { runtimeAdmission: pick(admission, ['state', 'controlRevision']) });
  }
  return summary;
}

/** Pure wire/receipt projection; canonical policy state, tokens and command replay remain authoritative. */
export function projectNativeWorkSyncResult(options: {
  operation: WorkSyncCommandReceipt['operation'];
  value: JsonValue;
  identity: { teamName: string; memberName: string; incarnation: string };
  original?: Readonly<WorkSyncCommandReceipt>;
}): JsonValue {
  const fits = (value: JsonValue) => bytes(value) <= resultBytes &&
    (options.original === undefined || bytes({ ...options.original, phase: 'completed', result: value }) <= receiptBytes);
  const readStatus = (value: unknown) => {
    try { return decodeMemberWorkSyncStoredStatus(value, options.identity); } catch { return held(); }
  };
  let value = options.value;
  // Old completed receipts may contain a small but invalid >200-ID prescribed call.
  // Repair only the response; never rewrite the original receipt or execute its policy again.
  if (options.operation === 'status' && object(value) && object(value.nextRequiredToolCall) &&
      object(value.nextRequiredToolCall.arguments) && Array.isArray(value.nextRequiredToolCall.arguments.taskIds) &&
      value.nextRequiredToolCall.arguments.taskIds.length > 200) {
    value = json({ ...value, ...followUp(value, readStatus(value)) });
  }
  if (fits(value)) return value;
  if (!object(value)) return held();
  if (options.operation === 'status') {
    value = json(compactStatus(value, readStatus(value)));
  } else {
    if (typeof value.accepted !== 'boolean' || typeof value.code !== 'string' || typeof value.message !== 'string' ||
        value.projectionDegraded !== undefined && typeof value.projectionDegraded !== 'boolean' ||
        !object(value.status)) return held();
    value = json({
      ...pick(value, ['accepted', 'code', 'message', 'projectionDegraded']),
      status: compactStatus(value.status, readStatus(value.status)),
    });
  }
  if (!fits(value)) return held();
  return value;
}
