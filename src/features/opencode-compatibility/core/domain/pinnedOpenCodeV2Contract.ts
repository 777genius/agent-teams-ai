import runtimeLock from '../../../../../runtime.lock.json';

import {
  engineForNativeVersion,
  openCodeV2ContractCovers,
  openCodeV2ContractQualifies,
  openCodeV2PlatformKeys,
  readOpenCodeV2Contract,
} from './openCodeV2Contract';

/** The contract pinned by `runtime.lock.json`; null when it is malformed. */
export const pinnedOpenCodeV2Contract = readOpenCodeV2Contract(
  (runtimeLock as { opencodeV2?: unknown }).opencodeV2
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** New split releases need both published records; the installer validates their contents. */
function shipsPlatform(platformKey: string): boolean {
  if (!Object.hasOwn(runtimeLock, 'opencodeV2Delivery')) return true;
  const lock = runtimeLock as { assets?: unknown; opencodeV2Delivery?: unknown };
  return (
    isRecord(lock.assets) &&
    Object.hasOwn(lock.assets, platformKey) &&
    isRecord(lock.assets[platformKey]) &&
    isRecord(lock.opencodeV2Delivery) &&
    Object.hasOwn(lock.opencodeV2Delivery, platformKey) &&
    isRecord(lock.opencodeV2Delivery[platformKey])
  );
}

function availableNativePlatformKeys(): readonly string[] {
  const keys = openCodeV2PlatformKeys(globalThis as Parameters<typeof openCodeV2PlatformKeys>[0]);
  // Never turn an ambiguous OS-family hint into one flexible engine by removing an unavailable target.
  return keys.every(shipsPlatform) ? keys : [];
}

/** Fail closed: without a valid pinned contract no V2 version is recognized. */
export function isOpenCodeV2RangeVersion(version: string): boolean {
  return (
    pinnedOpenCodeV2Contract !== null && openCodeV2ContractCovers(pinnedOpenCodeV2Contract, version)
  );
}

/** False for a pinned runtime released without OpenCode V2 (or a malformed contract). */
export function pinnedRuntimeShipsOpenCodeV2(): boolean {
  return (
    pinnedOpenCodeV2Contract !== null &&
    Object.entries(pinnedOpenCodeV2Contract.qualified).some(
      ([platformKey, versions]) => versions.length > 0 && shipsPlatform(platformKey)
    )
  );
}

/** Exact engine qualification; retained for qualification harness callers. */
export function isOpenCodeV2QualifiedVersion(version: string): boolean {
  return (
    pinnedOpenCodeV2Contract !== null &&
    openCodeV2ContractQualifies(pinnedOpenCodeV2Contract, availableNativePlatformKeys(), version)
  );
}

/** Qualified engine for this native identity; old contracts remain exact-version strict. */
export function getOpenCodeV2EngineVersion(version: string): string | null {
  return pinnedOpenCodeV2Contract === null
    ? null
    : engineForNativeVersion(pinnedOpenCodeV2Contract, availableNativePlatformKeys(), version);
}

/** Highest qualified engine offered for this app-shipped native platform. */
export function getLatestQualifiedOpenCodeV2Version(platform: string, arch: string): string | null {
  const platformKey = `${platform}-${arch}`;
  return shipsPlatform(platformKey)
    ? (pinnedOpenCodeV2Contract?.qualified[platformKey]?.at(-1) ?? null)
    : null;
}
