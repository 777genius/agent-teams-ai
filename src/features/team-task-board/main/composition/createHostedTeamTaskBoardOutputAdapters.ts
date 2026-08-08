import {
  type HostedTaskExternalWriterAuthority,
  HostedTaskExternalWriterReconciler,
} from '../adapters/output/external-writer';
import { HostedTaskBoardAuthorityAdapter } from '../adapters/output/HostedTaskBoardAuthorityAdapter';
import { HostedTaskBoardMutationAuthorityAdapter } from '../adapters/output/HostedTaskBoardMutationAuthorityAdapter';

import type {
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../ports/HostedTaskBoardAuthorityPort';

export interface HostedTeamTaskBoardOutputAdapters {
  readonly pageSource: HostedTaskBoardPageSourcePort;
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
  const externalWriterReconciliation = options.externalWriterAuthority
    ? new HostedTaskExternalWriterReconciler(options.externalWriterAuthority)
    : undefined;
  if (typeof authority.admitTaskMutation !== 'function') {
    return Object.freeze({
      pageSource,
      ...(externalWriterReconciliation === undefined ? {} : { externalWriterReconciliation }),
    });
  }

  const mutationAdmission = new HostedTaskBoardMutationAuthorityAdapter(authority);
  return Object.freeze({
    pageSource,
    mutationAdmission,
    ...(externalWriterReconciliation === undefined ? {} : { externalWriterReconciliation }),
  });
}
