import type {
  ReviewCommandLookup,
  ReviewRecoveryRead,
} from '@agent-teams/task-change-ledger/review-transport';

interface RecoveryPorts {
  read(): Promise<ReviewRecoveryRead>;
  lookup(commandId: string): Promise<ReviewCommandLookup | null>;
}
/** Uses persisted original IDs only. Reloading never re-dispatches a review mutation. */
export async function refreshHostReviewRecovery(
  ports: RecoveryPorts,
  requireSettled: boolean
): Promise<void> {
  const state = await ports.read();
  if (state.commands.length > 64) throw new Error('Review recovery inventory is unavailable');
  let held = false;
  for (const command of state.commands) {
    const original = await ports.lookup(command.commandId);
    if (
      !original ||
      original.commandId !== command.commandId ||
      original.method !== command.method ||
      original.origin.taskId !== state.origin.taskId ||
      original.origin.memberName !== state.origin.memberName
    )
      throw new Error('Original review outcome is unavailable');
    if (original.phase !== 'completed' || original.outcome !== 'completed') held = true;
  }
  if (requireSettled && held)
    throw new Error(
      'Original review outcome is still unknown. Refresh Changes after recovery completes.'
    );
}
