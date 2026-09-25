import type { HostedTaskBoardProductCommitAuthority } from './hostedTaskBoardMutationGrantAuthority';
import type { HostedTaskBoardMutationPublishKind } from './hostedTaskBoardMutationLedger';
import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
// eslint-disable-next-line no-restricted-imports -- Hosted task-board authority is main-process-only.
import type { HostedTaskBoardAuthorityPort } from '@features/team-task-board/main/hosted';
import type { WorkspaceMountBinding } from '@features/workspace-registry';
import type { QueryContext } from '@shared/contracts/hosted';

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

/** A target this authority published past its WAL commit boundary within one request. */
export interface HostedTaskBoardCommittedTarget {
  readonly kind: HostedTaskBoardMutationPublishKind;
  readonly parent: 'team' | 'tasks';
  readonly name: string;
  readonly postimage: string;
}

export interface HostedTaskBoardMutationFileAuthorityDependencies {
  readonly readSource: Pick<HostedTaskBoardAuthorityPort, 'readWindow'>;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  /** Enables strict Product grant and lifecycle checks; omitted only for legacy offline tests. */
  readonly productCommitAuthority?: HostedTaskBoardProductCommitAuthority;
  readonly nowMs?: () => number;
  /** Synchronous and non-throwing: called only after every target of a WAL was published. */
  readonly onCommittedTargets?: (
    context: QueryContext,
    targets: readonly HostedTaskBoardCommittedTarget[]
  ) => void;
  readonly onFaultPoint?: (
    point: HostedTaskBoardMutationFaultPoint
  ) => void | 'crash' | Promise<void | 'crash'>;
}
