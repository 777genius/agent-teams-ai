import { z } from 'zod';

import { safeSegment } from '../team/identity.js';

/** Strict read request only; TeamOwner alone supplies the authenticated principal and grant. */
export function parseMessagesPageQuery(value: unknown) {
  const query = z
    .object({
      cursor: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      groupChatId: z.string().min(1).max(128).optional(),
    })
    .strict()
    .parse(value);
  if (query.groupChatId !== undefined) safeSegment(query.groupChatId);
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.groupChatId === undefined ? {} : { groupChatId: query.groupChatId }),
  };
}
