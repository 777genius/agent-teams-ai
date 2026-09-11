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
  const nextReservations = [...reservations];
  nextReservations[index] = patch(reservations[index]!);
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
}): MemberWorkSyncRecoveryHealth | undefined {
  return patchMemberWorkSyncReservation(input.health, input.intentId, (reservation) => ({
    ...reservation,
    state: 'awaiting_outcome',
  }));
}

export function applyMemberWorkSyncTerminalRetirement(input: {
  health?: MemberWorkSyncRecoveryHealth;
  intentId: string;
  receiptId: string;
  outcome?: MemberWorkSyncRecoveryTerminalOutcome;
}): MemberWorkSyncRecoveryHealth | undefined {
  return patchMemberWorkSyncReservation(
    input.health,
    input.intentId,
    (reservation) => ({
      ...reservation,
      state: 'resolved',
      terminalOutcome: input.outcome ?? 'terminal_refusal',
      terminalReceiptId: input.receiptId,
      pendingAck: true,
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
