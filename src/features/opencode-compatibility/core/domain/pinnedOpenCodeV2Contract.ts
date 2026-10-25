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

/** Fail closed: without a valid pinned contract no V2 version is recognized. */
export function isOpenCodeV2RangeVersion(version: string): boolean {
  return (
    pinnedOpenCodeV2Contract !== null && openCodeV2ContractCovers(pinnedOpenCodeV2Contract, version)
  );
}

/** Exact engine qualification; retained for qualification harness callers. */
export function isOpenCodeV2QualifiedVersion(version: string): boolean {
  return (
    pinnedOpenCodeV2Contract !== null &&
    openCodeV2ContractQualifies(
      pinnedOpenCodeV2Contract,
      openCodeV2PlatformKeys(globalThis as Parameters<typeof openCodeV2PlatformKeys>[0]),
      version
    )
  );
}

/** Qualified engine for this native identity; old contracts remain exact-version strict. */
export function getOpenCodeV2EngineVersion(version: string): string | null {
  return pinnedOpenCodeV2Contract === null
    ? null
    : engineForNativeVersion(
        pinnedOpenCodeV2Contract,
        openCodeV2PlatformKeys(globalThis as Parameters<typeof openCodeV2PlatformKeys>[0]),
        version
      );
}

/** Highest exact release qualified for this concrete native platform. */
export function getLatestQualifiedOpenCodeV2Version(platform: string, arch: string): string | null {
  return pinnedOpenCodeV2Contract?.qualified[`${platform}-${arch}`]?.at(-1) ?? null;
}
