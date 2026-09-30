import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeMemberInboxDeliveryDecision,
  selectOpenCodeMemberInboxRelayUnreadMessages,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';

import type { InboxMessage } from '@shared/types';

// The same bytes live in agent_teams_orchestrator docs/; its hosted inbox pump
// relays teammate rows with a copy of these rules and pins this digest too.
const GOLDEN_SHA256 = '0a331b8a9503e8057b6ed4b6dbab3488e3fb2d0e948ae3563a0d76fb8a30a6b6';

interface Golden {
  readonly format: string;
  readonly cases: readonly {
    readonly name: string;
    readonly recipient: string;
    readonly rows: readonly InboxMessage[];
    readonly expected: readonly { readonly messageId: string; readonly replyRecipient: string }[];
  }[];
}

describe('OpenCode member inbox relay selection cross-repository golden', () => {
  it('selects, orders and addresses rows exactly as the orchestrator copy', () => {
    const raw = readFileSync(resolve('docs/opencode-inbox-relay-selection-golden.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
    const golden = JSON.parse(raw.toString('utf8')) as Golden;
    expect(golden.format).toBe('agent-teams.opencode-inbox-relay-selection-golden/v1');
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const entry of golden.cases) {
      const selected = selectOpenCodeMemberInboxRelayUnreadMessages({
        inboxMessages: entry.rows,
      }).map((message) => ({
        messageId: message.messageId,
        replyRecipient: resolveOpenCodeMemberInboxDeliveryDecision({
          memberName: entry.recipient,
          message,
          inferredTaskRefs: [],
        }).replyRecipient,
      }));
      expect({ name: entry.name, selected }).toEqual({
        name: entry.name,
        selected: entry.expected,
      });
    }
  });
});
