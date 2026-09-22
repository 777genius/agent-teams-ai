const DEFAULT_MIN_OLD_SPACE_MB = 2048;
const OLD_SPACE_FLAG = '--max-old-space-size';
const OLD_SPACE_FLAG_ALIAS = '--max_old_space_size';
const OLD_SPACE_FLAGS = new Set([OLD_SPACE_FLAG, OLD_SPACE_FLAG_ALIAS]);
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

function splitOldSpaceEquals(value: string): { flag: string; mb: number } | null {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }
  const flag = value.slice(0, separatorIndex);
  if (!OLD_SPACE_FLAGS.has(flag)) {
    return null;
  }
  const mb = parseOldSpaceMb(value.slice(separatorIndex + 1));
  return Number.isFinite(mb) ? { flag, mb } : null;
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

    const equalsMatch = splitOldSpaceEquals(current);
    if (equalsMatch) {
      if (equalsMatch.mb > 0 && equalsMatch.mb < minMb) {
        parts[index] = `${equalsMatch.flag}=${minMb}`;
        changed = true;
      }
      continue;
    }

    if (OLD_SPACE_FLAGS.has(current)) {
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
