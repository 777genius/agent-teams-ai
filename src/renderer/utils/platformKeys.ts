/**
 * Cross-platform keyboard shortcut display helpers.
 *
 * Mac shows symbols (cmd, shift, option, ctrl), Windows/Linux shows words (Ctrl+, Shift+, Alt+).
 */

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Prefer userAgentData (modern API) over deprecated navigator.platform
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.userAgent;
  return /mac/i.test(platform);
}

export const IS_MAC = detectMac();

/** Return platform-appropriate modifier prefix: "cmd" on Mac, "Ctrl+" on others */
export const MOD = IS_MAC ? '\u2318' : 'Ctrl+';

/** Return platform-appropriate shortcut string */
export function shortcutLabel(mac: string, other: string): string {
  return IS_MAC ? mac : other;
}
