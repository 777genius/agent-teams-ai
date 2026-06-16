const DEFAULT_MIN_OLD_SPACE_MB = 2048;
const OLD_SPACE_EQUALS_RE = /^--max-old-space-size=(\d+)$/;
const OLD_SPACE_FLAG = '--max-old-space-size';

function splitNodeOptions(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function joinNodeOptions(parts: readonly string[]): string | undefined {
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function ensureMinimumNodeOldSpaceOptions(
  value: string | undefined,
  minMb = DEFAULT_MIN_OLD_SPACE_MB
): string | undefined {
  if (!value?.trim()) {
    return value;
  }

  const parts = splitNodeOptions(value);
  let changed = false;
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    const equalsMatch = OLD_SPACE_EQUALS_RE.exec(current);
    if (equalsMatch) {
      const mb = Number.parseInt(equalsMatch[1], 10);
      if (Number.isFinite(mb) && mb > 0 && mb < minMb) {
        parts[index] = `${OLD_SPACE_FLAG}=${minMb}`;
        changed = true;
      }
      continue;
    }

    if (current === OLD_SPACE_FLAG) {
      const next = parts[index + 1];
      const mb = next ? Number.parseInt(next, 10) : NaN;
      if (Number.isFinite(mb) && mb > 0 && mb < minMb) {
        parts[index + 1] = String(minMb);
        changed = true;
      }
      index += 1;
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
