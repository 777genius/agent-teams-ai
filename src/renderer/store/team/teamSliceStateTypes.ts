import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { NotificationTarget } from '@shared/types';

type TeamSectionTarget = NonNullable<Extract<NotificationTarget, { kind: 'team' }>['section']>;

export interface GlobalTaskDetailState {
  teamName: string;
  taskId: string;
  commentId?: string;
}

export interface PendingMemberProfileState {
  teamName?: string;
  memberName: string;
  focus?: 'profile' | 'messages' | 'logs';
}

export interface PendingTeamSectionFocusState {
  teamName: string;
  section: TeamSectionTarget;
}

export interface PendingReviewRequestState {
  taskId: string;
  filePath?: string;
  requestOptions: TaskChangeRequestOptions;
}

export interface TeamsProjectNavigationIntent {
  projectId: string;
  projectPath: string;
}
