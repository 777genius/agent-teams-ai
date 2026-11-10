import { TeamOwnerError } from '../../../packages/legacy-agent-host/src/team/contracts';
import { pageOwnerMessages } from '../../../packages/legacy-agent-host/src/team/pageOwnerMessages';
import { projectTeamMessagesPage } from '../../../src/features/agent-backend/main/adapters/output/projectTeamMessagesPage';

import type { JsonValue } from '../../../packages/legacy-agent-host/src/contracts';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';

/** Exercise the original Owner cursor/page policy, not the retired renderer-side slice. */
export function mockOwnerMessagesPage(
  snapshot: BackendTeamSnapshot,
  options: { cursor?: string; limit?: number; groupChatId?: string }
) {
  try {
    const value = pageOwnerMessages({
      principalId: 'TEST-principal',
      grant: {
        principalId: 'TEST-principal',
        memberName: 'lead',
        permissions: ['read'],
      },
      teamName: snapshot.teamName,
      key: 'TEST-original-owner-key',
      messages: structuredClone(snapshot.messages) as unknown as JsonValue[],
      ...options,
    });
    return { ok: true as const, value: projectTeamMessagesPage(value) };
  } catch (error) {
    if (!(error instanceof TeamOwnerError)) throw error;
    return { ok: false as const, code: error.code, outcome: 'unknown' as const };
  }
}
