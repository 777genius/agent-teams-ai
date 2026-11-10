/**
 * Detects rate limit messages from Claude and parses reset time from them.
 */

const RATE_LIMIT_SUBSTRING = "You've hit your limit";
const MODEL_COOLDOWN_CODE = 'model_cooldown';

interface StructuredRateLimitPayload {
  code: string | null;
  message: string | null;
  resetSeconds: number | null;
  resetTime: string | null;
}

/**
 * Returns true if the message text contains the rate limit indicator.
 */
export function isRateLimitMessage(text: string): boolean {
  if (!text) return false;
  if (text.includes(RATE_LIMIT_SUBSTRING)) return true;

  const structured = extractStructuredRateLimitPayload(text);
  return structured ? isStructuredRateLimitPayload(structured) : false;
}

// ---------------------------------------------------------------------------
// Reset-time parsing
// ---------------------------------------------------------------------------

/**
 * Maps known Claude timezone abbreviations to fixed UTC offsets in minutes.
 * We only include zones Claude's API has been observed to emit. When the
 * message contains an explicit parenthesized timezone that is NOT in this
 * map, the parser returns `null` rather than guessing. When no timezone is
 * present at all, the hour:minute is treated as user-local time.
 */
const TIMEZONE_OFFSETS_MIN: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  // North America — standard times
  EST: -5 * 60,
  CST: -6 * 60,
  MST: -7 * 60,
  PST: -8 * 60,
  // North America — daylight times
  EDT: -4 * 60,
  CDT: -5 * 60,
  MDT: -6 * 60,
  PDT: -7 * 60,
};

/**
 * Attempts to parse the reset time from a Claude rate-limit message.
 *
 * Supported formats (case-insensitive):
 *   - "limit will reset at 3pm (PST)"
 *   - "limit will reset at 3:30 pm (PST)"
 *   - "limit will reset at 15:30 UTC"
 *   - "resets at 3pm"                   (local time assumed)
 *   - "resets in 2 hours"
 *   - "resets in 45 minutes"
 *
 * Returns `null` when the reset time cannot be extracted reliably. Also returns
 * null for text that does not look like a rate-limit message, so the parser is
 * safe to call on arbitrary strings.
 *
 * @param text  the full rate-limit message text
 * @param now   reference "now" used to resolve wall-clock times and relative
 *              offsets (exposed for testability; defaults to `new Date()`)
 */
export function parseRateLimitResetTime(text: string, now: Date = new Date()): Date | null {
  if (!text) return null;
  // Defensive gate: only parse text that actually looks like a rate-limit
  // message. Prevents false positives from unrelated prose containing
  // words like "reset" (e.g. "reset the 5pm meeting").
  if (!isRateLimitMessage(text)) return null;

  const structured = extractStructuredRateLimitPayload(text);
  if (structured && isStructuredRateLimitPayload(structured)) {
    const structuredReset = parseStructuredResetTime(structured, now);
    if (structuredReset) {
      return structuredReset;
    }
  }

  const relative = parseRelativeResetDuration(text);
  if (relative !== null) {
    return new Date(now.getTime() + relative);
  }

  return parseAbsoluteResetClockTime(text, now);
}

/**
 * Matches trailing qualifiers that shift the reset to a different day.
 * When present, we can't reliably resolve the date without more context, so
 * the parser bails out. Example: "reset at 3pm (PST) next week" — the naive
 * "today or tomorrow" rollover would fire in hours instead of a week.
 */
