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
