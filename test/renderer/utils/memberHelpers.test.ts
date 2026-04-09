import {
  getLaunchAwarePresenceLabel,
  getSpawnAwareDotClass,
  getSpawnAwarePresenceLabel,
  getSpawnCardClass,
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
        false,
        undefined
      )
    ).toBe('starting');
  });

  it('keeps starting visuals after provisioning already transitioned out of active state', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'spawning',
        'starting',
        undefined,
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');

    expect(getSpawnAwareDotClass(member, 'spawning', 'starting', false, true, false, undefined)).toContain(
      'bg-amber-400'
    );

    expect(getSpawnCardClass('spawning', 'starting', false)).toContain('member-waiting-shimmer');
  });

  it('shows offline instead of stale starting visuals when the team is offline', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'spawning',
        'starting',
        undefined,
        false,
        false,
        false,
        undefined
      )
    ).toBe('offline');

    expect(
      getSpawnAwareDotClass(
        member,
        'spawning',
        'starting',
        false,
        false,
        false,
        undefined
      )
    ).toContain('bg-red-400');

    expect(getSpawnCardClass('spawning', 'starting', false, false, false)).toBe('opacity-40');
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

  it('surfaces retry advisory text instead of plain online while bootstrap contact is still pending', () => {
    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        true,
        false,
        undefined
      )
    ).toContain('retrying now');

    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        false,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        true,
        false,
        undefined
      )
    ).toBe('online');
  });
});
