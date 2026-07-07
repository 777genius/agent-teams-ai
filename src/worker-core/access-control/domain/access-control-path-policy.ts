import { isAbsolute, resolve, sep } from "node:path";

export type SensitiveAccessPathDecision<Reason> = {
  readonly reason: Reason;
  readonly evidence: readonly string[];
};

export function sensitiveAccessPathDecision<Reason>(input: {
  readonly path: string;
  readonly deniedRoots: readonly string[];
  readonly registryRoot?: string;
  readonly denyRegistryRawWrite: boolean;
  readonly reasons: {
    readonly authPathDenied: Reason;
    readonly dockerSocketDenied: Reason;
    readonly gitInternalPathDenied: Reason;
    readonly registryRawWriteDenied: Reason;
  };
}): SensitiveAccessPathDecision<Reason> | null {
  if (pathInsideAnyRoot(input.path, input.deniedRoots)) {
    return {
      reason: dockerSocketPath(input.path)
        ? input.reasons.dockerSocketDenied
        : input.reasons.authPathDenied,
      evidence: ["path is in a denied root"],
    };
  }
  if (hasPathSegment(input.path, ".git")) {
    return {
      reason: input.reasons.gitInternalPathDenied,
      evidence: ["direct .git internals access is not allowed"],
    };
  }
  if (
    input.denyRegistryRawWrite &&
    input.registryRoot &&
    pathInside(input.path, input.registryRoot)
  ) {
    return {
      reason: input.reasons.registryRawWriteDenied,
      evidence: ["registry writes must go through project control broker operations"],
    };
  }
  return null;
}

export function normalizePathOrNull(path: string): string | null {
  if (!path.trim() || !isAbsolute(path)) return null;
  return normalizePath(path);
}

export function normalizePath(path: string): string {
  return stripTrailingSeparator(resolve(path));
}

export function pathInsideAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathInside(path, root));
}

export function pathInside(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  );
}

export function matchesAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && prefixes.some((prefix) => value.startsWith(prefix));
}

export function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.length > 0 && patterns.some((pattern) => {
    if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
  });
}

export function parseRemoteTrackingBranch(
  value: string,
): { readonly remote: string; readonly branch: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    remote: value.slice(0, slash),
    branch: value.slice(slash + 1),
  };
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

function hasPathSegment(path: string, segment: string): boolean {
  return normalizePath(path).split(/[\\/]+/).includes(segment);
}

function dockerSocketPath(path: string): boolean {
  return normalizePath(path).endsWith(`${sep}docker.sock`);
}
