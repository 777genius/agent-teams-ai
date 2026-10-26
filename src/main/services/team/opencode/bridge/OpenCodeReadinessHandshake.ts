import {
  freshOpenCodeExecutionProof,
  openCodeReadinessArtifactKey,
} from '../readiness/OpenCodeExpectedBehaviorFingerprint';
import { normalizeOpenCodeProjectIdentity } from '../readiness/OpenCodeProjectIdentity';

import { stableHash, validateOpenCodeBridgeHandshake } from './OpenCodeBridgeCommandContract';

import type { OpenCodeTeamLaunchReadiness } from '../readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeBridgeHandshake,
  OpenCodeBridgePeerIdentity,
  OpenCodeBridgeSuccess,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeBridgeHandshakePort } from './OpenCodeStateChangingBridgeCommandService';

type ReadinessInput = {
  projectPath: string;
  selectedModel: string | null;
  requireExecutionProbe: boolean;
  skipPermissions?: boolean;
  effort?: string;
  freshExecutionProofRequestId?: string;
};
type InlineHandshake = OpenCodeBridgeHandshake & { expectedBehaviorFingerprint?: unknown };
type Entry = {
  input: ReadinessInput;
  readiness: OpenCodeTeamLaunchReadiness;
  handshake: InlineHandshake;
  capability: string;
  behavior: string;
};

/** This private composition-owned port only admits a validated readiness response,
 * never a renderer/caller-provided handshake. One launch consumes one admission. */
export class OpenCodeReadinessHandshake {
  private readonly pending = new Map<string, Entry>();
  private readonly client: OpenCodeBridgePeerIdentity;
  constructor(client: OpenCodeBridgePeerIdentity) {
    this.client = structuredClone(client);
  }

  clear(input: ReadinessInput): void {
    this.pending.delete(openCodeReadinessArtifactKey(input));
  }

  clientIdentity(): OpenCodeBridgePeerIdentity {
    return structuredClone(this.client);
  }

  remember(
    input: ReadinessInput,
    result: OpenCodeBridgeSuccess<OpenCodeTeamLaunchReadiness>
  ): void {
    this.clear(input);
    const data = result.data as OpenCodeTeamLaunchReadiness & { launchHandshake?: unknown };
    if (data.launchHandshake === undefined) return; // V1/older runtime: normal negotiation.
    if (
      result.command !== 'opencode.readiness' ||
      !input.requireExecutionProbe ||
      !data.launchAllowed ||
      input.skipPermissions === false ||
      !input.selectedModel ||
      data.modelId !== input.selectedModel
    )
      throw new Error('OpenCode inline readiness handshake scope mismatch');
    const { proof, expectedBehaviorFingerprint } = freshOpenCodeExecutionProof(data, {
      projectPath: input.projectPath,
      fullModelId: input.selectedModel,
    });
    const handshake = data.launchHandshake as InlineHandshake;
    const validation = validateOpenCodeBridgeHandshake({
      handshake,
      expectedClient: this.client,
      requiredCommand: 'opencode.launchTeam',
      expectedCapabilitySnapshotId: result.runtime.capabilitySnapshotId,
      expectedManifestHighWatermark: null,
      expectedRunId: null,
    });
    if (!validation.ok) throw new Error(validation.reason);
    if (
      handshake.requestId !== result.requestId ||
      handshake.expectedBehaviorFingerprint !== expectedBehaviorFingerprint ||
      proof.capabilitySnapshotId !== result.runtime.capabilitySnapshotId ||
      proof.binaryPath !== result.runtime.binaryPath ||
      proof.binaryFingerprint !== result.runtime.binaryFingerprint ||
      proof.opencodeVersion !== result.runtime.version ||
      handshake.server.runtime.binaryPath !== result.runtime.binaryPath ||
      handshake.server.runtime.binaryFingerprint !== result.runtime.binaryFingerprint ||
      handshake.server.runtime.version !== result.runtime.version ||
      !result.runtime.capabilitySnapshotId
    )
      throw new Error('OpenCode inline readiness handshake evidence mismatch');
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(
      openCodeReadinessArtifactKey(input),
      structuredClone({
        input,
        readiness: data,
        handshake,
        capability: result.runtime.capabilitySnapshotId,
        behavior: expectedBehaviorFingerprint,
      })
    );
  }

  take(
    input: Parameters<OpenCodeBridgeHandshakePort['handshake']>[0] & {
      expectedBehaviorFingerprint?: string | null;
    }
  ): OpenCodeBridgeHandshake | null {
    if (input.requiredCommand !== 'opencode.launchTeam' || !input.cwd) return null;
    const keyFor = (freshExecutionProofRequestId?: string) =>
      openCodeReadinessArtifactKey({
        projectPath: input.cwd!,
        selectedModel: input.selectedModel ?? null,
        requireExecutionProbe: true,
        skipPermissions: input.toolApprovalMode !== 'manual',
        effort: input.effort,
        freshExecutionProofRequestId,
      });
    const key =
      input.expectedRunId && this.pending.has(keyFor(input.expectedRunId))
        ? keyFor(input.expectedRunId)
        : keyFor();
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    if (
      normalizeOpenCodeProjectIdentity(input.cwd) !==
        normalizeOpenCodeProjectIdentity(entry.input.projectPath) ||
      input.selectedModel !== entry.input.selectedModel ||
      input.toolApprovalMode !== 'auto' ||
      input.expectedCapabilitySnapshotId !== entry.capability ||
      input.expectedBehaviorFingerprint !== entry.behavior ||
      input.executionProofIdentity !== stableHash(entry.readiness.executionProof)
    )
      throw new Error('OpenCode inline launch handshake binding mismatch');
    freshOpenCodeExecutionProof(entry.readiness, {
      projectPath: input.cwd,
      fullModelId: input.selectedModel!,
    });
    const validation = validateOpenCodeBridgeHandshake({
      handshake: entry.handshake,
      expectedClient: this.client,
      requiredCommand: input.requiredCommand,
      expectedCapabilitySnapshotId: input.expectedCapabilitySnapshotId,
      expectedManifestHighWatermark: input.expectedManifestHighWatermark,
      expectedRunId: input.expectedRunId,
    });
    if (!validation.ok) throw new Error(validation.reason);
    return entry.handshake;
  }
}
