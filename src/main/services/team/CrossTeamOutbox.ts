import { join } from 'node:path';

import { CrossTeamOutbox as PortableOutbox } from '@agent-teams/legacy-agent-host/cross-team';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';
export type {
  CrossTeamDedupeOptions,
  CrossTeamOutboxMessage,
  CrossTeamRuntimeDeliveryProofInput,
  CrossTeamRuntimeDeliveryReceiptStatus,
} from '@agent-teams/legacy-agent-host/cross-team';
export { CrossTeamRuntimeDeliveryIdempotencyConflictError } from '@agent-teams/legacy-agent-host/cross-team';
/** Existing Desktop callers retain their lazy local context path resolution. */
export class CrossTeamOutbox {
  private readonly delegate = new PortableOutbox({
    filePath: (team) => join(getTeamsBasePath(), team, 'sent-cross-team.json'),
    withFileLock,
    atomicWrite: atomicWriteAsync,
  });
  append(...args: Parameters<PortableOutbox['append']>) {
    return this.delegate.append(...args);
  }
  appendIfNotRecent(...args: Parameters<PortableOutbox['appendIfNotRecent']>) {
    return this.delegate.appendIfNotRecent(...args);
  }
  markRuntimeDeliveryAccepted(...args: Parameters<PortableOutbox['markRuntimeDeliveryAccepted']>) {
    return this.delegate.markRuntimeDeliveryAccepted(...args);
  }
  findAcceptedRuntimeDelivery(...args: Parameters<PortableOutbox['findAcceptedRuntimeDelivery']>) {
    return this.delegate.findAcceptedRuntimeDelivery(...args);
  }
  read(...args: Parameters<PortableOutbox['read']>) {
    return this.delegate.read(...args);
  }
}
