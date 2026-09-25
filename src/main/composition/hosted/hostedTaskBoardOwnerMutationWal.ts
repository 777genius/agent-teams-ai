import {
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';

/** The personal-host Owner task writer's WAL; its transaction format belongs to the Owner. */
export const HOSTED_OWNER_TASK_MUTATION_WAL_FILE = 'hosted-task-board-owner-mutation.wal.v1.json';
/** An Owner commit publishes a few small files; the board page read retries shortly after. */
export const HOSTED_OWNER_TASK_MUTATION_RETRY_AFTER_MS = 250;
// The Owner bounds its own WAL at 8 MiB.
const MAX_OWNER_WAL_BYTES = 8 * 1024 * 1024;

export interface HostedOwnerTaskMutationWalObservation {
  /** A prepared Owner transaction may have published only part of its task-board files. */
  readonly prepared: boolean;
  readonly snapshot: HostedTaskBoardFileSnapshot;
}

/** Reads only the Owner WAL phase; any other shape fails closed like an unreadable board. */
export async function observeHostedOwnerTaskMutationWal(
  teamDirectory: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<HostedOwnerTaskMutationWalObservation> {
  const snapshot = await readHostedTaskBoardFile(
    teamDirectory,
    HOSTED_OWNER_TASK_MUTATION_WAL_FILE,
    MAX_OWNER_WAL_BYTES,
    { optional: true, assertStillActive }
  );
  if (!snapshot.exists) return Object.freeze({ prepared: false, snapshot });
  const value: unknown = JSON.parse(snapshot.text);
  const phase =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).phase
      : undefined;
  if (phase !== 'prepared' && phase !== 'terminal') {
    throw new Error('hosted-task-board-owner-mutation-wal-phase-invalid');
  }
  return Object.freeze({ prepared: phase === 'prepared', snapshot });
}
