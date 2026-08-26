import {
  OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION,
  type OpenCodeBridgePeerIdentity,
  validateOpenCodeBridgeHandshake,
} from './OpenCodeBridgeCommandContract';

import type { OpenCodeBridgeHandshakePort } from './OpenCodeStateChangingBridgeCommandService';

export class OpenCodeStrictLaunchDelegationPreflight {
  constructor(
    private readonly handshakePort: OpenCodeBridgeHandshakePort,
    private readonly expectedClient: OpenCodeBridgePeerIdentity
  ) {}

  async validate(input: {
    cwd: string;
  }): Promise<
    | { ok: true; contractVersion: typeof OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION }
    | { ok: false; reason: string }
  > {
    try {
      const handshake = await this.handshakePort.handshake({
        requiredCommand: 'opencode.launchTeam',
        expectedRunId: null,
        expectedCapabilitySnapshotId: null,
        expectedManifestHighWatermark: null,
        cwd: input.cwd,
      });
      const validation = validateOpenCodeBridgeHandshake({
        handshake,
        expectedClient: this.expectedClient,
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: null,
        expectedManifestHighWatermark: null,
        expectedRunId: null,
        launchValidationScope: 'strict-delegation-preflight',
      });
      return validation.ok
        ? { ok: true, contractVersion: OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION }
        : validation;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
