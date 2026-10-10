import { isDesktopMcpControlAvailable } from '@features/external-agent-connection/main';
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
      const runtimePid = member?.runtimePid ?? member?.pid;
      if (!member?.alive || member.providerId !== 'opencode' || !member.cwd ||
        !member.runtimeSessionId || !Number.isSafeInteger(runtimePid) || (runtimePid ?? 0) <= 0) return null;
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
      // The admitted proof stays request-scoped. Commit checks read current local
      // authority; a bridge/MCP probe must never run while an inbox lock is held.
      const isCurrent = async (): Promise<boolean> => {
        try {
          if (!isDesktopMcpControlAvailable()) return false;
          const current = (await deps.snapshot(teamName)).members[memberName];
          if (!current?.alive || current.runtimeSessionId !== member.runtimeSessionId ||
            current.providerId !== 'opencode' || current.cwd !== member.cwd ||
            current.laneId !== member.laneId ||
            (current.runtimePid ?? current.pid) !== proof.runtimePid) return false;
          const currentManifest = await deps.manifest.read(teamName, member.laneId ?? null);
          if (currentManifest.activeRunId !== manifest.activeRunId ||
            currentManifest.capabilitySnapshotId !== manifest.capabilitySnapshotId ||
            currentManifest.highWatermark !== manifest.highWatermark) return false;
          process.kill(proof.runtimePid, 0);
          return isDesktopMcpControlAvailable();
        } catch { return false; }
      };
      if (!(await isCurrent())) return null;
      return { runKey: proof.runKey, protocolVersion: 1, provider: 'opencode', isCurrent };
    } catch { return null; }
  };
}
