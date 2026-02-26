import { useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@renderer/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useMemberStats } from '@renderer/hooks/useMemberStats';
import { BarChart3, FileText, ListPlus, MessageSquare, UserMinus } from 'lucide-react';

import { MemberDetailHeader } from './MemberDetailHeader';
import { MemberDetailStats, type MemberDetailTab } from './MemberDetailStats';
import { MemberLogsTab } from './MemberLogsTab';
import { MemberMessagesTab } from './MemberMessagesTab';
import { MemberStatsTab } from './MemberStatsTab';
import { MemberTasksTab } from './MemberTasksTab';

import type {
  InboxMessage,
  LeadActivityState,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberDetailDialogProps {
  open: boolean;
  member: ResolvedTeamMember | null;
  teamName: string;
  tasks: TeamTaskWithKanban[];
  messages: InboxMessage[];
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  onClose: () => void;
  onSendMessage: () => void;
  onAssignTask: () => void;
  onTaskClick: (task: TeamTaskWithKanban) => void;
  onRemoveMember?: () => void;
  onUpdateRole?: (memberName: string, role: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
  onViewMemberChanges?: (memberName: string, filePath?: string) => void;
}

export const MemberDetailDialog = ({
  open,
  member,
  teamName,
  tasks,
  messages,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  onClose,
  onSendMessage,
  onAssignTask,
  onTaskClick,
  onRemoveMember,
  onUpdateRole,
  updatingRole,
  onViewMemberChanges,
}: MemberDetailDialogProps): React.JSX.Element | null => {
  const memberTasks = useMemo(
    () => (member ? tasks.filter((t) => t.owner === member.name) : []),
    [tasks, member]
  );

  const memberMessages = useMemo(
    () => (member ? messages.filter((m) => m.from === member.name || m.to === member.name) : []),
    [messages, member]
  );

  const inProgressTasks = useMemo(
    () => memberTasks.filter((t) => t.status === 'in_progress').length,
    [memberTasks]
  );

  const completedTasks = useMemo(
    () => memberTasks.filter((t) => t.status === 'completed').length,
    [memberTasks]
  );

  const [activeTab, setActiveTab] = useState<MemberDetailTab>('tasks');

  const {
    stats: memberStats,
    loading: statsLoading,
    error: statsError,
  } = useMemberStats(teamName, member?.name ?? null);

  const totalTokens = memberStats ? memberStats.inputTokens + memberStats.outputTokens : null;

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-4xl">
        <div className="flex items-start gap-4">
          <DialogHeader className="shrink-0">
            <MemberDetailHeader
              member={member}
              isTeamAlive={isTeamAlive}
              isTeamProvisioning={isTeamProvisioning}
              leadActivity={member.agentType === 'team-lead' ? leadActivity : undefined}
              onUpdateRole={
                onUpdateRole ? (newRole) => onUpdateRole(member.name, newRole) : undefined
              }
              updatingRole={updatingRole}
            />
          </DialogHeader>

          <MemberDetailStats
            totalTasks={memberTasks.length}
            inProgressTasks={inProgressTasks}
            completedTasks={completedTasks}
            messageCount={memberMessages.length}
            totalTokens={totalTokens}
            statsLoading={statsLoading}
            statsComputedAt={memberStats?.computedAt}
            onTabChange={setActiveTab}
          />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as MemberDetailTab)}
          className="min-w-0 overflow-hidden"
        >
          <TabsList className="w-full">
            <TabsTrigger value="tasks" className="flex-1 gap-1.5">
              Tasks
              {memberTasks.length > 0 && (
                <span className="rounded-full bg-[var(--color-surface)] px-1.5 text-[10px]">
                  {memberTasks.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="messages" className="flex-1 gap-1.5">
              Messages
              {memberMessages.length > 0 && (
                <span className="rounded-full bg-[var(--color-surface)] px-1.5 text-[10px]">
                  {memberMessages.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="stats" className="flex-1 gap-1.5">
              <BarChart3 size={12} />
              Stats
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex-1 gap-1.5">
              <FileText size={12} />
              Logs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tasks">
            <MemberTasksTab tasks={memberTasks} onTaskClick={onTaskClick} />
          </TabsContent>
          <TabsContent value="messages">
            <MemberMessagesTab messages={memberMessages} teamName={teamName} />
          </TabsContent>
          <TabsContent value="stats">
            <MemberStatsTab
              teamName={teamName}
              memberName={member.name}
              prefetchedStats={memberStats}
              prefetchedLoading={statsLoading}
              prefetchedError={statsError}
              onFileClick={(filePath) => onViewMemberChanges?.(member.name, filePath)}
              onShowAllFiles={() => onViewMemberChanges?.(member.name)}
            />
          </TabsContent>
          <TabsContent value="logs" className="min-w-0 overflow-hidden">
            <MemberLogsTab teamName={teamName} memberName={member.name} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          {member.removedAt ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              Removed {new Date(member.removedAt).toLocaleDateString()}
            </span>
          ) : (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onSendMessage}>
                <MessageSquare size={14} />
                Send Message
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onAssignTask}>
                <ListPlus size={14} />
                Assign Task
              </Button>
              {onRemoveMember && member.agentType !== 'team-lead' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  onClick={onRemoveMember}
                >
                  <UserMinus size={14} />
                  Remove
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
