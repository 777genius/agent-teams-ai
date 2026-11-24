import type {
  AddMemberRequest,
  ReplaceMembersRequest,
  TeamConfig,
  TeamUpdateConfigRequest,
} from './team';

export interface TeamDefinitionEditApi {
  updateConfig: (teamName: string, updates: TeamUpdateConfigRequest) => Promise<TeamConfig>;
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
  replaceMembers: (teamName: string, request: ReplaceMembersRequest) => Promise<void>;
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  restoreMember: (teamName: string, memberName: string) => Promise<void>;
  updateMemberRole: (
    teamName: string,
    memberName: string,
    role: string | undefined
  ) => Promise<void>;
}

/** A plain result survives contextBridge; custom properties on a rejected Error do not. */
export interface TeamDefinitionEditRefusal {
  type: 'team-definition-edit-refusal';
  message: string;
  failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' };
}

export type TeamDefinitionEditsTransport<TRefusal = TeamDefinitionEditRefusal> = {
  [Method in keyof TeamDefinitionEditApi]: (
    ...args: Parameters<TeamDefinitionEditApi[Method]>
  ) => Promise<Awaited<ReturnType<TeamDefinitionEditApi[Method]>> | TRefusal>;
};
