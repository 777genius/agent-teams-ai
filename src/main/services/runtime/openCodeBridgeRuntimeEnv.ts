import { getErrorMessage } from '@shared/utils/errorHandling';

import { applyOpenCodeRuntimeBinaryEnv } from './openCodeRuntimeBinaryEnv';

export interface EnsureOpenCodeBridgeRuntimeBinaryEnvOptions {
  targetEnv: NodeJS.ProcessEnv;
  bridgeEnv?: NodeJS.ProcessEnv;
  resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: () => Promise<string | null>;
  onWarning?: (message: string) => void;
}

export async function ensureOpenCodeBridgeRuntimeBinaryEnv({
  targetEnv,
  bridgeEnv = targetEnv,
  resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath,
  onWarning,
}: EnsureOpenCodeBridgeRuntimeBinaryEnvOptions): Promise<void> {
  if (targetEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim()) {
    applyOpenCodeRuntimeBinaryEnv(targetEnv, null);
    return;
  }

  try {
    const appManagedOpenCodeBinary = await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath();
    applyOpenCodeRuntimeBinaryEnv(targetEnv, appManagedOpenCodeBinary);
    if (
      targetEnv !== bridgeEnv &&
      targetEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH &&
      !bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    ) {
      applyOpenCodeRuntimeBinaryEnv(bridgeEnv, targetEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH);
    }
  } catch (error) {
    onWarning?.(
      `[OpenCode] Runtime adapter bundled OpenCode binary unresolved: ${getErrorMessage(error)}`
    );
  }
}
