import {
  type OpenCodeRuntimeLaneIndex,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';

export type OpenCodeMemberDeliveryIdentityResolution = OpenCodeMemberIdentityResolution;

export interface OpenCodeRuntimeManifestRunEvidence {
  activeRunId?: string | null;
}

export interface OpenCodeRuntimeRecoveryIdentityHelperPorts {
  getTeamsBasePath: () => string;
  getCurrentOpenCodeRuntimeRunId: (teamName: string, laneId: string) => string | null;
  readOpenCodeMemberDirectory: (teamName: string) => Promise<OpenCodeMemberDirectory>;
  resolveOpenCodeMemberIdentityFromDirectory: (
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ) => OpenCodeMemberIdentityResolution;
  readOpenCodeRuntimeLaneIndex?: (
    teamsBasePath: string,
    teamName: string
  ) => Promise<OpenCodeRuntimeLaneIndex>;
  readOpenCodeRuntimeManifestEvidence?: (
    teamsBasePath: string,
    teamName: string,
    laneId: string
  ) => Promise<OpenCodeRuntimeManifestRunEvidence>;
}

export interface OpenCodeRuntimeRecoveryIdentityHelpers {
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberDeliveryIdentityResolution>;
  resolveOpenCodeMembersForRuntimeLane(teamName: string, laneId: string): Promise<string[]>;
  isOpenCodeRuntimeLaneIndexActive(teamName: string, laneId: string): Promise<boolean>;
}

export function resolveOpenCodeMemberDeliveryIdentityFromDirectory(input: {
  teamName: string;
  memberName: string;
  directory: OpenCodeMemberDirectory;
  resolveOpenCodeMemberIdentityFromDirectory: (
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ) => OpenCodeMemberIdentityResolution;
}): OpenCodeMemberDeliveryIdentityResolution {
  const laneIdentity = input.resolveOpenCodeMemberIdentityFromDirectory(
    input.teamName,
    input.memberName,
    input.directory
  );
  return laneIdentity;
}

export function resolveOpenCodeMembersForRuntimeLaneFromDirectory(input: {
  teamName: string;
  laneId: string;
  directory: OpenCodeMemberDirectory;
  resolveOpenCodeMemberIdentityFromDirectory: (
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ) => OpenCodeMemberIdentityResolution;
}): string[] {
  const names = new Set<string>();
  for (const member of input.directory.config?.members ?? []) {
    if (member.name?.trim()) {
      names.add(member.name.trim());
    }
  }
  for (const member of input.directory.metaMembers) {
    if (member.name?.trim()) {
      names.add(member.name.trim());
    }
  }
  const resolved: string[] = [];
  for (const name of names) {
    const identity = input.resolveOpenCodeMemberIdentityFromDirectory(
      input.teamName,
      name,
      input.directory
    );
    if (identity.ok && identity.laneId === input.laneId) {
      resolved.push(identity.canonicalMemberName);
    }
  }
  if (resolved.length > 0) {
    return [...new Set(resolved)];
  }
  const secondaryMatch = /^secondary:opencode:(.+)$/i.exec(input.laneId);
  const fallbackMember = secondaryMatch?.[1]?.trim();
  return fallbackMember ? [fallbackMember] : [];
}

export function createOpenCodeRuntimeRecoveryIdentityHelpers(
  ports: OpenCodeRuntimeRecoveryIdentityHelperPorts
): OpenCodeRuntimeRecoveryIdentityHelpers {
  const readLaneIndex = ports.readOpenCodeRuntimeLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const readManifestEvidence =
    ports.readOpenCodeRuntimeManifestEvidence ??
    ((teamsBasePath, teamName, laneId) =>
      new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath }).read(teamName, laneId));

  return {
    async resolveCurrentOpenCodeRuntimeRunId(
      teamName: string,
      laneId: string
    ): Promise<string | null> {
      const inMemoryRunId = ports.getCurrentOpenCodeRuntimeRunId(teamName, laneId);
      if (inMemoryRunId) {
        return inMemoryRunId;
      }

      const laneIndex = await readLaneIndex(ports.getTeamsBasePath(), teamName).catch(() => null);
      if (laneIndex?.lanes[laneId]?.state !== 'active') {
        return null;
      }

      const evidence = await readManifestEvidence(ports.getTeamsBasePath(), teamName, laneId).catch(
        () => null
      );
      const durableRunId = evidence?.activeRunId?.trim();
      return durableRunId || null;
    },

    async resolveOpenCodeMemberDeliveryIdentity(
      teamName: string,
      memberName: string
    ): Promise<OpenCodeMemberDeliveryIdentityResolution> {
      const directory = await ports.readOpenCodeMemberDirectory(teamName);
      return resolveOpenCodeMemberDeliveryIdentityFromDirectory({
        teamName,
        memberName,
        directory,
        resolveOpenCodeMemberIdentityFromDirectory:
          ports.resolveOpenCodeMemberIdentityFromDirectory,
      });
    },

    async resolveOpenCodeMembersForRuntimeLane(
      teamName: string,
      laneId: string
    ): Promise<string[]> {
      const directory = await ports.readOpenCodeMemberDirectory(teamName);
      return resolveOpenCodeMembersForRuntimeLaneFromDirectory({
        teamName,
        laneId,
        directory,
        resolveOpenCodeMemberIdentityFromDirectory:
          ports.resolveOpenCodeMemberIdentityFromDirectory,
      });
    },

    async isOpenCodeRuntimeLaneIndexActive(teamName: string, laneId: string): Promise<boolean> {
      const laneIndex = await readLaneIndex(ports.getTeamsBasePath(), teamName).catch(() => null);
      return laneIndex?.lanes[laneId]?.state === 'active';
    },
  };
}
