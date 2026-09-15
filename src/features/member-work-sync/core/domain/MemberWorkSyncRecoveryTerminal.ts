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

export function applyMemberWorkSyncAcceptedReportRetirement(input: {
  health?: MemberWorkSyncRecoveryHealth;
  reportedAt?: string;
}): MemberWorkSyncRecoveryHealth | undefined {
  const intentId = input.health?.unresolvedIntentId;
  const reservation = input.health?.reservations?.find((entry) => entry.intentId === intentId);
  if (!intentId || !input.reportedAt || !reservation) {
    return input.health;
  }
  if (
    reservation.state !== 'awaiting_outcome' &&
    reservation.state !== 'uncertain' &&
    reservation.state !== 'reserved'
  ) {
    return input.health;
  }
  const startedAtIso =
    reservation.state === 'awaiting_outcome' ? reservation.deliveredAt : reservation.reservedAt;
  if (!startedAtIso) {
    return input.health;
  }
  const reportedAt = Date.parse(input.reportedAt);
  const startedAt = Date.parse(startedAtIso);
  if (!Number.isFinite(reportedAt) || !Number.isFinite(startedAt) || reportedAt < startedAt) {
    return input.health;
  }
  return (
    applyMemberWorkSyncTerminalRetirement({
      health: input.health,
      intentId,
      receiptId: `report-accepted:${intentId}`,
      outcome: 'settled',
      pendingAck: false,
    }) ?? input.health
  );
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
