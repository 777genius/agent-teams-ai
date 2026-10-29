import { createHash } from 'node:crypto';

import { readImportBytes } from '@agent-teams/legacy-agent-host/stopped-team-import';

export interface StoppedImportCommentFacts {
  known: boolean;
  pending: number;
  revision: string;
}
export const unknownStoppedImportCommentFacts = (): StoppedImportCommentFacts => ({
  known: false,
  pending: 0,
  revision: '',
});
/** Strict census, unlike notification delivery's forgiving sanitizer. */
export function stoppedImportCommentFacts(value: unknown): StoppedImportCommentFacts {
  if (!Array.isArray(value) || value.length > 4096) return unknownStoppedImportCommentFacts();
  if (
    value.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        ['key', 'taskId', 'commentId', 'author', 'createdAt', 'updatedAt'].some(
          (key) => typeof entry[key] !== 'string' || !entry[key]
        ) ||
        !['seeded', 'pending_send', 'sent'].includes(entry.state)
    )
  )
    return unknownStoppedImportCommentFacts();
  return {
    known: true,
    pending: value.filter((entry) => entry.state === 'pending_send').length,
    revision: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
}
export function readStoppedImportCommentJson(path: string): StoppedImportCommentFacts {
  try {
    return stoppedImportCommentFacts(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(readImportBytes(path, 512 * 1024))
      )
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? stoppedImportCommentFacts([])
      : unknownStoppedImportCommentFacts();
  }
}
