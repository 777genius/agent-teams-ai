import { describeMemberLaunchFailureReason } from '@renderer/utils/memberLaunchFailureReasonText';
import { MEMBER_LAUNCH_GRACE_TIMEOUT_REASON } from '@shared/utils/teamLaunchFailureReason';
import { describe, expect, it, vi } from 'vitest';

describe('describeMemberLaunchFailureReason', () => {
  it('asks the translator for the grace timeout identifier and passes the English fallback', () => {
    const t = vi.fn(() => 'Der Teamkollege ist nicht rechtzeitig beigetreten.');

    expect(describeMemberLaunchFailureReason(MEMBER_LAUNCH_GRACE_TIMEOUT_REASON, t)).toBe(
      'Der Teamkollege ist nicht rechtzeitig beigetreten.'
    );
    expect(t).toHaveBeenCalledWith('members.launchFailure.graceTimeout', {
      defaultValue: 'Teammate did not join within the launch grace window.',
    });
  });

  // Not every surface that prints a failure reason sits inside a component
  // tree. Those still must not print the identifier, so the mapping answers
  // without a translator too.
  it('answers a caller with no translator in readable English', () => {
    expect(describeMemberLaunchFailureReason(MEMBER_LAUNCH_GRACE_TIMEOUT_REASON)).toBe(
      'Teammate did not join within the launch grace window.'
    );
    expect(describeMemberLaunchFailureReason(` ${MEMBER_LAUNCH_GRACE_TIMEOUT_REASON} `)).toBe(
      'Teammate did not join within the launch grace window.'
    );
  });

  // Most failure reasons are already prose written for the reader, so the
  // mapping has to be a lookup and not a rewrite - otherwise the one reason a
  // person needs (a CLI error, a model name) would be replaced by a guess.
  it('returns every other reason exactly as it arrived', () => {
    const t = vi.fn(() => 'unused');

    expect(describeMemberLaunchFailureReason('CLI process exited (code 1)', t)).toBe(
      'CLI process exited (code 1)'
    );
    expect(describeMemberLaunchFailureReason('member launch grace timeout', t)).toBe(
      'member launch grace timeout'
    );
    expect(describeMemberLaunchFailureReason('', t)).toBe('');
    expect(describeMemberLaunchFailureReason(undefined, t)).toBeUndefined();
    expect(t).not.toHaveBeenCalled();
  });
});