const DAY_SHIFT_QUALIFIER_RE =
  /\b(?:next\s+week|next\s+month|tomorrow|yesterday|on\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/i;

// ---------------------------------------------------------------------------
// Relative durations: "resets in 2 hours", "resets in 45 minutes"
// ---------------------------------------------------------------------------

const RESET_VERB_RE = /\breset(?:s|ting)?\b/i;
const LEADING_FILLER_RE = /^(?:about|around)\s+/i;
const LEADING_TIME_VALUE_RE = /^(\d+(?:\.\d+)?)\s*([a-z]+)\b/i;

function parseRelativeResetDuration(text: string): number | null {
  const resetVerbMatch = RESET_VERB_RE.exec(text);
  if (!resetVerbMatch) return null;

  const afterVerb = text.slice(resetVerbMatch.index + resetVerbMatch[0].length).trimStart();
  if (!afterVerb.toLowerCase().startsWith('in')) return null;

  let tail = afterVerb.slice(2).trimStart();
  if (tail.startsWith('~')) {
    tail = tail.slice(1).trimStart();
  }
  tail = tail.replace(LEADING_FILLER_RE, '');

  const match = LEADING_TIME_VALUE_RE.exec(tail);
  if (!match) return null;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = match[2].toLowerCase();
  if (['second', 'seconds', 'sec', 'secs', 's'].includes(unit)) {
    return Math.round(amount * 1000);
  }
  if (['minute', 'minutes', 'min', 'mins', 'm'].includes(unit)) {
    return Math.round(amount * 60 * 1000);
  }
  if (['hour', 'hours', 'hr', 'hrs', 'h'].includes(unit)) {
    return Math.round(amount * 60 * 60 * 1000);
  }
  return null;
}

function extractStructuredRateLimitPayload(text: string): StructuredRateLimitPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const prefixedMatch = /^(?:API Error:\s*\d+\s+|\d+\s+)?(\{[\s\S]*\})$/i.exec(trimmed);
  const jsonCandidate = prefixedMatch?.[1] ?? (trimmed.startsWith('{') ? trimmed : null);
  if (!jsonCandidate) return null;

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      error?: {
        code?: unknown;
        message?: unknown;
        reset_seconds?: unknown;
        reset_time?: unknown;
      };
      code?: unknown;
      message?: unknown;
      reset_seconds?: unknown;
      reset_time?: unknown;
    };
    const errorPayload = parsed.error;

    return {
      code: readStringField(errorPayload?.code) ?? readStringField(parsed.code),
      message: readStringField(errorPayload?.message) ?? readStringField(parsed.message),
      resetSeconds:
        readNumberField(errorPayload?.reset_seconds) ?? readNumberField(parsed.reset_seconds),
      resetTime: readStringField(errorPayload?.reset_time) ?? readStringField(parsed.reset_time),
    };
  } catch {
    return null;
  }
}

function isStructuredRateLimitPayload(payload: StructuredRateLimitPayload): boolean {
  const code = payload.code?.trim().toLowerCase();
  if (code === MODEL_COOLDOWN_CODE) {
    return true;
  }

  const message = payload.message?.trim().toLowerCase() ?? '';
  return (
    (message.includes('cooling down') || message.includes('model cooldown')) &&
    (payload.resetSeconds !== null || payload.resetTime !== null)
  );
}

function parseStructuredResetTime(payload: StructuredRateLimitPayload, now: Date): Date | null {
  if (payload.resetSeconds !== null) {
    return new Date(now.getTime() + Math.max(0, payload.resetSeconds) * 1000);
  }

  const resetTime = payload.resetTime?.trim();
  if (!resetTime) return null;

  const relative = parseRelativeResetDuration(`Resets in ${resetTime}`);
  if (relative !== null) {
    return new Date(now.getTime() + relative);
  }

  const absolute = Date.parse(resetTime);
  return Number.isFinite(absolute) ? new Date(absolute) : null;
}

function readStringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Absolute clock times: "resets at 3pm (PST)", "resets at 15:30 UTC"
// ---------------------------------------------------------------------------

/**
 * Captures the clock time + optional timezone abbreviation from phrases like
 * "reset at 3pm (PST)" or "resets at 15:30 UTC".
 */
const LEADING_CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const PAREN_TZ_RE = /^\(([A-Za-z]{2,5})\)/;
const TRAILING_TZ_RE = /^([A-Za-z]{2,5})\b/;

