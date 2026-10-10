import { validateOpenCodeBridgeHandshake } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

import type { GroupChatRun } from '../composition/createTeamGroupChatsFeature';
import type { OpenCodeBridgePeerIdentity } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeBridgeHandshakePort, RuntimeStoreManifestReader } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';

/** Read-only, member-scoped proof from the current runtime handshake. */
export function createOpenCodeGroupChatRunGetter(deps: {
  clientIdentity: OpenCodeBridgePeerIdentity;
  handshake: OpenCodeBridgeHandshakePort;
  manifest: RuntimeStoreManifestReader;
  snapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}) {
  return async (teamName: string, memberName: string): Promise<GroupChatRun | null> => {
    try {
      const snapshot = await deps.snapshot(teamName);
      const member = snapshot.members[memberName];
      if (!member?.alive || member.providerId !== 'opencode' || !member.cwd) return null;
      const manifest = await deps.manifest.read(teamName, member.laneId ?? null);
      if (!manifest.activeRunId || !manifest.capabilitySnapshotId) return null;
      const handshake = await deps.handshake.handshake({
        requiredCommand: 'opencode.sendMessage',
        expectedRunId: manifest.activeRunId,
        expectedCapabilitySnapshotId: manifest.capabilitySnapshotId,
        expectedManifestHighWatermark: manifest.highWatermark,
        teamId: teamName, laneId: member.laneId ?? null,
        teamName, memberName, cwd: member.cwd,
      });
      if (!validateOpenCodeBridgeHandshake({
        handshake, expectedClient: deps.clientIdentity, requiredCommand: 'opencode.sendMessage',
        expectedRunId: manifest.activeRunId,
        expectedCapabilitySnapshotId: manifest.capabilitySnapshotId,
        expectedManifestHighWatermark: manifest.highWatermark,
      }).ok) return null;
      const proof = handshake.server.runtime.groupChatRunProof;
      if (handshake.server.bridgeProtocol.groupChatProtocolVersion !== 1 ||
        !proof || proof.processorReady !== true || proof.teamName !== teamName ||
        proof.memberName !== memberName || proof.runId !== manifest.activeRunId ||
        proof.runKey !== manifest.activeRunId || proof.laneId !== (member.laneId ?? null) ||
        !member.runtimeSessionId || proof.runtimeSessionId !== member.runtimeSessionId ||
        !Number.isSafeInteger(proof.runtimePid) || proof.runtimePid <= 0 ||
        proof.runtimePid !== (member.runtimePid ?? member.pid)) return null;
      process.kill(proof.runtimePid, 0);
      // Re-read liveness after the asynchronous handshake, fencing replacement/stop.
      const current = (await deps.snapshot(teamName)).members[memberName];
      if (!current?.alive || current.runtimeSessionId !== member.runtimeSessionId ||
        current.providerId !== 'opencode' || current.cwd !== member.cwd ||
        current.laneId !== member.laneId ||
        (current.runtimePid ?? current.pid) !== proof.runtimePid) return null;
      const currentManifest = await deps.manifest.read(teamName, member.laneId ?? null);
      if (currentManifest.activeRunId !== manifest.activeRunId ||
        currentManifest.capabilitySnapshotId !== manifest.capabilitySnapshotId ||
        currentManifest.highWatermark !== manifest.highWatermark) return null;
      return { runKey: proof.runKey, protocolVersion: 1, provider: 'opencode' };
    } catch { return null; }
  };
}
