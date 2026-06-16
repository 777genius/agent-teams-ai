const DEFAULT_MIN_OLD_SPACE_MB = 2048;
const OLD_SPACE_EQUALS_RE = /^--max-old-space-size=(\d+)$/;
const OLD_SPACE_FLAG = '--max-old-space-size';
const OLD_SPACE_VALUE_RE = /^\d+$/;

function splitNodeOptions(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function joinNodeOptions(parts: readonly string[]): string | undefined {
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function parseOldSpaceMb(value: string | undefined): number {
  if (!value || !OLD_SPACE_VALUE_RE.test(value)) {
    return NaN;
  }
  return Number.parseInt(value, 10);
}

export function ensureMinimumNodeOldSpaceOptions(
  value: string | undefined,
  minMb = DEFAULT_MIN_OLD_SPACE_MB
): string | undefined {
  if (!value?.trim()) {
    return value;
  }

  const parts = splitNodeOptions(value);
  const consumedIndexes = new Set<number>();
  let changed = false;
  for (const [index, current] of parts.entries()) {
    if (consumedIndexes.has(index)) {
      continue;
    }

    const equalsMatch = OLD_SPACE_EQUALS_RE.exec(current);
    if (equalsMatch) {
      const mb = parseOldSpaceMb(equalsMatch[1]);
      if (Number.isFinite(mb) && mb > 0 && mb < minMb) {
        parts[index] = `${OLD_SPACE_FLAG}=${minMb}`;
        changed = true;
      }
      continue;
    }

    if (current === OLD_SPACE_FLAG) {
      const next = parts[index + 1];
      const mb = parseOldSpaceMb(next);
      if (Number.isFinite(mb) && mb > 0 && mb < minMb) {
        parts[index + 1] = String(minMb);
        changed = true;
      }
      if (Number.isFinite(mb) && mb > 0) {
        consumedIndexes.add(index + 1);
      }
    }
  }

  return changed ? joinNodeOptions(parts) : value;
}

export function ensureMinimumNodeOldSpaceEnv(
  env: NodeJS.ProcessEnv,
  minMb = DEFAULT_MIN_OLD_SPACE_MB
): void {
  const normalized = ensureMinimumNodeOldSpaceOptions(env.NODE_OPTIONS, minMb);
  if (normalized === undefined) {
    delete env.NODE_OPTIONS;
    return;
  }
  env.NODE_OPTIONS = normalized;
}
