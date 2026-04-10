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
  providerId: 'gemini',
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
        false,
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
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');

    expect(
      getSpawnAwareDotClass(member, 'spawning', 'starting', false, false, true, false, undefined)
    ).toContain(
      'bg-amber-400'
    );

    expect(getSpawnCardClass('spawning', 'starting', false, false)).toContain(
      'member-waiting-shimmer'
    );
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
        false,
        undefined
      )
    ).toContain('bg-red-400');

    expect(getSpawnCardClass('spawning', 'starting', false, false, false, false)).toBe(
      'opacity-40'
    );
  });

  it('keeps runtime-pending teammates in starting state while launch is still settling', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'runtime_pending_bootstrap',
        'process',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toBe('starting');

    expect(
      getSpawnAwareDotClass(
        member,
        'online',
        'runtime_pending_bootstrap',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toContain('bg-zinc-400');

    expect(getSpawnCardClass('online', 'runtime_pending_bootstrap', true, true, true, false)).toContain(
      'member-waiting-shimmer'
    );
  });

  it('shows confirmed teammates as ready instead of idle while launch is still settling', () => {
    expect(
      getSpawnAwarePresenceLabel(
        member,
        'online',
        'confirmed_alive',
        'heartbeat',
        true,
        true,
        true,
        false,
        undefined
      )
    ).toBe('ready');
  });

  it('renders unified retry advisory labels for provider retries', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('Gemini quota retry · 45s');

    expect(
      getMemberRuntimeAdvisoryTitle(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'rate_limited',
          message: 'Gemini cli backend error: rate limit 429.',
        },
        'gemini'
      )
    ).toContain('Gemini rate limited the request');
  });

  it('keeps network advisories provider-neutral and appends raw details to the title', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'network_error',
          message: 'Connection timed out while contacting provider.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('Network retry · 45s');

    expect(
      getMemberRuntimeAdvisoryTitle(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'network_error',
          message: 'Connection timed out while contacting provider.',
        },
        'gemini'
      )
    ).toContain('Connection timed out while contacting provider.');
  });

  it('falls back to the existing generic retry wording when no structured reason is present', () => {
    expect(
      getMemberRuntimeAdvisoryLabel(
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2026-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        'gemini',
        Date.parse('2026-04-07T09:00:00.000Z')
      )
    ).toBe('retrying now · 45s');
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
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toContain('Gemini quota retry');

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
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toBe('starting');
  });

  it('keeps retry advisory visible after contact when the teammate is otherwise just idle or ready', () => {
    expect(
      getLaunchAwarePresenceLabel(
        member,
        'online',
        'confirmed_alive',
        'heartbeat',
        true,
        {
          kind: 'sdk_retrying',
          observedAt: '2026-04-07T09:00:00.000Z',
          retryUntil: '2099-04-07T09:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
        false,
        true,
        false,
        undefined
      )
    ).toContain('Gemini quota retry');
  });
});
