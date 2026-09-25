import type { ReplaceMembersRequest } from '@shared/types';

export interface TeamListRosterPorts {
  replaceRoster(teamName: string, request: ReplaceMembersRequest): Promise<void>;
}
