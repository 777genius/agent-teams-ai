/**
 * OpenCode V2 version contract of the pinned runtime. The runtime registry owns
 * the supported range and the qualified versions; its release manifest publishes
 * them and `runtime.lock.json` pins that exact contract (`opencodeV2`). This app
 * never lists V2 versions itself.
 *
 * This module is the only policy over that contract. It has no imports so that
 * Node-run proof and CI scripts can load it directly; `pinnedOpenCodeV2Contract.ts`
 * binds it to the lock file and the current platform.
 */
export interface OpenCodeV2Contract {
  /** New runtimes may serve stable native V2 through a separately qualified engine. */
  cliVersionPolicy?: 'stable-v2-qualified-engine';
  range: Readonly<{ minimum: string; below: string }>;
  /** Versions qualified for team launch, per `<platform>-<arch>` key of the release assets. */
  qualified: Readonly<Record<string, readonly string[]>>;
}

type Release = readonly [number, number, number];
const PLATFORM = /^(darwin|linux|win32)-(arm64|x64)$/;
const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** The contract describes the V2 generation only: its range stays within 2.x. */
const V2_FLOOR: Release = [2, 0, 0];
const V3_FLOOR: Release = [3, 0, 0];

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
  const { range, qualified, cliVersionPolicy } = value as {
    range?: unknown;
    qualified?: unknown;
    cliVersionPolicy?: unknown;
  };
  if (cliVersionPolicy !== undefined && cliVersionPolicy !== 'stable-v2-qualified-engine')
    return null;
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
  if (
    !low ||
    !high ||
    compareOpenCodeV2Release(low, V2_FLOOR) < 0 ||
    compareOpenCodeV2Release(high, V3_FLOOR) > 0 ||
    compareOpenCodeV2Release(low, high) >= 0
  )
    return null;
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
    ...(cliVersionPolicy ? { cliVersionPolicy } : {}),
    range: Object.freeze({ minimum: minimum as string, below: below as string }),
    qualified: Object.freeze(byPlatform),
  });
}

/** An exact stable release inside the contract's range. */
export function openCodeV2ContractCovers(contract: OpenCodeV2Contract, version: string): boolean {
  const release = parseOpenCodeV2Release(version);
  return (
    release !== null &&
    compareOpenCodeV2Release(release, parseOpenCodeV2Release(contract.range.minimum)!) >= 0 &&
    compareOpenCodeV2Release(release, parseOpenCodeV2Release(contract.range.below)!) < 0
  );
}

/** A runtime released without OpenCode V2 qualifies no version on any platform. */
export function openCodeV2ContractShipsV2(contract: OpenCodeV2Contract): boolean {
  return Object.values(contract.qualified).some((versions) => versions.length > 0);
}

/** Qualified for team launch on any of the given `<platform>-<arch>` keys. */
export function openCodeV2ContractQualifies(
  contract: OpenCodeV2Contract,
  platformKeys: readonly string[],
  version: string
): boolean {
  return platformKeys.some((key) => contract.qualified[key]?.includes(version) === true);
}

/** Native version is identity; only recorded engine versions authorize execution. */
export function engineForNativeVersion(
  contract: OpenCodeV2Contract,
  platformKeys: readonly string[],
  version: string
): string | null {
  if (!openCodeV2ContractCovers(contract, version)) return null;
  if (contract.cliVersionPolicy === 'stable-v2-qualified-engine' && platformKeys.length !== 1)
    return null;
  if (openCodeV2ContractQualifies(contract, platformKeys, version)) return version;
  if (contract.cliVersionPolicy !== 'stable-v2-qualified-engine') return null;
  const engines = platformKeys.flatMap((key) => contract.qualified[key] ?? []);
  return (
    engines
      .toSorted((left, right) =>
        compareOpenCodeV2Release(parseOpenCodeV2Release(left)!, parseOpenCodeV2Release(right)!)
      )
      .at(-1) ?? null
  );
}

/**
 * Platform keys of a JavaScript environment. A Node process knows its exact
 * platform; preload gives sandboxed renderers that same native target. UA-only
 * callers retain legacy OS-family hints, which never select a flexible engine.
 */
export function openCodeV2PlatformKeys(environment: {
  process?: { platform?: unknown; arch?: unknown };
  electronAPI?: { openCodeRuntime?: { readonly platform?: unknown; readonly arch?: unknown } };
  navigator?: { userAgent?: unknown };
}): readonly string[] {
  const { process: runtime, navigator: browser } = environment;
  const target = environment.electronAPI?.openCodeRuntime;
  if (typeof target?.platform === 'string' && typeof target.arch === 'string')
    return [`${target.platform}-${target.arch}`];
  if (typeof runtime?.platform === 'string' && typeof runtime.arch === 'string')
    return [`${runtime.platform}-${runtime.arch}`];
  const agent = typeof browser?.userAgent === 'string' ? browser.userAgent : '';
  const family = agent.includes('Mac')
    ? 'darwin'
    : agent.includes('Windows')
      ? 'win32'
      : agent.includes('Linux')
        ? 'linux'
        : null;
  return family ? [`${family}-arm64`, `${family}-x64`] : [];
}
