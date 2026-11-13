import { CapturedProcess } from './CapturedProcess.js';

import type { CapturedProcessPort, CapturedProcessProfile } from './CapturedProcess.js';
import type { HostWindowsLaunch } from '../../owned-process/HostWindowsLaunch.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';

export type CapturedNativeProcessFactory = (
  profile: CapturedProcessProfile,
  current: () => boolean,
  custody?: RegisteredProcessRootSource
) => CapturedProcessPort;

/** Finite operations retain the same Main owner without Team service-registration authority. */
export function capturedNativeProcessFactory(
  retainedWindowsLaunch?: HostWindowsLaunch
): CapturedNativeProcessFactory {
  return (profile, current, custody) => new CapturedProcess(
    profile, current, custody, current, undefined,
    retainedWindowsLaunch?.port(profile, current)
  );
}
