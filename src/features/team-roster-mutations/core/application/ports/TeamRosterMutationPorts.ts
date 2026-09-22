import type {
  MembersMetadataSnapshot,
  RosterMemberInput,
  RuntimeRosterMutationMember,
} from '../../domain/rosterMutationModels';

export interface TeamRosterMutationRepositoryPort {
  getMembers(teamName: string): Promise<RuntimeRosterMutationMember[]>;
  addMember(teamName: string, member: RosterMemberInput): Promise<void>;
  replaceMembers(teamName: string, request: { members: RosterMemberInput[] }): Promise<void>;
  removeMember(teamName: string, memberName: string): Promise<void>;
  restoreMember(teamName: string, memberName: string): Promise<unknown>;
  updateMemberRole(
    teamName: string,
    memberName: string,
    role: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }>;
}

export interface TeamRosterMetadataPort {
  getSnapshot(teamName: string): Promise<MembersMetadataSnapshot | null>;
  writeSnapshot(teamName: string, snapshot: MembersMetadataSnapshot): Promise<void>;
}

export type LiveRosterAttachReason = 'member_added' | 'member_restored' | 'member_updated';

export interface TeamRosterLifecyclePort {
  runMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  attach(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void>;
  detach(teamName: string, memberName: string): Promise<void>;
}

export interface TeamRosterRuntimePort {
  isAlive(teamName: string): boolean;
}

export interface TeamRosterMessagingPort {
  notifyLead(teamName: string, message: string): Promise<void>;
}

export interface TeamRosterCachePort {
  invalidate(teamName: string): void;
}

export interface TeamRosterLoggerPort {
  error(message: string): void;
  warn(message: string): void;
}
