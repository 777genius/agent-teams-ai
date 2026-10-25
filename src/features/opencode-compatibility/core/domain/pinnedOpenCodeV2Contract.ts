import runtimeLock from '../../../../../runtime.lock.json';

import {
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

/** Qualified for team launch on this platform by the pinned runtime's records. */
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
