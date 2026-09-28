import {
  type HostedTaskExternalWriterAuthority,
  HostedTaskExternalWriterReconciler,
} from '../adapters/output/external-writer';
import { HostedTaskBoardAuthorityAdapter } from '../adapters/output/HostedTaskBoardAuthorityAdapter';
import { HostedTaskBoardMutationAuthorityAdapter } from '../adapters/output/HostedTaskBoardMutationAuthorityAdapter';
import { mutationPayloadFingerprint } from '../adapters/output/HostedTaskBoardMutationAuthorityAdapter';

import type {
  HostedTaskCreationCommand,
  ObserveHostedTaskCreationResult,
} from '../../contracts/hosted';
import type {
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../ports/HostedTaskBoardAuthorityPort';
import type { QueryContext } from '@shared/contracts/hosted';

export interface HostedTeamTaskBoardOutputAdapters {
  readonly pageSource: HostedTaskBoardPageSourcePort;
  readonly observeTaskCreation?: (
    original: HostedTaskCreationCommand,
    context: QueryContext
  ) => Promise<ObserveHostedTaskCreationResult>;
  /** Absent until a host supplies the generation-first mutation authority. */
  readonly mutationAdmission?: HostedTaskMutationAdmissionPort;
  /**
   * Deferred composition seam for the shared ExternalWriterObserver. The host
   * supplies its atomic task-effect authority; this feature never starts a
   * watcher or issues lifecycle commands.
   */
  readonly externalWriterReconciliation?: HostedTaskExternalWriterReconciler;
}

export function createHostedTeamTaskBoardOutputAdapters(
  authority: HostedTaskBoardAuthorityPort,
  options: { readonly externalWriterAuthority?: HostedTaskExternalWriterAuthority } = {}
): HostedTeamTaskBoardOutputAdapters {
  const pageSource = new HostedTaskBoardAuthorityAdapter(authority);
  const observeTaskCreation =
    typeof authority.observeTaskCreation === 'function'
      ? (original: HostedTaskCreationCommand, context: QueryContext) =>
          authority.observeTaskCreation!(
            Object.freeze({ original, payloadFingerprint: mutationPayloadFingerprint(original) }),
            context
          )
      : undefined;
  const externalWriterReconciliation = options.externalWriterAuthority
    ? new HostedTaskExternalWriterReconciler(options.externalWriterAuthority)
    : undefined;
  if (typeof authority.admitTaskMutation !== 'function') {
    return Object.freeze({
      pageSource,
      ...(observeTaskCreation === undefined ? {} : { observeTaskCreation }),
      ...(externalWriterReconciliation === undefined ? {} : { externalWriterReconciliation }),
    });
  }

  const mutationAdmission = new HostedTaskBoardMutationAuthorityAdapter(authority);
  return Object.freeze({
    pageSource,
    ...(observeTaskCreation === undefined ? {} : { observeTaskCreation }),
    mutationAdmission,
    ...(externalWriterReconciliation === undefined ? {} : { externalWriterReconciliation }),
  });
}
