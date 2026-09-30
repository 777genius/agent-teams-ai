import { createHash } from 'node:crypto';

import { parseHostedMessageId } from '../../contracts/hosted';

import type { TeamId } from '@shared/contracts/hosted';

/**
 * Projects an authority-owned inbox row identity into the public hosted message namespace.
 * This stays in the main-process authority boundary so renderer-safe domain code never imports Node.
 */
export function projectHostedInboxMessageId(input: {
  readonly teamId: TeamId;
  readonly rawMessageId: string;
  readonly from: string;
  readonly to: string | null;
}): ReturnType<typeof parseHostedMessageId> {
  return parseHostedMessageId(
    `message_${createHash('sha256')
      .update(JSON.stringify({ domain: 'hosted-team-message-inbox/v1', ...input }), 'utf8')
      .digest('hex')
      .slice(0, 32)}`
  );
}
