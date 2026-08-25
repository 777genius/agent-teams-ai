import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
// eslint-disable-next-line no-restricted-imports -- Hosted task-board authority is main-process-only.
import type { HostedTaskBoardAuthorityPort } from '@features/team-task-board/main/hosted';
import type { WorkspaceMountBinding } from '@features/workspace-registry';

export type HostedTaskBoardMutationFaultPoint =
  | 'wal_fsynced'
  | 'before_target_publish'
  | 'existing_target_postimage_ready'
  | 'existing_target_precommit_validated'
  | 'existing_target_preimage_detached'
  | 'existing_target_replaced'
  | 'task_published'
  | 'kanban_published'
  | 'ledger_published';

export interface HostedTaskBoardMutationFileAuthorityDependencies {
  readonly readSource: Pick<HostedTaskBoardAuthorityPort, 'readWindow'>;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly nowMs?: () => number;
  readonly onFaultPoint?: (
    point: HostedTaskBoardMutationFaultPoint
  ) => void | 'crash' | Promise<void | 'crash'>;
}
