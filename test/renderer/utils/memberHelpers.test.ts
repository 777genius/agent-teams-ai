import {
  getSpawnAwareDotClass,
  getSpawnAwarePresenceLabel,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
} from '@renderer/utils/memberHelpers';

import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  removedAt: undefined,
};

describe('memberHelpers spawn-aware presence', () => {
  it('shows process-online teammates as online with a green dot', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        true,
        false,
        undefined
      )
    ).toBe('online');

    expect(
      getSpawnAwareDotClass(
        member,
        'online',
        'runtime_pending_bootstrap',
        true,
        false,
        undefined
      )
    ).toContain('bg-emerald-400');
  });

  it('keeps accepted-but-not-yet-online teammates in starting state', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'waiting',
        'starting',
        undefined,
        false,
        true,
        true,
        undefined
      )
    ).toBe('starting');
  });

  it('renders unified retry advisory labels for provider retries', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('retrying now · 45s');

    expect(
      getMemberRuntimeAdvisoryTitle({
        kind: 'sdk_retrying',
        observedAt: '2026-04-07T09:00:00.000Z',
        retryUntil: '2026-04-07T09:00:45.000Z',
        retryDelayMs: 45_000,
        message: 'Gemini cli backend error: capacity exceeded.',
      })
    ).toContain('capacity exceeded');
  });
});
