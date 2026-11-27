// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { readHostCrossTeamOutbox } from '../../../src/features/agent-backend/renderer/readHostCrossTeamOutbox';

import type { BackendCrossTeamOutboxRow } from '../../../src/features/agent-backend/contracts/crossTeam';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';

const revision = 'a'.repeat(64);
const signature = 'b'.repeat(64);
const handle = { handleId: 'TEST-outbox-handle' };
const row = (index: number): BackendCrossTeamOutboxRow => ({
  messageId: `TEST-message-${index}`,
  fromTeamResourceRef: 'TEST-source',
  toTeamResourceRef: 'TEST-target',
  fromTeamName: 'alpha',
  toTeamName: 'beta',
  fromMember: 'lead',
  toMember: 'lead',
  conversationId: 'TEST-conversation',
  text: `TEST retained message ${index}`,
  timestamp: '2026-11-27T00:00:00.000Z',
  chainDepth: 0,
});

it('reconstructs all valid retained outbox pages without a new 128-page product limit', async () => {
  const expected = Array.from({ length: 130 }, (_, index) => row(index));
  let nextIndex = 0;
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    expect(request.operation).toBe('crossTeam.outbox.read');
    const index = nextIndex++;
    expect(request.payload).toEqual(index === 0 ? {} : { cursor: `${index}.${signature}` });
    return {
      ok: true,
      value: {
        kind: 'cross-team-outbox',
        rows: [expected[index]!],
        revision,
        nextCursor: index === expected.length - 1 ? null : `${index + 1}.${signature}`,
      },
    };
  });
  await expect(readHostCrossTeamOutbox({ invoke }, handle, () => true)).resolves.toEqual(expected);
  expect(invoke).toHaveBeenCalledTimes(expected.length);
});

it('refuses a cursor that skips a canonical row instead of returning incomplete history', async () => {
  const invoke = vi.fn<AgentBackendApi['invoke']>(async () => ({
    ok: true,
    value: { kind: 'cross-team-outbox', rows: [row(0)], revision, nextCursor: `2.${signature}` },
  }));
  await expect(readHostCrossTeamOutbox({ invoke }, handle, () => true)).rejects.toMatchObject({
    code: 'invalid-result',
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});
