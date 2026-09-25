import { WorkspaceMountBinding } from '@features/workspace-registry';

import { createHostedTaskBoardMutationFileAuthority } from './hostedTaskBoardMutationFileAuthority';
import { DescriptorBoundHostedTaskBoardReadSource } from './hostedTaskBoardReadFileSource';
import { createSupervisorTaskSelfWriteCoordinator } from './hostedTaskBoardSelfWrite';
import {
  ProductTaskCommittedTargets,
  ProductTaskMutationAuthority,
} from './productTaskMutationAuthority';
import {
  type ProductTaskAssignmentCurrentGateway,
  ProductTaskWriteCommitAuthority,
} from './productTaskWriteCommitAuthority';
import { ProductTaskWriteFileSerialization } from './productTaskWriteSerialization';

import type { HostedExternalWriterInventorySupervisor } from './hostedExternalWriterInventorySupervisor';
import type { OrchestratorLifecycleOwnerBinding } from './hostedLifecycleOrchestratorReadiness';
import type { HostedTaskBoardWriterEpochAuthority } from './hostedTaskBoardMutationWalTakeover';
import type { TeamIdentityReadGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

export interface CreateProductTaskMutationAuthorityOptions {
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly productAuthorityLockDirectory: string | undefined;
  readonly expectedOwnerBinding: OrchestratorLifecycleOwnerBinding | null;
  readonly currentOwnerBinding: () => OrchestratorLifecycleOwnerBinding | null;
  readonly restoreGeneration: number;
  readonly taskWriteCurrent: ProductTaskAssignmentCurrentGateway | null;
  /** Product's deployment authority rows, so a WAL left by a superseded writer epoch is recovered. */
  readonly writerEpochAuthority: HostedTaskBoardWriterEpochAuthority | null;
  readonly externalWriterSupervisor: () => HostedExternalWriterInventorySupervisor | null;
  readonly reportDiagnostic?: (stage: string, code: string) => void;
}

/**
 * Composes Product's hosted task writer. Any missing prerequisite returns null so the task-board
 * composition never advertises the mutation capability; the Owner is never asked to write tasks.
 */
export function createProductTaskMutationAuthority(
  options: CreateProductTaskMutationAuthorityOptions
): ProductTaskMutationAuthority | null {
  const { runtimeInstance, mountBinding } = options;
  if (
    !(mountBinding instanceof WorkspaceMountBinding) ||
    mountBinding.health !== 'healthy' ||
    options.productAuthorityLockDirectory === undefined ||
    options.expectedOwnerBinding === null ||
    options.taskWriteCurrent === null ||
    options.writerEpochAuthority === null
  ) {
    return null;
  }
  const taskWriteCurrent = options.taskWriteCurrent;
  try {
    const serialization = new ProductTaskWriteFileSerialization(
      options.productAuthorityLockDirectory
    );
    const commitAuthority = new ProductTaskWriteCommitAuthority({
      current: () => taskWriteCurrent,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      expectedOwner: options.expectedOwnerBinding,
      currentOwner: options.currentOwnerBinding,
      restoreGeneration: options.restoreGeneration,
      mountGeneration: mountBinding.mountGeneration,
    });
    const committed = new ProductTaskCommittedTargets();
    const files = createHostedTaskBoardMutationFileAuthority({
      readSource: new DescriptorBoundHostedTaskBoardReadSource({
        runtimeInstance,
        mountBinding,
        teamIdentities: options.teamIdentities,
      }),
      runtimeInstance,
      mountBinding,
      teamIdentities: options.teamIdentities,
      productCommitAuthority: commitAuthority,
      writerEpochAuthority: options.writerEpochAuthority,
      onCommittedTargets: (context, targets) => committed.record(context, targets),
    });
    return new ProductTaskMutationAuthority(
      files,
      serialization,
      commitAuthority,
      createSupervisorTaskSelfWriteCoordinator(options.externalWriterSupervisor),
      committed
    );
  } catch (error) {
    options.reportDiagnostic?.(
      'task-mutation-authority-unavailable',
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(error.message)
        ? error.message
        : 'unknown'
    );
    return null;
  }
}
