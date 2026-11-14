import { CapturedOpenCodeRuntimeInstaller } from '../application/CapturedOpenCodeRuntimeInstaller';
import { OpenCodeV2SupportInstaller } from '../application/OpenCodeV2SupportInstaller';
import { captureOpenCodeNativeSelection } from '../infrastructure/captureOpenCodeNativeSelection';

import type { CapturedOpenCodeInstallDependencies } from '../application/CapturedOpenCodeRuntimeInstaller';

export function createCapturedOpenCodeRuntimeInstaller(
  native: CapturedOpenCodeInstallDependencies['native']
) {
  const support = new OpenCodeV2SupportInstaller();
  return new CapturedOpenCodeRuntimeInstaller({
    native,
    captureSelection: (status, original) =>
      captureOpenCodeNativeSelection(status, original, support),
  });
}
