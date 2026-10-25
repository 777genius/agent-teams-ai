import runtimeLock from '../../../../../runtime.lock.json';

/**
 * OpenCode V2 version contract of the pinned runtime. The runtime registry owns
 * the supported range and the qualified versions; its release manifest publishes
 * them and `runtime.lock.json` pins that exact contract (`opencodeV2`). This app
 * never lists V2 versions itself.
 */
export interface OpenCodeV2Contract {
  range: Readonly<{ minimum: string; below: string }>;
  /** Versions qualified for team launch, per `<platform>-<arch>` key of the release assets. */
  qualified: Readonly<Record<string, readonly string[]>>;
}

type Release = readonly [number, number, number];
const PLATFORM = /^(darwin|linux|win32)-(arm64|x64)$/;
const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function parseOpenCodeV2Release(value: unknown): Release | null {
  const match = typeof value === 'string' ? RELEASE.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareOpenCodeV2Release(left: Release, right: Release): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Exact validation; a malformed contract is refused rather than partially trusted. */
export function readOpenCodeV2Contract(value: unknown): OpenCodeV2Contract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { range, qualified } = value as { range?: unknown; qualified?: unknown };
  if (
    !range ||
    typeof range !== 'object' ||
    Array.isArray(range) ||
    !qualified ||
    typeof qualified !== 'object' ||
    Array.isArray(qualified)
  )
    return null;
  const { minimum, below } = range as { minimum?: unknown; below?: unknown };
  const low = parseOpenCodeV2Release(minimum);
  const high = parseOpenCodeV2Release(below);
  if (!low || !high || compareOpenCodeV2Release(low, high) >= 0) return null;
  const byPlatform: Record<string, readonly string[]> = {};
  for (const [platform, versions] of Object.entries(qualified as Record<string, unknown>)) {
    if (!PLATFORM.test(platform) || !Array.isArray(versions)) return null;
    const releases = versions.map(parseOpenCodeV2Release);
    if (
      releases.some(
        (release, index) =>
          !release ||
          compareOpenCodeV2Release(release, low) < 0 ||
          compareOpenCodeV2Release(release, high) >= 0 ||
          (index > 0 && compareOpenCodeV2Release(releases[index - 1]!, release) >= 0)
      )
    )
      return null;
    byPlatform[platform] = Object.freeze([...(versions as string[])]);
  }
  return Object.freeze({
    range: Object.freeze({ minimum: minimum as string, below: below as string }),
    qualified: Object.freeze(byPlatform),
  });
}

const pinned = readOpenCodeV2Contract((runtimeLock as { opencodeV2?: unknown }).opencodeV2);

/** Fail closed: without a valid pinned contract no V2 version is recognized. */
export function isOpenCodeV2RangeVersion(version: string): boolean {
  const release = parseOpenCodeV2Release(version);
  if (!pinned || !release) return false;
  return (
    compareOpenCodeV2Release(release, parseOpenCodeV2Release(pinned.range.minimum)!) >= 0 &&
    compareOpenCodeV2Release(release, parseOpenCodeV2Release(pinned.range.below)!) < 0
  );
}

/**
 * Platform keys of this app. The main process knows its exact platform; a
 * sandboxed renderer only knows the OS family and accepts any of its arches.
 */
function currentPlatformKeys(): readonly string[] {
  const runtime = (globalThis as { process?: { platform?: unknown; arch?: unknown } }).process;
  if (typeof runtime?.platform === 'string' && typeof runtime.arch === 'string')
    return [`${runtime.platform}-${runtime.arch}`];
  const agent = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent;
  const text = typeof agent === 'string' ? agent : '';
  const family = /Mac/.test(text)
    ? 'darwin'
    : /Windows/.test(text)
      ? 'win32'
      : /Linux/.test(text)
        ? 'linux'
        : null;
  return family ? [`${family}-arm64`, `${family}-x64`] : [];
}

/** Qualified for team launch on this platform by the pinned runtime's records. */
export function isOpenCodeV2QualifiedVersion(version: string): boolean {
  const qualified = pinned?.qualified;
  return Boolean(
    qualified && currentPlatformKeys().some((key) => qualified[key]?.includes(version))
  );
}
