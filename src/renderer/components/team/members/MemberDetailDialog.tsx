import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@renderer/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useMemberStats } from '@renderer/hooks/useMemberStats';
import { useStore } from '@renderer/store';
import { selectMemberMessagesForTeamMember } from '@renderer/store/slices/teamSlice';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  BarChart3,
  FileText,
  ListPlus,
  Loader2,
  MessageSquare,
  RotateCcw,
  UserMinus,
} from 'lucide-react';

import { buildMemberActivityEntries } from './memberActivityEntries';
import { MemberDetailHeader } from './MemberDetailHeader';
import { MemberDetailStats } from './MemberDetailStats';
import { type MemberActivityFilter, type MemberDetailTab } from './memberDetailTypes';
import { MemberLogsTab } from './MemberLogsTab';
import { MemberMessagesTab } from './MemberMessagesTab';
import { MemberStatsTab } from './MemberStatsTab';
import { MemberTasksTab } from './MemberTasksTab';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type {
  LeadActivityState,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberDetailDialogProps {
  open: boolean;
  member: ResolvedTeamMember | null;
  teamName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  initialTab?: MemberDetailTab;
  initialActivityFilter?: MemberActivityFilter;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  isLaunchSettling?: boolean;
  leadActivity?: LeadActivityState;
  spawnEntry?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
  launchParams?: TeamLaunchParams;
  onClose: () => void;
  onSendMessage: () => void;
  onAssignTask: () => void;
  onTaskClick: (task: TeamTaskWithKanban) => void;
  onRemoveMember?: () => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onUpdateRole?: (memberName: string, role: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
  onViewMemberChanges?: (memberName: string, filePath?: string) => void;
}

export const MemberDetailDialog = ({
  open,
  member,
  teamName,
  members,
  tasks,
  initialTab = 'tasks',
  initialActivityFilter = 'all',
  isTeamAlive,
  isTeamProvisioning,
  isLaunchSettling,
  leadActivity,
  spawnEntry,
  runtimeEntry,
  launchParams,
  onClose,
  onSendMessage,
  onAssignTask,
  onTaskClick,
  onRemoveMember,
  onRestartMember,
  onUpdateRole,
  updatingRole,
  onViewMemberChanges,
}: MemberDetailDialogProps): React.JSX.Element | null => {
  const memberTasks = useMemo(
    () => (member ? tasks.filter((t) => t.owner === member.name) : []),
    [tasks, member]
  );
  const memberMessages = useStore((state) =>
    selectMemberMessagesForTeamMember(state, teamName, member?.name ?? null)
  );
  const memberActivityCount = useMemo(() => {
    if (!member) {
      return 0;
    }
    return buildMemberActivityEntries({
      teamName,
      memberName: member.name,
      members,
      tasks,
      messages: memberMessages,
    }).length;
  }, [member, memberMessages, members, tasks, teamName]);

  const inProgressTasks = useMemo(
    () => memberTasks.filter((t) => t.status === 'in_progress').length,
    [memberTasks]
  );

  const completedTasks = useMemo(
    () => memberTasks.filter((t) => t.status === 'completed').length,
    [memberTasks]
  );

  const [activeTab, setActiveTab] = useState<MemberDetailTab>(initialTab);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const runtimeSummary = useMemo(
    () =>
      member
        ? resolveMemberRuntimeSummary(member, launchParams, spawnEntry, runtimeEntry)
        : undefined,
    [launchParams, member, runtimeEntry, spawnEntry]
  );
  const restartInFlight =
    spawnEntry?.launchState === 'starting' ||
    spawnEntry?.launchState === 'runtime_pending_bootstrap';

  useEffect(() => {
    if (!open || !member) {
      return;
    }
    setActiveTab(initialTab);
    setRestartError(null);
    setRestarting(false);
  }, [initialTab, member, open]);

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
              runtimeSummary={runtimeSummary}
              isTeamAlive={isTeamAlive}
              isTeamProvisioning={isTeamProvisioning}
              leadActivity={isLeadMember(member) ? leadActivity : undefined}
              spawnStatus={spawnEntry?.status}
              spawnLaunchState={spawnEntry?.launchState}
              spawnLivenessSource={spawnEntry?.livenessSource}
              spawnRuntimeAlive={spawnEntry?.runtimeAlive}
              isLaunchSettling={isLaunchSettling}
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
            activityCount={memberActivityCount}
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
            <TabsTrigger value="activity" className="flex-1 gap-1.5">
              Activity
              {memberActivityCount > 0 && (
                <span className="rounded-full bg-[var(--color-surface)] px-1.5 text-[10px]">
                  {memberActivityCount}
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
          <TabsContent value="activity">
            <MemberMessagesTab
              teamName={teamName}
              memberName={member.name}
              members={members}
              tasks={tasks}
              initialFilter={initialActivityFilter}
              onTaskClick={onTaskClick}
            />
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
          {restartError ? (
            <div className="mr-auto text-xs text-red-400">{restartError}</div>
          ) : runtimeEntry?.pid ? (
            <div className="mr-auto text-xs text-[var(--color-text-muted)]">
              PID {runtimeEntry.pid}
            </div>
          ) : (
            <div className="mr-auto" />
          )}
          {member.removedAt ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              Removed {new Date(member.removedAt).toLocaleDateString()}
            </span>
          ) : (
            <>
              {onRestartMember &&
                !isLeadMember(member) &&
                (isTeamAlive || isTeamProvisioning) &&
                runtimeEntry?.restartable !== false && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={restarting || restartInFlight}
                    onClick={async () => {
                      setRestartError(null);
                      setRestarting(true);
                      try {
                        await onRestartMember(member.name);
                      } catch (error) {
                        setRestartError(
                          error instanceof Error ? error.message : 'Failed to restart member'
                        );
                      } finally {
                        setRestarting(false);
                      }
                    }}
                  >
                    {restarting ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    Restart
                  </Button>
                )}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onSendMessage}>
                <MessageSquare size={14} />
                Send Message
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onAssignTask}>
                <ListPlus size={14} />
                Assign Task
              </Button>
              {onRemoveMember && !isLeadMember(member) && (
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
