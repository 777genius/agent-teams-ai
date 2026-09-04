import { MEMBER_LAUNCH_GRACE_TIMEOUT_REASON } from '@shared/utils/teamLaunchFailureReason';

interface LaunchFailureReasonDisplayText {
  readonly key: string;
  readonly fallback: string;
}

/**
 * Launch failure reasons the main process writes as stable identifiers rather
 * than prose. The identifier is what every main-process reader compares, so it
 * has to survive untouched all the way to the renderer - and be turned into a
 * sentence here, at the last moment before a person reads it.
 */
const DISPLAY_TEXT_BY_REASON_IDENTIFIER: ReadonlyMap<string, LaunchFailureReasonDisplayText> =
  new Map([
    [
      MEMBER_LAUNCH_GRACE_TIMEOUT_REASON,
      {
        key: 'members.launchFailure.graceTimeout',
        fallback: 'Teammate did not join within the launch grace window.',
      },
    ],
  ]);

/**
 * Replace a known reason identifier with the text a person should read, and
 * leave every other reason exactly as it arrived - most failure reasons are
 * already prose written for the user, and rewriting them would lose detail.
 *
 * `t` is optional and untyped for the same reason `teamProvisioningPresentation`
 * takes it that way: callers outside a component tree have no translator, and
 * they still must not print the identifier.
 */
export function describeMemberLaunchFailureReason(
  reason: string | undefined,
  t?: unknown
): string | undefined {
  const identifier = reason?.trim();
  if (!identifier) {
    return reason;
  }
  const displayText = DISPLAY_TEXT_BY_REASON_IDENTIFIER.get(identifier);
  if (!displayText) {
    return reason;
  }
  if (!t) {
    return displayText.fallback;
  }
  return (t as (translationKey: string, options?: Record<string, unknown>) => string)(
    displayText.key,
    { defaultValue: displayText.fallback }
  );
}
