import { describe, expect, it } from 'vitest';

import { type FullPeerObservation,settleFullTeamPeers } from './openCodeFullPeerSettlement';

const targets = [0, 1, 2, 3].map(index => ({ messageId: `peer-${index}`,
  from: index % 2 ? 'alice' : 'bob', to: index % 2 ? 'bob' : 'alice', text: index < 2 ? `CHALLENGE:token-${index}` : `ACK:token-${index}`,
  laneId: 'primary', runtimeSessionId: `session-${index % 2}` }));
function observation(): FullPeerObservation {
  return { rows: targets.map(row => ({ ...row, read: true })),
    receipts: targets.map(row => ({ inboxMessageId: row.messageId, memberName: row.to,
      teamName: 'owned-team', runId: 'owned-run', laneId: row.laneId, runtimeSessionId: row.runtimeSessionId,
      replyRecipient: row.from, status: 'responded', responseState: 'responded_visible_message',
      acceptedAt: '2026-11-11T15:03:00Z', acceptanceUnknown: false,
      runtimePromptMessageId: `prompt-${row.messageId}`, deliveredUserMessageId: `prompt-${row.messageId}`,
      observedAssistantMessageId: `assistant-${row.messageId}`, respondedAt: '2026-11-11T15:03:30Z',
      inboxReadCommittedAt: '2026-11-11T15:04:00Z', inboxReadCommitError: null })) };
}
function clock() {
  let elapsed = 0;
  return { now: () => elapsed, pause: async (ms: number) => { elapsed += ms; } };
}
describe('full team peer settlement', () => {
  it('waits for the fourth exact committed read without resubmitting anything', async () => {
    let reads = 0;
    const result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets, timeoutMs: 4_000,
      ...clock(), read: async () => {
        const value = observation();
        if (++reads === 1) value.rows[3]!.read = false;
        return value;
      } });
    expect(reads).toBe(2);
    expect(result.settled).toBe(true);
    expect(result.checks).toHaveLength(4);
  });
  for (const [name, mutate] of [
    ['read commit error', (value: FullPeerObservation) => { value.receipts[0]!.inboxReadCommitError = 'failed'; }],
    ['cancelled receipt', (value: FullPeerObservation) => { value.receipts[0]!.cancelledAt = '2026-11-11T15:04:01Z'; }],
    ['wrong session', (value: FullPeerObservation) => { value.receipts[0]!.runtimeSessionId = 'other-session'; }],
    ['wrong prompt', (value: FullPeerObservation) => { value.receipts[0]!.deliveredUserMessageId = 'other-prompt'; }],
    ['unknown acceptance', (value: FullPeerObservation) => { value.receipts[0]!.acceptanceUnknown = true; }],
    ['unterminated response', (value: FullPeerObservation) => { value.receipts[0]!.responseState = 'pending'; }],
    ['missing assistant', (value: FullPeerObservation) => { value.receipts[0]!.observedAssistantMessageId = null; }],
    ['wrong run', (value: FullPeerObservation) => { value.receipts[0]!.runId = 'other-run'; }],
    ['wrong text', (value: FullPeerObservation) => { value.rows[0]!.text = 'other-token'; }],
    ['duplicate inbox row', (value: FullPeerObservation) => { value.rows.push(value.rows[0]!); }],
    ['pending receipt', (value: FullPeerObservation) => { value.receipts[0]!.status = 'accepted'; }],
    ['missing commit', (value: FullPeerObservation) => { value.receipts[0]!.inboxReadCommittedAt = null; }],
    ['wrong member', (value: FullPeerObservation) => { value.receipts[0]!.memberName = 'other-member'; }],
  ] as const) {
    it(`times out and retains the unresolved ID for ${name}`, async () => {
      const value = observation(); mutate(value);
      const result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets, timeoutMs: 4_000,
        ...clock(), read: async () => value });
      expect(result.settled).toBe(false);
      expect(result.checks[0]?.messageId).toBe('peer-0');
      expect(result.checks[0]?.inboxRead && result.checks[0]?.readCommitted).toBe(false);
    });
  }
  it('accepts a read-committed exact completed silent ACK without requiring responded status', async () => {
    const value = observation();
    Object.assign(value.receipts[2]!, { status: 'unanswered', responseState: 'empty_assistant_turn',
      lastReason: 'assistant_child_completed_without_visible_or_meaningful_response',
      observedAssistantPreview: '', observedToolCallNames: [], respondedAt: null });
    const result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets,
      timeoutMs: 4_000, ...clock(), read: async () => value });
    expect(result.settled).toBe(true);
  });
  it('rejects a silent ACK without the exact completed-child reason despite a read timestamp', async () => {
    const value = observation();
    Object.assign(value.receipts[2]!, { status: 'unanswered', responseState: 'empty_assistant_turn',
      lastReason: 'session_idle', observedAssistantPreview: '', observedToolCallNames: [] });
    const result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets,
      timeoutMs: 4_000, ...clock(), read: async () => value });
    expect(result.settled).toBe(false);
    expect(result.checks[2]?.readCommitted).toBe(false);
  });
  it('retains read failures and finishes within its observation budget', async () => {
    const result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets, timeoutMs: 4_000,
      ...clock(), read: async () => { throw new Error('unavailable'); } });
    expect(result).toMatchObject({ settled: false, unavailable: true });
  });
  it('leaves cleanup reachable after a never-resolving read without starting another read', async () => {
    let reads = 0;
    let cleanupReached = false;
    let result;
    try {
      result = await settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets, timeoutMs: 10,
        read: () => { reads++; return new Promise<FullPeerObservation>(() => {}); } });
    } finally {
      // Mirrors the harness's finally ordering: bounded observation, then Stop.
      cleanupReached = true;
    }
    expect(cleanupReached).toBe(true);
    expect(reads).toBe(1);
    expect(result).toMatchObject({ settled: false, unavailable: true });
  }, 1_000);

  it('rejects duplicate target IDs before any reads', async () => {
    await expect(settleFullTeamPeers({ teamName: 'owned-team', runId: 'owned-run', targets: [targets[0]!, ...targets.slice(0, 3)],
      timeoutMs: 1, read: async () => { throw new Error('must not read'); } })).rejects.toThrow('Four distinct');
  });
});
