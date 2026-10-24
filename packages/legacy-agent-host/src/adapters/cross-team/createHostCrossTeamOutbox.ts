import { join } from 'node:path';
import { atomicWriteAsync } from '@agent-teams/task-change-ledger/review-io';
import { CrossTeamOutbox } from '../../cross-team/CrossTeamOutbox.js';
import { safeSegment } from '../../team/identity.js';
import { withFileLock } from './fileLock.js';

/** Explicit captured Host root; the existing durable outbox owns delivery deduplication. */
export function createHostCrossTeamOutbox(root: string): CrossTeamOutbox {
  return new CrossTeamOutbox({
    filePath: (teamName) => join(root, 'teams', safeSegment(teamName), 'sent-cross-team.json'),
    withFileLock,
    atomicWrite: atomicWriteAsync,
  });
}
