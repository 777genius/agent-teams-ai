import type {
  MemberWorkSyncNudgePayload,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncStatus,
} from '../../contracts';

export const MEMBER_WORK_SYNC_NUDGE_ID_PREFIX = 'member-work-sync';

interface MemberWorkSyncNudgeHash {
  sha256Hex(value: string): string;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function buildMemberWorkSyncNudgeId(input: {
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  intentKey?: string;
}): string {
  return [
    MEMBER_WORK_SYNC_NUDGE_ID_PREFIX,
    input.teamName,
    input.memberName.trim().toLowerCase(),
    input.intentKey ?? input.agendaFingerprint,
  ].join(':');
}

function getReviewPickupRequestEventIds(status: MemberWorkSyncStatus): string[] {
  return [
    ...new Set(
      status.agenda.items
        .map((item) => item.evidence.reviewRequestEventId?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ].sort();
}

function isReviewPickupNudgeStatus(status: MemberWorkSyncStatus): boolean {
  return (
    status.agenda.items.length > 0 &&
    status.agenda.items.every(
      (item) =>
        item.kind === 'review' &&
        item.evidence.reviewObligation === 'review_pickup_required' &&
        item.evidence.canBypassPhase2 === true &&
        typeof item.evidence.reviewRequestEventId === 'string' &&
        item.evidence.reviewRequestEventId.length > 0 &&
        (item.evidence.reviewDiagnostics?.length ?? 0) === 0
    )
  );
}

export function buildMemberWorkSyncReviewPickupIntentKey(
  status: MemberWorkSyncStatus
): string | null {
  const reviewRequestEventIds = getReviewPickupRequestEventIds(status);
  return reviewRequestEventIds.length > 0
    ? `review-pickup:${reviewRequestEventIds.join('+')}`
    : null;
}

function buildTaskRefs(status: MemberWorkSyncStatus): MemberWorkSyncNudgePayload['taskRefs'] {
  return status.agenda.items.map((item) => ({
    teamName: status.teamName,
    taskId: item.taskId,
    displayId: item.displayId ?? item.taskId.slice(0, 8),
  }));
}

function buildAgendaPreview(status: MemberWorkSyncStatus): string {
  return status.agenda.items
    .slice(0, 3)
    .map((item) => `${item.displayId ?? item.taskId.slice(0, 8)} ${item.subject}`)
    .join('; ');
}

function hasLeadClarificationItem(status: MemberWorkSyncStatus): boolean {
  return status.agenda.items.some(
    (item) => item.kind === 'clarification' && item.evidence.needsClarification === 'lead'
  );
}

function buildProofMissingRecoveryText(status: MemberWorkSyncStatus): string[] {
  const recovery = status.shadow?.recovery;
  if (recovery?.kind !== 'proof_missing') {
    return [];
  }

  return [
    `This also repairs OpenCode delivery proof for original messageId "${recovery.originalMessageId}".`,
    'If you already completed the work, do not duplicate it; instead create the missing visible reply or task progress proof for the current agenda.',
  ];
}

function buildReviewPickupNudgePayload(status: MemberWorkSyncStatus): MemberWorkSyncNudgePayload {
  const taskRefs = buildTaskRefs(status);
  const preview = buildAgendaPreview(status);
  const reviewRequestEventIds = getReviewPickupRequestEventIds(status);
  const intentKey = buildMemberWorkSyncReviewPickupIntentKey(status);

  return {
    from: 'system',
    to: status.memberName,
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'review_pickup',
    ...(intentKey ? { workSyncIntentKey: intentKey } : {}),
    workSyncReviewRequestEventIds: reviewRequestEventIds,
    taskRefs,
    text: [
      'Review pickup required: a current review request is waiting for you.',
      preview ? `Review agenda: ${preview}.` : '',
      'Open the task, verify the current reviewState/status, then start or continue the review only if it is still assigned to you.',
      `If you cannot pick it up now, call member_work_sync_status with teamName "${status.teamName}" and memberName "${status.memberName}", then report "blocked" or "still_working" only for the real current state.`,
      'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
      'If your runtime exposes prefixed Agent Teams MCP tool names, use mcp__agent-teams__member_work_sync_status and mcp__agent-teams__member_work_sync_report.',
      'Do not mark the review complete from this prompt alone, and do not reply only with acknowledgement.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function buildMemberWorkSyncNudgePayload(
  status: MemberWorkSyncStatus
): MemberWorkSyncNudgePayload {
  if (isReviewPickupNudgeStatus(status)) {
    return buildReviewPickupNudgePayload(status);
  }

  const taskRefs = status.agenda.items.map((item) => ({
    teamName: status.teamName,
    taskId: item.taskId,
    displayId: item.displayId ?? item.taskId.slice(0, 8),
  }));
  const preview = status.agenda.items
    .slice(0, 3)
    .map((item) => `${item.displayId ?? item.taskId.slice(0, 8)} ${item.subject}`)
    .join('; ');
  const taskIds = status.agenda.items.map((item) => item.taskId).filter(Boolean);
  const hasLeadClarification = hasLeadClarificationItem(status);

  return {
    from: 'system',
    to: status.memberName,
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'agenda_sync',
    ...(status.shadow?.recovery?.intentKey
      ? { workSyncIntentKey: status.shadow.recovery.intentKey }
      : {}),
    taskRefs,
    text: [
      'Work sync check: you have current actionable work assigned.',
      ...buildProofMissingRecoveryText(status),
      preview ? `Current agenda: ${preview}.` : '',
      `Required sync action: call member_work_sync_status with teamName "${status.teamName}" and memberName "${status.memberName}", then call member_work_sync_report with the same teamName/memberName and the returned agendaFingerprint and reportToken.`,
      'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
      'If your runtime exposes prefixed Agent Teams MCP tool names, use mcp__agent-teams__member_work_sync_status and mcp__agent-teams__member_work_sync_report. Do not search the filesystem or list MCP resources before the first direct tool attempt.',
      taskIds.length
        ? `When reporting, include taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.`
        : '',
      `Do not use provider names, runtime names, or team names as memberName; use exactly "${status.memberName}".`,
      'If you are still working, report state "still_working"; if you are blocked, report state "blocked" and record the blocker on the task.',
      hasLeadClarification
        ? 'If a lead clarification was already escalated to the user, update the task board first with task_set_clarification value "user"; do not rely on a message alone.'
        : '',
      'Continue concrete task work, report a real blocker with task tools, or sync your current fingerprint before going idle.',
      'Do not reply only with acknowledgement.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function buildMemberWorkSyncNudgePayloadHash(
  hash: MemberWorkSyncNudgeHash,
  payload: MemberWorkSyncNudgePayload
): string {
  return hash.sha256Hex(stableJson(payload));
}

export function buildMemberWorkSyncOutboxEnsureInput(input: {
  status: MemberWorkSyncStatus;
  hash: MemberWorkSyncNudgeHash;
  nowIso: string;
}): MemberWorkSyncOutboxEnsureInput | null {
  const status = input.status;
  if (
    status.state !== 'needs_sync' ||
    status.shadow?.wouldNudge !== true ||
    status.agenda.items.length === 0
  ) {
    return null;
  }

  const payload = buildMemberWorkSyncNudgePayload(status);
  const intentKey = payload.workSyncIntentKey;
  return {
    id: buildMemberWorkSyncNudgeId({
      teamName: status.teamName,
      memberName: status.memberName,
      agendaFingerprint: status.agenda.fingerprint,
      intentKey,
    }),
    teamName: status.teamName,
    memberName: status.memberName,
    agendaFingerprint: status.agenda.fingerprint,
    payloadHash: buildMemberWorkSyncNudgePayloadHash(input.hash, payload),
    payload,
    nowIso: input.nowIso,
  };
}
