import { useMemo } from 'react';

import { useGraphChangeReviewDialog } from './useGraphChangeReviewDialog';
import { useGraphCreateTaskDialog } from './useGraphCreateTaskDialog';
import { useGraphMemberDetailDialog } from './useGraphMemberDetailDialog';
import { useGraphSendMessageDialog } from './useGraphSendMessageDialog';
import { useGraphTaskActions } from './useGraphTaskActions';
import { useGraphTaskDetailDialog } from './useGraphTaskDetailDialog';

import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';

interface OpenProfileOptions {
  initialActivityFilter?: MemberActivityFilter;
  initialTab?: MemberDetailTab;
}

export function useGraphSurfaceInteractions(teamName: string): {
  dialogs: React.ReactNode;
  onApproveTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  openCreateTask: (owner?: string) => void;
  openMemberProfile: (memberName: string, options?: OpenProfileOptions) => void;
  openSendMessage: (memberName?: string) => void;
  openTaskChanges: (taskId: string, filePath?: string) => void;
  openTaskDetail: (taskId: string) => void;
} {
  const changeReview = useGraphChangeReviewDialog(teamName);
  const createTask = useGraphCreateTaskDialog(teamName);
  const sendMessage = useGraphSendMessageDialog(teamName);
  const taskActions = useGraphTaskActions(teamName);
  const taskDetail = useGraphTaskDetailDialog(teamName, {
    onDeleteTask: taskActions.onDeleteTask,
    onViewChanges: changeReview.openTaskChanges,
  });
  const memberDetail = useGraphMemberDetailDialog(teamName, {
    onAssignTask: createTask.openCreateTaskDialog,
    onSendMessage: sendMessage.openSendMessage,
    onTaskClick: taskDetail.openTaskDetail,
    onViewMemberChanges: changeReview.openMemberChanges,
  });

  const dialogs = useMemo(
    () => (
      <>
        {createTask.dialog}
        {sendMessage.dialog}
        {taskActions.dialog}
        {taskDetail.dialog}
        {memberDetail.dialog}
        {changeReview.dialog}
      </>
    ),
    [
      changeReview.dialog,
      createTask.dialog,
      memberDetail.dialog,
      sendMessage.dialog,
      taskActions.dialog,
      taskDetail.dialog,
    ]
  );

  return {
    dialogs,
    onApproveTask: taskActions.onApproveTask,
    onCancelTask: taskActions.onCancelTask,
    onCompleteTask: taskActions.onCompleteTask,
    onDeleteTask: taskActions.onDeleteTask,
    onMoveBackToDone: taskActions.onMoveBackToDone,
    onRequestChanges: taskActions.onRequestChanges,
    onRequestReview: taskActions.onRequestReview,
    onStartTask: taskActions.onStartTask,
    openCreateTask: createTask.openCreateTaskDialog,
    openMemberProfile: memberDetail.openMemberProfile,
    openSendMessage: sendMessage.openSendMessage,
    openTaskChanges: changeReview.openTaskChanges,
    openTaskDetail: taskDetail.openTaskDetail,
  };
}
