import { describe, expect, it } from 'vitest';

import {
  isRateLimitMessage,
  parseRateLimitResetTime,
} from '../../../src/shared/utils/rateLimitDetector';

// Helper: every production rate-limit message starts with this substring.
// Prefix test inputs so they clear the parser's rate-limit-context gate.
const RL = "You've hit your limit. ";
const MODEL_COOLDOWN_API_ERROR =
  'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-4-6 are cooling down via provider claude","model":"claude-opus-4-6","provider":"claude","reset_seconds":41,"reset_time":"40s"}}';
const MODEL_COOLDOWN_NO_SECONDS_API_ERROR =
  'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-4-6 are cooling down via provider claude","model":"claude-opus-4-6","provider":"claude","reset_time":"40s"}}';

describe('isRateLimitMessage', () => {
  it('detects the canonical substring', () => {
    expect(isRateLimitMessage("You've hit your limit")).toBe(true);
    expect(
      isRateLimitMessage("You've hit your limit. Your limit will reset at 3pm (PST).")
    ).toBe(true);
  });

  it('returns false for unrelated text', () => {
    expect(isRateLimitMessage('All good here')).toBe(false);
    expect(isRateLimitMessage('hit the limit')).toBe(false); // missing "You've"
    expect(isRateLimitMessage('')).toBe(false);
  });

  it('detects structured model_cooldown API errors as rate limits', () => {
    expect(isRateLimitMessage(MODEL_COOLDOWN_API_ERROR)).toBe(true);
  });
});

