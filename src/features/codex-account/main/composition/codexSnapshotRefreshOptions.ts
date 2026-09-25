// Pure refresh-option policy for the codex account snapshot pipeline: normalization, batch
// merging, and the forced token refresh reuse window. Kept free of runtime dependencies.

export interface CodexSnapshotRefreshOptions {
  includeRateLimits: boolean;
  forceRefreshToken: boolean;
  bypassCache: boolean;
  // Verified via CodexBinaryResolver.verifyCandidate before the snapshot resolves its
  // binary, so a specific per-call CLI selection can win over the cached/ambient one.
  binaryPathOverride?: string;
}

export interface CodexSnapshotRefreshRequest {
  includeRateLimits?: boolean;
  forceRefreshToken?: boolean;
  bypassCache?: boolean;
  binaryPathOverride?: string;
}

// Every forceRefreshToken read rotates the ChatGPT refresh token inside its own
// `codex app-server` process, and one launch preparation issues several such reads
// sequentially. Rotating the token multiple times within seconds risks OpenAI's
// refresh_token_reused revocation, so a forced call inside this window of the last completed
// forced rotation is downgraded to a regular read that reuses that rotation's result. A forced
// call after the window rotates again; explicit login/logout resets the window.
const FORCED_TOKEN_REFRESH_REUSE_WINDOW_MS = 30_000;

export function normalizeRefreshOptions(
  options?: CodexSnapshotRefreshRequest
): CodexSnapshotRefreshOptions {
  return {
    includeRateLimits: options?.includeRateLimits === true,
    forceRefreshToken: options?.forceRefreshToken === true,
    bypassCache: options?.bypassCache === true,
    binaryPathOverride: options?.binaryPathOverride?.trim() || undefined,
  };
}

export function mergeRefreshOptions(
  current: CodexSnapshotRefreshOptions | null,
  next: CodexSnapshotRefreshOptions
): CodexSnapshotRefreshOptions {
  if (!current) {
    return next;
  }

  return {
    includeRateLimits: current.includeRateLimits || next.includeRateLimits,
    forceRefreshToken: current.forceRefreshToken || next.forceRefreshToken,
    bypassCache: current.bypassCache || next.bypassCache,
    binaryPathOverride: next.binaryPathOverride ?? current.binaryPathOverride,
  };
}

export function doRefreshOptionsCover(
  current: CodexSnapshotRefreshOptions | null,
  requested: CodexSnapshotRefreshOptions
): boolean {
  return Boolean(
    current &&
    (!requested.includeRateLimits || current.includeRateLimits) &&
    (!requested.forceRefreshToken || current.forceRefreshToken) &&
    (!requested.bypassCache || current.bypassCache) &&
    (!requested.binaryPathOverride || requested.binaryPathOverride === current.binaryPathOverride)
  );
}

function isInsideForcedTokenRefreshReuseWindow(
  lastForcedTokenRefreshAtMs: number,
  now: number
): boolean {
  return (
    lastForcedTokenRefreshAtMs > 0 &&
    now - lastForcedTokenRefreshAtMs <= FORCED_TOKEN_REFRESH_REUSE_WINDOW_MS
  );
}

export function applyForcedTokenRefreshReuseWindow(
  options: CodexSnapshotRefreshOptions,
  lastForcedTokenRefreshAtMs: number,
  now: number
): CodexSnapshotRefreshOptions {
  if (
    !options.forceRefreshToken ||
    !isInsideForcedTokenRefreshReuseWindow(lastForcedTokenRefreshAtMs, now)
  ) {
    return options;
  }

  return { ...options, forceRefreshToken: false };
}
