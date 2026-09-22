import { createHash, randomUUID } from 'node:crypto';

import type { ReviewDecisionCommandSnapshotIdentityPort } from '../application/ReviewDecisionCommandPorts';

export const nodeReviewDecisionCommandSnapshotIdentity: ReviewDecisionCommandSnapshotIdentityPort =
  {
    now: Date.now,
    createToken: randomUUID,
    fingerprintSnippets: (snippets) =>
      createHash('sha256').update(JSON.stringify(snippets)).digest('hex'),
  };