describe('parseRateLimitResetTime', () => {
  // ---------------------------------------------------------------------
  // Rate-limit context gate
  // ---------------------------------------------------------------------

  it('returns null for text that is not a rate-limit message', () => {
    // Even if the text contains a parseable "reset at X" clause, the parser
    // must refuse to interpret it when the rate-limit context is absent.
    // Protects against false positives like "reset at 3pm (PST)" appearing
    // in unrelated prose.
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime('Please reset your expectations at 3pm (PST).', now)
    ).toBeNull();
    expect(parseRateLimitResetTime('Resets in 2 hours.', now)).toBeNull();
  });

  it('parses model_cooldown reset_seconds from structured API errors', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(MODEL_COOLDOWN_API_ERROR, now);
    expect(result?.toISOString()).toBe('2026-04-17T12:00:41.000Z');
  });

  it('falls back to structured reset_time when reset_seconds is missing', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(MODEL_COOLDOWN_NO_SECONDS_API_ERROR, now);
    expect(result?.toISOString()).toBe('2026-04-17T12:00:40.000Z');
  });

  // ---------------------------------------------------------------------
  // Relative durations
  // ---------------------------------------------------------------------

  it('parses "resets in N hours"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets in 2 hours.`, now);
    expect(result?.toISOString()).toBe('2026-04-17T14:00:00.000Z');
  });

  it('parses "resets in N minutes"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Will reset in 45 minutes.`, now);
    expect(result?.toISOString()).toBe('2026-04-17T12:45:00.000Z');
  });

  it('parses "resets in N seconds"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets in 90 seconds.`, now);
    expect(result?.toISOString()).toBe('2026-04-17T12:01:30.000Z');
  });

  it('parses "hrs" and "mins" abbreviations', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime(`${RL}Resets in 3 hrs.`, now)?.toISOString()
    ).toBe('2026-04-17T15:00:00.000Z');
    expect(
      parseRateLimitResetTime(`${RL}Resets in 15 mins.`, now)?.toISOString()
    ).toBe('2026-04-17T12:15:00.000Z');
  });

  it('parses bare "h" / "m" / "s" single-letter units', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(parseRateLimitResetTime(`${RL}Resets in 2 h.`, now)?.toISOString()).toBe(
      '2026-04-17T14:00:00.000Z'
    );
    expect(parseRateLimitResetTime(`${RL}Resets in 30 m.`, now)?.toISOString()).toBe(
      '2026-04-17T12:30:00.000Z'
    );
    expect(parseRateLimitResetTime(`${RL}Resets in 45 s.`, now)?.toISOString()).toBe(
      '2026-04-17T12:00:45.000Z'
    );
  });

  it('parses "resets in about 30 minutes" with filler words', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(
      `${RL}Your limit will reset in about 30 minutes.`,
      now
    );
    expect(result?.toISOString()).toBe('2026-04-17T12:30:00.000Z');
  });

  it('parses "around" and "~" filler variants', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime(`${RL}Your limit will reset in around 30 minutes.`, now)?.toISOString()
    ).toBe('2026-04-17T12:30:00.000Z');
    expect(
      parseRateLimitResetTime(`${RL}Your limit will reset in ~ 45 seconds.`, now)?.toISOString()
    ).toBe('2026-04-17T12:00:45.000Z');
  });

  it('parses fractional hours', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets in 1.5 hours.`, now);
    expect(result?.toISOString()).toBe('2026-04-17T13:30:00.000Z');
  });

  // ---------------------------------------------------------------------
  // Absolute clock times with timezone
  // ---------------------------------------------------------------------

  it('parses "resets at 3pm (PST)"', () => {
    // 3pm PST = 23:00 UTC (PST = UTC-8)
    const now = new Date('2026-04-17T12:00:00Z'); // earlier than 23:00 UTC
    const result = parseRateLimitResetTime(
      `${RL}Your limit will reset at 3pm (PST).`,
      now
    );
    expect(result?.toISOString()).toBe('2026-04-17T23:00:00.000Z');
  });

  it('parses "resets at 3:30 pm (PST)"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(
      `${RL}Your limit will reset at 3:30 pm (PST).`,
      now
    );
    expect(result?.toISOString()).toBe('2026-04-17T23:30:00.000Z');
  });

  it('parses 24-hour time with UTC', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(
      `${RL}Your limit will reset at 15:30 UTC.`,
      now
    );
    expect(result?.toISOString()).toBe('2026-04-17T15:30:00.000Z');
  });

  it('parses bare timezone abbreviation without parentheses', () => {
    // Regex group 5 path: "3pm PST" (no parens) should parse same as "(PST)".
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(
      `${RL}Your limit will reset at 3pm PST.`,
      now
    );
    expect(result?.toISOString()).toBe('2026-04-17T23:00:00.000Z');
  });

  it('parses non-PST North American timezones', () => {
    // Cover each zone in the whitelist — regression guard against map typos.
    const now = new Date('2026-04-17T02:00:00Z');
    // 3am EST = UTC-5 → 08:00 UTC
    expect(
      parseRateLimitResetTime(`${RL}Resets at 3am (EST).`, now)?.toISOString()
    ).toBe('2026-04-17T08:00:00.000Z');
    // 3am EDT = UTC-4 → 07:00 UTC
    expect(
      parseRateLimitResetTime(`${RL}Resets at 3am (EDT).`, now)?.toISOString()
    ).toBe('2026-04-17T07:00:00.000Z');
    // 3am CST = UTC-6 → 09:00 UTC
    expect(
      parseRateLimitResetTime(`${RL}Resets at 3am (CST).`, now)?.toISOString()
    ).toBe('2026-04-17T09:00:00.000Z');
    // 3am MDT = UTC-6 → 09:00 UTC
    expect(
      parseRateLimitResetTime(`${RL}Resets at 3am (MDT).`, now)?.toISOString()
    ).toBe('2026-04-17T09:00:00.000Z');
  });

  it('rolls forward to tomorrow when the time has already passed today', () => {
    // 3pm PST = 23:00 UTC; if "now" is 23:30 UTC, the parsed 23:00 should
    // roll to tomorrow rather than return a time in the past.
    const now = new Date('2026-04-17T23:30:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 3pm (PST).`, now);
    expect(result?.toISOString()).toBe('2026-04-18T23:00:00.000Z');
  });

  it('does NOT roll forward for near-present timestamps (within the 1-minute tolerance)', () => {
    // Parsed time is 20s in the past (stale message / clock skew). A full
    // 24h rollover here would trip the scheduler's 12h ceiling and silently
    // drop auto-resume. Instead, the parser returns the near-past time and
    // lets the scheduler's buffer + Math.max(0, ...) clamp take over.
    const now = new Date('2026-04-17T23:00:20Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 3pm (PST).`, now);
    // 3pm PST = 23:00 UTC (today) — stays in the past, not rolled.
    expect(result?.toISOString()).toBe('2026-04-17T23:00:00.000Z');
  });

  it('resolves the zone-local calendar date when UTC and zone disagree on the day', () => {
    // now = 2026-04-18T01:00:00Z which is still 2026-04-17 17:00 PST.
    // "8pm (PST)" on that PST day = 2026-04-17T20:00 PST = 2026-04-18T04:00Z.
    // A naive UTC-anchored build would emit 2026-04-19T04:00Z (24h off).
    const now = new Date('2026-04-18T01:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 8pm (PST).`, now);
    expect(result?.toISOString()).toBe('2026-04-18T04:00:00.000Z');
  });

  it('handles the mirror case for positive offsets crossing the UTC day', () => {
    // 02:00 UTC today is already in the past vs 23:00 UTC → roll to tomorrow.
    const now = new Date('2026-04-17T23:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 02:00 UTC.`, now);
    expect(result?.toISOString()).toBe('2026-04-18T02:00:00.000Z');
  });

  it('handles 12am (midnight) correctly', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 12am UTC.`, now);
    // Same day midnight is already in the past relative to noon; rolls to next day.
    expect(result?.toISOString()).toBe('2026-04-18T00:00:00.000Z');
  });

  it('handles 12pm (noon) correctly', () => {
    const now = new Date('2026-04-17T06:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Resets at 12pm UTC.`, now);
    expect(result?.toISOString()).toBe('2026-04-17T12:00:00.000Z');
  });

  // ---------------------------------------------------------------------
  // Day-shift qualifiers — should bail out rather than guess today/tomorrow
  // ---------------------------------------------------------------------

  it('returns null when the reset is qualified with "next week"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime(`${RL}Reset at 3pm (PST) next week.`, now)
    ).toBeNull();
  });

  it('returns null when the reset is qualified with "tomorrow"', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime(`${RL}Reset at 9am UTC tomorrow.`, now)
    ).toBeNull();
  });

  it('returns null when the reset is qualified with a day of week', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(
      parseRateLimitResetTime(`${RL}Reset at 3pm (PST) on Tuesday.`, now)
    ).toBeNull();
    expect(
      parseRateLimitResetTime(`${RL}Reset at 9am UTC on Mon.`, now)
    ).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Unparseable / ambiguous cases
  // ---------------------------------------------------------------------

  it('returns null when no reset time is present', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(parseRateLimitResetTime("You've hit your limit.", now)).toBeNull();
    expect(parseRateLimitResetTime('', now)).toBeNull();
  });

  it('returns null for unknown parenthesized timezone abbreviations', () => {
    // Parenthesized TZ is authoritative — unknown means "sender meant a
    // specific zone we don't model"; bail out rather than guess.
    const now = new Date('2026-04-17T12:00:00Z');
    expect(parseRateLimitResetTime(`${RL}Resets at 3pm (CEST).`, now)).toBeNull();
  });

  it('falls back to local time when a trailing word looks like a TZ but is not one', () => {
    // "3pm today" used to capture "TODAY" as an unknown TZ and suppress
    // the whole message. Now the parser ignores the bare token and treats
    // "3pm" as user-local. Assert a parse happens (non-null result) rather
    // than pinning the UTC value, since local time depends on the runner.
    const now = new Date('2026-04-17T06:00:00Z');
    const result = parseRateLimitResetTime(`${RL}Reset at 3pm today.`, now);
    expect(result).not.toBeNull();
  });

  it('returns null for invalid clock values', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(parseRateLimitResetTime(`${RL}Resets at 25:00 UTC.`, now)).toBeNull();
    expect(parseRateLimitResetTime(`${RL}Resets at 10:99 UTC.`, now)).toBeNull();
  });

  it('returns null for negative relative durations', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    // Regex requires \d+ so "-2" won't match; we'd get null anyway, but verify.
    expect(parseRateLimitResetTime(`${RL}Resets in -2 hours.`, now)).toBeNull();
  });
});
