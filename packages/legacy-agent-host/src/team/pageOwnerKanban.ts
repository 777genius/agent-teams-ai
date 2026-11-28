import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { pageOwnerSnapshot } from './pageOwnerSnapshot.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';
import type { TeamGrant } from './contracts.js';

/** Dedicated board pages avoid scanning the entire task/message history.
 * All continuations use the existing Owner signed snapshot pager.
 */
export function pageOwnerKanban(options: {
  principalId: string;
  grant: TeamGrant;
  key: string;
  teamName: string;
  board: unknown;
  cursor?: string;
}): JsonValue {
  const board = json(options.board);
  if (!board || typeof board !== 'object' || Array.isArray(board))
    throw new TeamOwnerError('hold');
  const page = pageOwnerSnapshot({
    principalId: options.principalId,
    key: digest({ key: options.key, protocol: 'kanban-only-v1' }),
    snapshot: json({
      teamName: options.teamName,
      revision: digest({ board, grant: options.grant }),
      tasks: [],
      messages: [],
      kanbanState: board,
    }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    maxBytes: 128 * 1024,
  }) as Record<string, JsonValue>;
  if (page.nextCursor === null && options.cursor === undefined)
    return board; // Existing small kanban_get contract remains unchanged.
  const part = page.kanbanState;
  if (!part || typeof part !== 'object' || Array.isArray(part))
    throw new TeamOwnerError('hold');
  return json({
    ...part,
    revision: page.revision,
    nextCursor: page.nextCursor,
  });
}
