import type {
  MemberWorkSyncRecoveryHealth,
  MemberWorkSyncRecoveryReservation,
  MemberWorkSyncRecoveryTerminalOutcome,
} from '../../contracts';

export function isMemberWorkSyncEarlyContinuationEnabled(deps: {
  recoveryProtocol?: { version: number };
  runtimeTicketAdmission?: unknown;
}): boolean {
  return (deps.recoveryProtocol?.version ?? 0) >= 2 && deps.runtimeTicketAdmission != null;
}

export function findMemberWorkSyncCompactWitness(
  health: MemberWorkSyncRecoveryHealth | undefined,
  intentId: string
): MemberWorkSyncRecoveryReservation | undefined {
  return health?.reservations?.find(
    (reservation) => reservation.intentId === intentId && reservation.compactWitness === true
  );
}

export function patchMemberWorkSyncReservation(
  health: MemberWorkSyncRecoveryHealth | undefined,
  intentId: string,
  patch: (reservation: MemberWorkSyncRecoveryReservation) => MemberWorkSyncRecoveryReservation,
  options?: { clearUnresolved?: boolean }
): MemberWorkSyncRecoveryHealth | undefined {
  if (!health) {
    return undefined;
  }
  const reservations = health.reservations ?? [];
  const index = reservations.findIndex((reservation) => reservation.intentId === intentId);
  if (index < 0) {
    return health;
  }
  const current = reservations[index];
  if (!current) {
    return health;
  }
  const nextReservations = [...reservations];
  nextReservations[index] = patch(current);
  const unresolvedIntentId =
    options?.clearUnresolved && health.unresolvedIntentId === intentId
      ? undefined
      : health.unresolvedIntentId;
  const { unresolvedIntentId: _previousUnresolved, ...rest } = health;
  return {
    ...rest,
    schemaVersion: 1,
    episodes: health.episodes,
    ...(unresolvedIntentId ? { unresolvedIntentId } : {}),
    reservations: nextReservations,
  };
}

export function applyMemberWorkSyncRetryableDispatch(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
}): MemberWorkSyncRecoveryHealth | undefined {
  return patchMemberWorkSyncReservation(input.health, input.intentId, (reservation) => ({
    ...reservation,
    state: 'uncertain',
    terminalOutcome: 'retryable_refusal',
  }));
}

export function applyMemberWorkSyncDeliveredDispatch(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
  boundTurnId?: string;
  deliveredAt?: string;
}): MemberWorkSyncRecoveryHealth | undefined {
  const reservation = input.health?.reservations?.find(
    (entry) => entry.intentId === input.intentId
  );
  if (reservation?.state === 'resolved' || reservation?.state === 'cancelled') {
    return input.health;
  }
  return patchMemberWorkSyncReservation(input.health, input.intentId, (reservation) => ({
    ...reservation,
    state: 'awaiting_outcome',
    ...(input.boundTurnId || reservation.boundTurnId
      ? { boundTurnId: input.boundTurnId ?? reservation.boundTurnId }
      : {}),
    ...(input.deliveredAt || reservation.deliveredAt
      ? { deliveredAt: input.deliveredAt ?? reservation.deliveredAt }
      : {}),
  }));
}

function isRetirableAcceptedReportReservation(
  reservation: MemberWorkSyncRecoveryReservation | undefined,
  reportedAtIso: string
): reservation is MemberWorkSyncRecoveryReservation {
  if (
    !reservation ||
    (reservation.state !== 'awaiting_outcome' &&
      reservation.state !== 'uncertain' &&
      reservation.state !== 'reserved')
  ) {
    return false;
  }
  const startedAtIso =
    reservation.state === 'awaiting_outcome' ? reservation.deliveredAt : reservation.reservedAt;
  if (!startedAtIso) {
    return false;
  }
  const reportedAt = Date.parse(reportedAtIso);
  const startedAt = Date.parse(startedAtIso);
  return Number.isFinite(reportedAt) && Number.isFinite(startedAt) && reportedAt >= startedAt;
}

export function applyMemberWorkSyncAcceptedReportRetirement(input: {
  health?: MemberWorkSyncRecoveryHealth;
  reportedAt?: string;
}): MemberWorkSyncRecoveryHealth | undefined {
  if (!input.health || !input.reportedAt) {
    return input.health;
  }
  const intentIds = [
    ...(input.health.unresolvedIntentId ? [input.health.unresolvedIntentId] : []),
    ...(input.health.reservations ?? []).map((reservation) => reservation.intentId),
  ];
  let health = input.health;
  const seen = new Set<string>();
  for (const intentId of intentIds) {
    if (seen.has(intentId)) {
      continue;
    }
    seen.add(intentId);
    const reservation = health.reservations?.find((entry) => entry.intentId === intentId);
    if (!isRetirableAcceptedReportReservation(reservation, input.reportedAt)) {
      continue;
    }
    health =
      applyMemberWorkSyncTerminalRetirement({
        health,
        intentId,
        receiptId: `report-accepted:${intentId}`,
        outcome: 'settled',
        pendingAck: false,
      }) ?? health;
  }
  return health;
}

export function applyMemberWorkSyncTerminalRetirement(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
  receiptId: string;
  outcome?: MemberWorkSyncRecoveryTerminalOutcome;
  pendingAck?: boolean;
}): MemberWorkSyncRecoveryHealth | undefined {
  return patchMemberWorkSyncReservation(
    input.health,
    input.intentId,
    (reservation) => ({
      ...reservation,
      state: 'resolved',
      terminalOutcome: input.outcome ?? 'terminal_refusal',
      terminalReceiptId: input.receiptId,
      ...(input.pendingAck === false ? {} : { pendingAck: true }),
    }),
    { clearUnresolved: true }
  );
}

export function applyMemberWorkSyncTerminalAck(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
  ackIdentity: string;
}): MemberWorkSyncRecoveryHealth | undefined {
  return patchMemberWorkSyncReservation(input.health, input.intentId, (reservation) => ({
    ...reservation,
    pendingAck: undefined,
    compactWitness: true,
    ackIdentity: input.ackIdentity,
  }));
}