function parseAbsoluteResetClockTime(text: string, now: Date): Date | null {
  const resetVerbMatch = RESET_VERB_RE.exec(text);
  if (!resetVerbMatch) return null;

  let tail = text.slice(resetVerbMatch.index + resetVerbMatch[0].length).trimStart();
  if (tail.toLowerCase().startsWith('at ')) {
    tail = tail.slice(3).trimStart();
  }

  const match = LEADING_CLOCK_RE.exec(tail);
  if (!match) return null;

  tail = tail.slice(match[0].length).trimStart();
  const parenthesizedTzMatch = PAREN_TZ_RE.exec(tail);
  const bareWordMatch = parenthesizedTzMatch ? null : TRAILING_TZ_RE.exec(tail);
  const bareTzMatch =
    bareWordMatch && bareWordMatch[1].toUpperCase() in TIMEZONE_OFFSETS_MIN ? bareWordMatch : null;
  const tzTokenLength = parenthesizedTzMatch?.[0].length ?? bareTzMatch?.[0].length ?? 0;

  // If the text contains a day-shift qualifier ("next week", "on Tuesday",
  // etc.), the "today or tomorrow" rollover below would produce a materially
  // wrong time. Bail out and let the caller fall back to no auto-resume.
  const afterMatch = tail.slice(tzTokenLength);
  if (DAY_SHIFT_QUALIFIER_RE.test(afterMatch)) return null;

  const hourRaw = Number.parseInt(match[1], 10);
  const minuteRaw = match[2] ? Number.parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase() ?? null;
  const parenthesizedTz = parenthesizedTzMatch?.[1]?.toUpperCase() ?? '';
  const trailingTz = bareTzMatch?.[1]?.toUpperCase() ?? '';

  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
  if (minuteRaw < 0 || minuteRaw > 59) return null;

  let hour = hourRaw;
  if (ampm === 'pm' && hour < 12) hour += 12;
  else if (ampm === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return null;

  // Timezone resolution treats parenthesized vs bare tokens differently.
  //
  //   "reset at 3pm (PST)"    — parenthesized, authoritative. Unknown zone
  //                             here means the sender meant a specific zone
  //                             we don't model; bail out rather than guess.
  //   "reset at 3pm PST"      — bare known abbreviation, same effect.
  //   "reset at 3pm today"    — bare unknown word ("TODAY"). This is just a
  //                             trailing word, not a real TZ claim; fall
  //                             back to local time instead of suppressing.
  //   "reset at 3pm"          — no token. Treat as user-local.
  let tzOffset: number | null;
  if (parenthesizedTz) {
    if (!(parenthesizedTz in TIMEZONE_OFFSETS_MIN)) return null;
    tzOffset = TIMEZONE_OFFSETS_MIN[parenthesizedTz]!;
  } else if (trailingTz && trailingTz in TIMEZONE_OFFSETS_MIN) {
    tzOffset = TIMEZONE_OFFSETS_MIN[trailingTz]!;
  } else {
    tzOffset = null;
  }

  const candidateSeed =
    tzOffset === null
      ? buildLocalToday(now, hour, minuteRaw)
      : buildUtcTodayWithOffset(now, hour, minuteRaw, tzOffset);
  let candidate: Date = candidateSeed;

  // If the computed time is materially in the past (e.g. "3pm" parsed while
  // it's already 4pm), roll forward by one day. A small tolerance prevents
  // near-present timestamps — stale messages, clock skew, sub-second drift —
  // from being bumped 24 h forward, which would then trip the scheduler's
  // 12 h ceiling and silently drop auto-resume altogether. Timestamps within
  // `ROLLOVER_TOLERANCE_MS` of now fire immediately after the scheduler's
  // own 30 s buffer and `Math.max(0, rawDelayMs)` clamp.
  if (candidate.getTime() <= now.getTime() - ROLLOVER_TOLERANCE_MS) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

const ROLLOVER_TOLERANCE_MS = 60 * 1000;

function buildLocalToday(now: Date, hour: number, minute: number): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function buildUtcTodayWithOffset(
  now: Date,
  hour: number,
  minute: number,
  offsetMinutes: number
): Date {
  // The caller's "hour:minute" is expressed in the target zone. Anchor the
  // calendar date in that zone too — not in UTC — otherwise we get a 24h
  // error when the zone-local day differs from UTC's day (e.g. 01:00 UTC is
  // still "yesterday" for any negative-offset zone like PST).
  const zoned = new Date(now.getTime() + offsetMinutes * 60 * 1000);
  const offsetMs = offsetMinutes * 60 * 1000;
  return new Date(
    Date.UTC(zoned.getUTCFullYear(), zoned.getUTCMonth(), zoned.getUTCDate(), hour, minute, 0, 0) -
      offsetMs
  );
}
