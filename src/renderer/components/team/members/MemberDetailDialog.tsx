import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@renderer/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { BarChart3, FileText, ListPlus, MessageSquare } from 'lucide-react';

import { MemberDetailHeader } from './MemberDetailHeader';
import { MemberDetailStats } from './MemberDetailStats';
import { MemberLogsTab } from './MemberLogsTab';
import { MemberMessagesTab } from './MemberMessagesTab';
import { MemberStatsTab } from './MemberStatsTab';
import { MemberTasksTab } from './MemberTasksTab';

import type { InboxMessage, ResolvedTeamMember, TeamTask } from '@shared/types';

interface MemberDetailDialogProps {
  open: boolean;
  member: ResolvedTeamMember | null;
  teamName: string;
  tasks: TeamTask[];
  messages: InboxMessage[];
  onClose: () => void;
  onSendMessage: () => void;
  onAssignTask: () => void;
}

export const MemberDetailDialog = ({
  open,
  member,
  teamName,
  tasks,
  messages,
  onClose,
  onSendMessage,
  onAssignTask,
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

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <MemberDetailHeader member={member} />
        </DialogHeader>

        <MemberDetailStats
          totalTasks={memberTasks.length}
          inProgressTasks={inProgressTasks}
          completedTasks={completedTasks}
          messageCount={memberMessages.length}
          lastActiveAt={member.lastActiveAt}
        />

        <Tabs defaultValue="tasks">
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
            <MemberTasksTab tasks={memberTasks} />
          </TabsContent>
          <TabsContent value="messages">
            <MemberMessagesTab messages={memberMessages} />
          </TabsContent>
          <TabsContent value="stats">
            <MemberStatsTab teamName={teamName} memberName={member.name} />
          </TabsContent>
          <TabsContent value="logs">
            <MemberLogsTab teamName={teamName} memberName={member.name} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onSendMessage}>
            <MessageSquare size={14} />
            Send Message
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onAssignTask}>
            <ListPlus size={14} />
            Assign Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
