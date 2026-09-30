import {
  type HostedMessageExternalWriterAuthority,
  HostedMessageExternalWriterReconciler,
} from '../adapters/output/external-writer';
import { HostedTeamMessageAuthorityAdapter } from '../adapters/output/HostedTeamMessageAuthorityAdapter';

import type {
  HostedMessagePageSourcePort,
  HostedTeamMessageSendPort,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type { HostedTeamMessageAuthorityPort } from '../ports/HostedTeamMessageAuthorityPort';

export interface HostedTeamMessageOutputAdapters {
  readonly pageSource: HostedMessagePageSourcePort;
  readonly sender: HostedTeamMessageSendPort;
  /**
   * Deferred seam for the shared ExternalWriterObserver. The host provides the
   * atomic message-effect authority; no watcher, lifecycle, or delivery owner
   * is constructed here.
   */
  readonly externalWriterReconciliation?: HostedMessageExternalWriterReconciler;
}

/** Uses one authority adapter instance so reads and sends share the same fence. */
export function createHostedTeamMessageOutputAdapters(
  authority: HostedTeamMessageAuthorityPort,
  options: {
    readonly externalWriterAuthority?: HostedMessageExternalWriterAuthority;
    readonly reportReadDiagnostic?: (stage: string, code: string) => void;
  } = {}
): HostedTeamMessageOutputAdapters {
  const adapter = new HostedTeamMessageAuthorityAdapter(
    authority,
    Date.now,
    options.reportReadDiagnostic
  );
  const externalWriterReconciliation = options.externalWriterAuthority
    ? new HostedMessageExternalWriterReconciler(options.externalWriterAuthority)
    : undefined;
  return Object.freeze({
    pageSource: adapter,
    sender: adapter,
    ...(externalWriterReconciliation === undefined ? {} : { externalWriterReconciliation }),
  });
}
