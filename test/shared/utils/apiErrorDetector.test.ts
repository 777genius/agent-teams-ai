import { isActionableApiErrorMessage, isApiErrorMessage } from '@shared/utils/apiErrorDetector';
import { describe, expect, it } from 'vitest';

describe('apiErrorDetector', () => {
  it('detects provider quota and rate-limit output', () => {
    expect(isApiErrorMessage('API Error: 429 {"error":"rate_limit"}')).toBe(true);
    expect(isApiErrorMessage("You're out of extra usage \\u00b7 resets 11:50pm (Europe/Kiev)")).toBe(
      true
    );
    expect(isApiErrorMessage('Provider returned rate-limited response')).toBe(true);
    expect(isApiErrorMessage('Quota exhausted for this account')).toBe(true);
  });

  it('does not flag normal lead thoughts', () => {
    expect(isApiErrorMessage('OK, I received this and will continue.')).toBe(false);
  });
});

describe('isActionableApiErrorMessage', () => {
  it('flags explicit API error lines and the out-of-usage notice', () => {
    expect(isActionableApiErrorMessage('API Error: 429 {"error":"rate_limit"}')).toBe(true);
    expect(isActionableApiErrorMessage('API Error: 500 server failed')).toBe(true);
    expect(
      isActionableApiErrorMessage("You're out of extra usage \\u00b7 resets 11:50pm (Europe/Kiev)")
    ).toBe(true);
  });

  it('does NOT fire on ordinary agent prose that merely mentions rate limits or quota', () => {
    // These would previously trip the broadened isApiErrorMessage patterns and
    // raise a spurious "API Error ??? / Manual restart needed" notification.
    expect(isActionableApiErrorMessage('I added rate limiting and we hit the rate limit once.')).toBe(
      false
    );
    expect(isActionableApiErrorMessage('The upstream endpoint got rate-limited yesterday.')).toBe(
      false
    );
    expect(isActionableApiErrorMessage('We should handle the case where quota exceeded events fire.')).toBe(
      false
    );
    expect(isActionableApiErrorMessage('Provider returned rate-limited response')).toBe(false);
    expect(isActionableApiErrorMessage('OK, I received this and will continue.')).toBe(false);
  });
});
