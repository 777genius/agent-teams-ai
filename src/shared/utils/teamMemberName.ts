export function parseNumericSuffixName(name: string): { base: string; suffix: number } | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const match = /^(.+)-(\d+)$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  const suffix = Number(match[2]);
  if (!Number.isFinite(suffix)) return null;
  return { base: match[1], suffix };
}

/**
 * Claude CLI auto-suffixes teammate names when a name already exists in config.json
 * (e.g. "alice" → "alice-2"). We treat "-2+" as an auto-suffix only when the base
 * name also exists among the current set of names.
 *
 * Important: do NOT treat "-1" as auto-suffix; it's commonly intentional ("dev-1").
 */
export function createCliAutoSuffixNameGuard(
  allNames: Iterable<string>
): (name: string) => boolean {
  const trimmed: string[] = [];
  const seen = new Set<string>();
  for (const n of allNames) {
    if (typeof n !== 'string') continue;
    const t = n.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    trimmed.push(t);
  }

  const allLower = new Set(trimmed.map((n) => n.toLowerCase()));

  return (name: string): boolean => {
    const info = parseNumericSuffixName(name);
    if (!info) return true;
    if (info.suffix < 2) return true;
    return !allLower.has(info.base.toLowerCase());
  };
}

const PROVISIONER_SUFFIX = '-provisioner';

/**
 * Claude CLI creates temporary "{name}-provisioner" agents during team provisioning
 * to spawn real teammates. These are always internal artifacts — never real teammates.
 *
 * Unlike numeric suffixes (alice-2) which can be intentional, "-provisioner" is a
 * hardcoded CLI pattern that should never be exposed to the user. We unconditionally
 * hide any name ending with "-provisioner" regardless of whether the base name exists.
 */
export function createCliProvisionerNameGuard(
  _allNames: Iterable<string>
): (name: string) => boolean {
  return (name: string): boolean => {
    const lower = name.trim().toLowerCase();
    if (!lower.endsWith(PROVISIONER_SUFFIX)) return true;
    const base = lower.slice(0, -PROVISIONER_SUFFIX.length);
    // Keep bare "-provisioner" (no base) — that's not a CLI artifact pattern
    return !base;
  };
}
