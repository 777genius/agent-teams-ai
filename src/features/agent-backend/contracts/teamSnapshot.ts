import type { BackendCrossTeamOutboxRow } from './crossTeam';
import type { BackendProcess } from './processes';
import type { BackendTeamPosition } from './teamChanges';
import type { BackendTeamLifecycle } from './teamLifecycle';
import type { InboxMessage, KanbanState, TeamTaskWithKanban } from '@shared/types/team';

/** Consumer-owned product read; runtime/process readiness is a separate conversation. */
export interface BackendTeamSnapshot {
  teamName: string;
  revision: string;
  lifecycle?: BackendTeamLifecycle;
  /** Product configuration read together with this snapshot, for coherent dialog hydration. */
  configurationRevision?: string;
  feed: BackendTeamPosition;
  members: { name: string; role: 'lead' | 'member' }[];
  tasks: TeamTaskWithKanban[];
  processes?: BackendProcess[];
  messages: (InboxMessage & {
    crossTeamOrigin?: Pick<
      BackendCrossTeamOutboxRow,
      | 'fromHandleId'
      | 'toHandleId'
      | 'fromTeamResourceRef'
      | 'toTeamResourceRef'
      | 'fromTeamName'
      | 'toTeamName'
    >;
  })[];
  kanbanState: KanbanState;
}
