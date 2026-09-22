/**
 * Shared classification of member runtime advisories and OpenCode session
 * refresh diagnostics.
 *
 * The member card and the HTTP member diagnostics route must agree on which
 * advisory text is a real member error: routine delivery-protocol bookkeeping
 * (`protocol_proof_missing`) and recoverable OpenCode session refreshes are
 * warnings, not failures, on both surfaces.
 */

import type { MemberRuntimeAdvisory } from '@shared/types';

const OPENCODE_SESSION_REFRESH_REASON_MARKERS = [
  'resolved_behavior_changed',
  'opencode_app_mcp_transport_changed',
] as const;
const OPENCODE_SESSION_REFRESH_REASON_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._~/=->';
const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;./()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;./(),-])/i;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

export function isRecoverableOpenCodeSessionRefreshText(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  const refreshText = stripOpenCodeGenericApiErrorPrefix(normalized);
  const refreshMarkerText = refreshText.replace(/[.:\s-]+$/, '');
  if (
    refreshMarkerText === 'session_stale' ||
    refreshMarkerText === 'opencode session refresh' ||
    refreshMarkerText === 'opencode session changed; refreshing the session before retry' ||
    refreshMarkerText === 'opencode session refresh scheduled after resolved behavior changed' ||
    refreshMarkerText === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    refreshMarkerText === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    refreshMarkerText === 'opencode_session_stale_observe_scheduled_after_accepted_prompt'
  ) {
    return true;
  }
  const reasonRanges = findOpenCodeSessionRefreshReasonRanges(refreshText);
  if (reasonRanges.length === 0) {
    return false;
  }
  const markerText = refreshText;
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = removeOpenCodeSessionRefreshReasonRanges(markerText, reasonRanges);
  const remainder = rawRemainder.replace(/[().,;:\s-]+/g, '');
  if (remainder.length === 0) {
    return true;
  }
  const staleLogProjectionContext =
    normalized.includes('session is stale') ||
    normalized.includes('stored session is stale') ||
    normalized.includes('session reconcile skipped');
  return staleLogProjectionContext && isBenignOpenCodeSessionRefreshRemainder(rawRemainder);
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function findOpenCodeSessionRefreshReasonRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const marker of OPENCODE_SESSION_REFRESH_REASON_MARKERS) {
    const prefix = `${marker}:`;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const markerStart = text.indexOf(prefix, searchFrom);
      if (markerStart < 0) {
        break;
      }
      const tokenStart = markerStart + prefix.length;
      const tokenEnd = findOpenCodeSessionRefreshReasonTokenEnd(text, tokenStart);
      if (tokenEnd !== null) {
        ranges.push([markerStart, tokenEnd]);
      }
      searchFrom = Math.max(tokenStart + 1, tokenEnd ?? tokenStart);
    }
  }
  return ranges.sort(([left], [right]) => left - right);
}

function findOpenCodeSessionRefreshReasonTokenEnd(text: string, start: number): number | null {
  let end = start;
  while (end < text.length && OPENCODE_SESSION_REFRESH_REASON_CHARS.includes(text[end] ?? '')) {
    end += 1;
  }

  const token = text.slice(start, end);
  const arrowIndex = token.indexOf('->');
  if (arrowIndex <= 0 || arrowIndex >= token.length - 2) {
    return null;
  }
  return end;
}

function removeOpenCodeSessionRefreshReasonRanges(
  text: string,
  ranges: readonly [number, number][]
): string {
  let result = text;
  for (const [start, end] of [...ranges].sort(([left], [right]) => right - left)) {
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return result;
}

function isBenignOpenCodeSessionRefreshRemainder(rawRemainder: string): boolean {
  if (OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(rawRemainder)) {
    return false;
  }
  const normalized = rawRemainder.replace(/[().,;:\s-]+/g, ' ').trim();
  return (
    normalized === 'opencode session is stale' ||
    normalized ===
      'opencode session is stale reading historical messages for log projection only' ||
    normalized === 'opencode session reconcile skipped because the stored session is stale' ||
    normalized === 'stored session is stale'
  );
}

function hasOpenCodeSessionRefreshFailureConflict(value: string): boolean {
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(
    value.replace(OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN, 'state')
  );
}

export function isGenericOpenCodeApiErrorText(value: string | undefined): boolean {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[.:\s-]+$/, '') ?? '';
  return normalized === 'opencode api error';
}

function isBenignOpenCodeRefreshContextText(value: string | undefined): boolean {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[.:\s-]+$/, '') ?? '';
  return (
    !normalized ||
    isRecoverableOpenCodeSessionRefreshText(normalized) ||
    isGenericOpenCodeApiErrorText(normalized) ||
    normalized === 'matched opencode runtime pid and process identity' ||
    normalized === 'bootstrap confirmed' ||
    normalized === 'opencode runtime process detected after bootstrap confirmation'
  );
}

export function hasCleanRecoverableOpenCodeRefreshContext(
  values: readonly (string | undefined)[]
): boolean {
  const normalizedValues = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return (
    normalizedValues.some(isRecoverableOpenCodeSessionRefreshText) &&
    normalizedValues.every(isBenignOpenCodeRefreshContextText)
  );
}

export function isRuntimeAdvisoryCardError(
  runtimeAdvisory: MemberRuntimeAdvisory | undefined,
  providerId: string | undefined
): boolean {
  if (providerId === 'opencode' && isRecoverableOpenCodeSessionRefreshAdvisory(runtimeAdvisory)) {
    return false;
  }
  return (
    runtimeAdvisory?.kind === 'api_error' && runtimeAdvisory.reasonCode !== 'protocol_proof_missing'
  );
}

function isRecoverableOpenCodeSessionRefreshAdvisory(
  runtimeAdvisory: MemberRuntimeAdvisory | undefined
): boolean {
  return (
    Boolean(runtimeAdvisory) &&
    (runtimeAdvisory?.reasonCode == null ||
      runtimeAdvisory.reasonCode === 'backend_error' ||
      runtimeAdvisory.reasonCode === 'unknown') &&
    isRecoverableOpenCodeSessionRefreshText(runtimeAdvisory?.message)
  );
}
