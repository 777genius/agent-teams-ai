import { createHash } from 'node:crypto';

import type { HostedExternalWriterInventorySupervisor } from './hostedExternalWriterInventorySupervisor';
import type { HostedTaskBoardCommittedTarget } from './hostedTaskBoardMutationFileAuthorityTypes';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedTaskBoardSelfWriteEffect {
  readonly fileKey: string;
  readonly expectedChecksum: string;
}

/**
 * Registers Product-owned task-file writes with the external-writer observer. Begin must precede
 * the first published byte so the observer holds the team's task scope until complete or abort.
 */
export interface HostedTaskBoardSelfWriteCoordinator {
  beginTaskSelfWrite(operationId: string, teamId: TeamId): Promise<void>;
  completeTaskSelfWrite(
    operationId: string,
    effects: readonly HostedTaskBoardSelfWriteEffect[]
  ): Promise<void>;
  abortTaskSelfWrite(operationId: string): Promise<void>;
}

const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,239})\.json$/u;

/** Resolves the supervisor per call: it starts after routes are composed and may be replaced. */
export function createSupervisorTaskSelfWriteCoordinator(
  getSupervisor: () => HostedExternalWriterInventorySupervisor | null
): HostedTaskBoardSelfWriteCoordinator {
  const required = (): HostedExternalWriterInventorySupervisor => {
    const supervisor = getSupervisor();
    if (!supervisor) throw new Error('hosted-external-writer-self-write-unavailable');
    return supervisor;
  };
  return Object.freeze({
    beginTaskSelfWrite: async (operationId: string, teamId: TeamId) =>
      required().beginTaskSelfWrite(operationId, teamId),
    completeTaskSelfWrite: async (
      operationId: string,
      effects: readonly HostedTaskBoardSelfWriteEffect[]
    ) => required().completeTaskSelfWrite(operationId, effects),
    abortTaskSelfWrite: async (operationId: string) =>
      getSupervisor()?.abortTaskSelfWrite(operationId),
  });
}

/**
 * Only task files are inventoried by the observer; kanban state and the mutation ledger are not.
 * The checksum matches the observer's sha256 over the exact published UTF-8 bytes.
 */
export function hostedTaskBoardSelfWriteEffects(
  targets: readonly HostedTaskBoardCommittedTarget[]
): readonly HostedTaskBoardSelfWriteEffect[] {
  const effects: HostedTaskBoardSelfWriteEffect[] = [];
  for (const target of targets) {
    if (target.kind !== 'task' || target.parent !== 'tasks') continue;
    const matched = TASK_FILE.exec(target.name);
    if (matched === null) throw new TypeError('hosted-task-board-self-write-target-invalid');
    effects.push(
      Object.freeze({
        fileKey: matched[1],
        expectedChecksum: createHash('sha256').update(target.postimage, 'utf8').digest('hex'),
      })
    );
  }
  return Object.freeze(effects);
}
