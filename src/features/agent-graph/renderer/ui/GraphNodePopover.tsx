/**
 * GraphNodePopover — renders popover for graph nodes using project UI components.
 * This stays in the renderer slice instead of the reusable package because it
 * composes project-specific UI, selectors, and presentation helpers.
 */

import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberLaunchPresentation,
} from '@renderer/utils/memberHelpers';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';
import { ExternalLink, Loader2, MessageSquare, Plus, User } from 'lucide-react';

import { isTaskInReviewCycle, resolveTaskReviewer } from '../../core/domain/taskGraphSemantics';
import { useGraphActivityContext } from '../hooks/useGraphActivityContext';
import { useGraphMemberPopoverContext } from '../hooks/useGraphMemberPopoverContext';

import { GraphTaskCard } from './GraphTaskCard';

import type { GraphNode } from '@claude-teams/agent-graph';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';
import type { TeamTaskWithKanban } from '@shared/types';

// ─── Tool name/preview formatters ───────────────────────────────────────────

/** Clean up tool names: "mcp__agent-teams__task_create" → "Task Create" */
function formatToolName(raw: string): string {
  // Strip MCP prefixes (mcp__serverName__toolName → toolName)
  const parts = raw.split('__');
  const name = parts[parts.length - 1] ?? raw;
  // snake_case → Title Case
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Clean up tool preview: strip raw JSON, extract meaningful part */
function formatToolPreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  // If it looks like raw JSON object, try to extract a readable field
  if (preview.startsWith('{') || preview.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(preview.length > 200 ? preview.slice(0, 200) : preview);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const previewRecord = parsed as Record<string, unknown>;
        const candidates = [
          previewRecord.subject,
          previewRecord.name,
          previewRecord.label,
          previewRecord.file_path,
          previewRecord.path,
          previewRecord.query,
        ];
        const firstText = candidates.find((value) => typeof value === 'string');
        if (typeof firstText === 'string') {
          return firstText;
        }
      }
    } catch {
      // Truncated JSON — extract first quoted value
      const match = /"(?:subject|name|label|path|query)":\s*"([^"]{1,60})"/.exec(preview);
      if (match) return match[1];
    }
  }
  return preview.length > 50 ? preview.slice(0, 50) + '...' : preview;
}

interface GraphNodePopoverProps {
  node: GraphNode;
  teamName: string;
  onClose: () => void;
  onSendMessage?: (memberName: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (
    memberName: string,
    options?: {
      initialActivityFilter?: MemberActivityFilter;
      initialTab?: MemberDetailTab;
    }
  ) => void;
  onCreateTask?: (owner: string) => void;
  onStartTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  onApproveTask?: (taskId: string) => void;
  onRequestReview?: (taskId: string) => void;
  onRequestChanges?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onMoveBackToDone?: (taskId: string) => void;
  onViewChanges?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
}

export const GraphNodePopover = ({
  node,
  teamName,
  onClose,
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
  onCreateTask,
  onStartTask,
  onCompleteTask,
  onApproveTask,
  onRequestReview,
  onRequestChanges,
  onCancelTask,
  onMoveBackToDone,
  onViewChanges,
  onDeleteTask,
}: GraphNodePopoverProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  if (node.kind === 'member' || node.kind === 'lead') {
    return (
      <MemberPopoverContent
        node={node}
        onClose={onClose}
        onSendMessage={onSendMessage}
        onOpenProfile={onOpenMemberProfile}
        onCreateTask={onCreateTask}
        onOpenTask={onOpenTaskDetail}
      />
    );
  }

  if (node.kind === 'task') {
    if (node.isOverflowStack || node.domainRef.kind === 'task_overflow') {
      return (
        <OverflowPopoverContent
          node={node}
          teamName={teamName}
          onClose={onClose}
          onOpenTaskDetail={onOpenTaskDetail}
        />
      );
    }
    return (
      <GraphTaskCard
        node={node}
        teamName={teamName}
        onClose={onClose}
        onOpenDetail={onOpenTaskDetail}
        onStartTask={onStartTask}
        onCompleteTask={onCompleteTask}
        onApproveTask={onApproveTask}
        onRequestReview={onRequestReview}
        onRequestChanges={onRequestChanges}
        onCancelTask={onCancelTask}
        onMoveBackToDone={onMoveBackToDone}
        onViewChanges={onViewChanges}
        onDeleteTask={onDeleteTask}
      />
    );
  }

  // Cross-team ghost node
  if (node.kind === 'crossteam') {
    const extTeamName =
      node.domainRef.kind === 'crossteam' ? node.domainRef.externalTeamName : node.label;
    return (
      <div className="min-w-[180px] rounded-lg border border-purple-500/30 bg-[var(--color-surface-raised)] p-3 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="text-sm text-purple-400">{'\u{2194}'}</span>
          <span className="font-mono text-xs font-bold text-purple-300">{extTeamName}</span>
        </div>
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          {t('agentGraph.popover.externalTeam')}
        </div>
      </div>
    );
  }

  // Process
  return (
    <div className="min-w-[180px] max-w-[260px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="font-mono text-xs font-bold text-[var(--color-text)]">{node.label}</div>
      {node.processCommand && (
        <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
          $ {node.processCommand}
        </div>
      )}
      <div className="mt-2 space-y-0.5 text-[10px] text-[var(--color-text-muted)]">
        {node.processRegisteredBy && (
          <div>
            {t('agentGraph.popover.process.startedBy')}{' '}
            <span className="text-[var(--color-text)]">{node.processRegisteredBy}</span>
          </div>
        )}
        {node.processRegisteredAt && (
          <div>
            {t('agentGraph.popover.process.at')}{' '}
            {new Date(node.processRegisteredAt).toLocaleTimeString()}
          </div>
        )}
        {node.exceptionLabel && (
          <Badge
            variant="outline"
            className={`px-1.5 py-0 text-[10px] ${
              node.exceptionTone === 'error'
                ? 'border-red-500/30 text-red-400'
                : 'border-amber-500/30 text-amber-400'
            }`}
          >
            {node.exceptionLabel}
          </Badge>
        )}
      </div>
      {node.processUrl && (
        <a
          href={node.processUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center gap-1 text-xs text-blue-400 hover:underline"
        >
          <ExternalLink size={12} /> {t('agentGraph.popover.process.openUrl')}
        </a>
      )}
    </div>
  );
};

const OverflowPopoverContent = ({
  node,
  teamName,
  onClose,
  onOpenTaskDetail,
}: {
  node: GraphNode;
  teamName: string;
  onClose: () => void;
  onOpenTaskDetail?: (taskId: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { teamData } = useGraphActivityContext(teamName);
  const tasksById = new Map((teamData?.tasks ?? []).map((task) => [task.id, task]));
  const hiddenTasks = (node.overflowTaskIds ?? [])
    .map((taskId) => tasksById.get(taskId) ?? null)
    .filter((task): task is TeamTaskWithKanban => task != null);

  return (
    <div className="min-w-[240px] max-w-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[var(--color-text)]">
          {t('agentGraph.popover.overflow.hiddenTasks')}
        </div>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {node.overflowCount ?? hiddenTasks.length}
        </Badge>
      </div>
      <div className="mt-2 max-h-[260px] space-y-1 overflow-y-auto pr-1">
        {hiddenTasks.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)]">
            {t('agentGraph.popover.overflow.empty')}
          </div>
        ) : (
          hiddenTasks.map((task) => {
            const reviewer = resolveTaskReviewer(task, teamData?.kanbanState.tasks[task.id]);
            return (
              <button
                key={task.id}
                type="button"
                className="flex w-full items-start justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-left transition-colors hover:border-[var(--color-border-emphasis)]"
                onClick={() => {
                  onOpenTaskDetail?.(task.id);
                  onClose();
                }}
              >
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                    {task.displayId ?? `#${task.id.slice(0, 6)}`}
                  </div>
                  <div className="truncate text-xs text-[var(--color-text)]">{task.subject}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {task.owner && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {task.owner}
                    </Badge>
                  )}
                  {isTaskInReviewCycle(task) && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {reviewer ?? 'REV'}
                    </Badge>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

// ─── Member Popover ─────────────────────────────────────────────────────────

const MemberPopoverContent = ({
  node,
  onClose,
  onSendMessage,
  onOpenProfile,
  onCreateTask,
  onOpenTask,
}: {
  node: GraphNode;
  onClose: () => void;
  onSendMessage?: (name: string) => void;
  onOpenProfile?: (name: string) => void;
  onCreateTask?: (owner: string) => void;
  onOpenTask?: (taskId: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const memberName =
    node.domainRef.kind === 'member' || node.domainRef.kind === 'lead'
      ? node.domainRef.memberName
      : 'team-lead';
  const teamName =
    node.domainRef.kind === 'member' || node.domainRef.kind === 'lead'
      ? node.domainRef.teamName
      : '';
  const {
    teamData,
    teamMembers,
    spawnEntry,
    runtimeEntry,
    leadActivity,
    progress,
    memberSpawnSnapshot,
    memberSpawnStatuses,
  } = useGraphMemberPopoverContext(teamName, memberName);
  const avatarMap = useMemo(() => buildMemberAvatarMap(teamMembers), [teamMembers]);
  const avatarSrc = node.avatarUrl ?? avatarMap.get(memberName) ?? agentAvatarUrl(memberName, 64);
  const member = teamMembers.find((candidate) => candidate.name === memberName) ?? null;
  const currentTaskCandidate =
    member?.currentTaskId && teamData
      ? (teamData.tasks.find((task) => task.id === member.currentTaskId) ?? null)
      : null;
  const displayableCurrentTask = isDisplayableCurrentTask(currentTaskCandidate)
    ? currentTaskCandidate
    : null;
  const currentTaskIndicatorId =
    displayableCurrentTask?.id ?? (!teamData ? node.currentTaskId : undefined);
  const currentTaskIndicatorSubject =
    displayableCurrentTask?.subject ?? (!teamData ? node.currentTaskSubject : undefined);
  const provisioningPresentation =
    teamData && teamName
      ? buildTeamProvisioningPresentation({
          progress,
          members: teamMembers,
          memberSpawnStatuses,
          memberSpawnSnapshot,
          t,
        })
      : null;
  const launchPresentation = member
    ? buildMemberLaunchPresentation({
        member:
          member.currentTaskId && !displayableCurrentTask
            ? { ...member, currentTaskId: null }
            : member,
        spawnStatus: spawnEntry?.status,
        spawnLaunchState: spawnEntry?.launchState,
        spawnLivenessSource: spawnEntry?.livenessSource,
        spawnRuntimeAlive: spawnEntry?.runtimeAlive,
        spawnBootstrapConfirmed: spawnEntry?.bootstrapConfirmed,
        spawnBootstrapStalled: spawnEntry?.bootstrapStalled,
        spawnAgentToolAccepted: spawnEntry?.agentToolAccepted,
        spawnHardFailure: spawnEntry?.hardFailure,
        spawnLivenessKind: spawnEntry?.livenessKind,
        spawnFirstSpawnAcceptedAt: spawnEntry?.firstSpawnAcceptedAt,
        spawnUpdatedAt: spawnEntry?.updatedAt,
        runtimeEntry,
        runtimeAdvisory: member.runtimeAdvisory,
        isLaunchSettling: provisioningPresentation?.hasMembersStillJoining ?? false,
        isTeamAlive: teamData?.isAlive,
        isTeamProvisioning: provisioningPresentation?.isActive ?? false,
        leadActivity: node.kind === 'lead' ? leadActivity : undefined,
      })
    : null;
  const fallbackSpawnStatusLabel =
    node.spawnStatus && node.spawnStatus !== 'online'
      ? node.spawnStatus === 'waiting'
        ? t('agentGraph.popover.member.spawn.waitingToStart')
        : node.spawnStatus === 'spawning'
          ? t('agentGraph.popover.member.spawn.starting')
          : node.spawnStatus === 'error'
            ? t('agentGraph.popover.member.spawn.failed')
            : node.spawnStatus
      : null;
  const statusLabel =
    launchPresentation?.launchStatusLabel ??
    node.launchStatusLabel ??
    launchPresentation?.presenceLabel ??
    fallbackSpawnStatusLabel ??
    (node.state === 'active'
      ? t('agentGraph.popover.member.state.active')
      : node.state === 'idle'
        ? t('agentGraph.popover.member.state.idle')
        : node.state === 'terminated'
          ? t('agentGraph.popover.member.state.offline')
          : node.state === 'tool_calling'
            ? t('agentGraph.popover.member.state.runningTool')
            : node.state);
  const statusDotClass =
    launchPresentation?.dotClass ??
    (node.spawnStatus === 'spawning'
      ? 'bg-amber-400'
      : node.spawnStatus === 'waiting'
        ? 'bg-zinc-400 animate-pulse'
        : node.state === 'active' || node.state === 'thinking' || node.state === 'tool_calling'
          ? 'bg-emerald-400'
          : node.state === 'idle'
            ? 'bg-zinc-400'
            : node.state === 'error'
              ? 'bg-red-400'
              : 'bg-zinc-600');
  const hasErrorException = node.exceptionTone === 'error';
  const statusBadgeClass = hasErrorException
    ? 'border-red-500/60 bg-red-500/10 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.22)]'
    : '';
  const showExceptionBadge = node.exceptionLabel && node.exceptionLabel !== statusLabel;

  return (
    <div
      className="min-w-[200px] max-w-[280px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl"
      style={
        hasErrorException
          ? {
              borderColor: 'rgba(239, 68, 68, 0.42)',
              boxShadow: '0 18px 38px rgba(0, 0, 0, 0.45), 0 0 26px rgba(239, 68, 68, 0.2)',
            }
          : undefined
      }
    >
      {/* Header: avatar + name */}
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <img
            src={avatarSrc}
            alt={memberName}
            className="size-10 rounded-full border border-[var(--color-border)]"
          />
          <div
            className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-surface-raised)] ${statusDotClass}`}
          />
        </div>
        <div className="min-w-0">
          <div
            className="truncate text-sm font-semibold text-[var(--color-text)]"
            style={{ color: node.color }}
          >
            {node.label.split(' · ')[0]}
          </div>
          {node.role && (
            <div className="truncate text-xs text-[var(--color-text-muted)]">{node.role}</div>
          )}
          {node.runtimeLabel && (
            <div className="truncate text-[11px] text-[var(--color-text-muted)]">
              {node.runtimeLabel}
            </div>
          )}
        </div>
      </div>

      {/* Status badges */}
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${statusBadgeClass}`}>
          {statusLabel}
        </Badge>
        {node.kind === 'lead' && (
          <Badge
            variant="outline"
            className="border-blue-500/30 px-1.5 py-0 text-[10px] text-blue-400"
          >
            {t('agentGraph.popover.member.lead')}
          </Badge>
        )}
        {(launchPresentation?.spawnBadgeLabel ?? fallbackSpawnStatusLabel) &&
          (launchPresentation?.spawnBadgeLabel ?? fallbackSpawnStatusLabel) !== statusLabel && (
            <Badge
              variant="outline"
              className="border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-400"
            >
              {launchPresentation?.spawnBadgeLabel ?? fallbackSpawnStatusLabel}
            </Badge>
          )}
        {showExceptionBadge && (
          <Badge
            variant="outline"
            className={`px-1.5 py-0 text-[10px] ${
              node.exceptionTone === 'error'
                ? 'border-red-500/60 bg-red-500/10 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.22)]'
                : 'border-amber-500/30 text-amber-400'
            }`}
          >
            {node.exceptionLabel}
          </Badge>
        )}
      </div>

      {/* Context usage stays hidden for now because lead context telemetry is still incomplete. */}

      {/* Current task indicator — reuses same pattern as MemberCard */}
      {currentTaskIndicatorId && currentTaskIndicatorSubject && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px]">
          <Loader2
            className="size-3 shrink-0 animate-spin"
            style={{ color: node.color ?? '#66ccff' }}
          />
          <span className="shrink-0 text-[var(--color-text-muted)]">
            {t('agentGraph.popover.member.workingOn')}
          </span>
          <button
            type="button"
            className="min-w-0 truncate rounded px-1.5 py-0.5 font-medium text-[var(--color-text)] transition-opacity hover:opacity-90"
            style={{ border: `1px solid ${node.color ?? '#66ccff'}40` }}
            onClick={(e) => {
              e.stopPropagation();
              onOpenTask?.(currentTaskIndicatorId);
              onClose();
            }}
          >
            {currentTaskIndicatorSubject.length > 30
              ? `${currentTaskIndicatorSubject.slice(0, 30)}…`
              : currentTaskIndicatorSubject}
          </button>
        </div>
      )}

      {node.activeTool && (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1.5 text-[10px]">
          <div className="flex items-center gap-1.5">
            <Loader2
              className={`size-3 shrink-0 ${node.activeTool.state === 'running' ? 'animate-spin' : ''}`}
              style={{
                color:
                  node.activeTool.state === 'error'
                    ? '#ef4444'
                    : node.activeTool.state === 'complete'
                      ? '#22c55e'
                      : (node.color ?? '#66ccff'),
              }}
            />
            <span className="font-medium text-[var(--color-text)]">
              {node.activeTool.state === 'running'
                ? t('agentGraph.popover.member.activeTool.running')
                : node.activeTool.state === 'error'
                  ? t('agentGraph.popover.member.activeTool.failed')
                  : t('agentGraph.popover.member.activeTool.finished')}
            </span>
          </div>
          <div className="mt-1 font-mono text-[var(--color-text-muted)]">
            {node.activeTool.preview
              ? `${node.activeTool.name}: ${node.activeTool.preview}`
              : node.activeTool.name}
          </div>
          {node.activeTool.resultPreview && node.activeTool.state !== 'running' && (
            <div className="mt-1 text-[var(--color-text-muted)]">
              {node.activeTool.resultPreview}
            </div>
          )}
        </div>
      )}

      {node.recentTools && node.recentTools.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] font-medium text-[var(--color-text-muted)]">
            {t('agentGraph.popover.member.recentTools')}
          </div>
          <div className="space-y-1">
            {node.recentTools.slice(0, 5).map((tool) => {
              const shortName = formatToolName(tool.name);
              const shortPreview = formatToolPreview(tool.preview);
              return (
                <div
                  key={`${tool.name}:${tool.finishedAt}:${tool.startedAt}`}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-[10px]"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: tool.state === 'error' ? '#ef4444' : '#22c55e' }}
                  />
                  <span className="font-mono font-medium text-[var(--color-text)]">
                    {shortName}
                  </span>
                  {shortPreview && (
                    <span className="truncate text-[var(--color-text-muted)]">{shortPreview}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => {
            onSendMessage?.(memberName);
            onClose();
          }}
        >
          <MessageSquare size={12} /> {t('agentGraph.popover.member.actions.message')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => {
            onOpenProfile?.(memberName);
            onClose();
          }}
        >
          <User size={12} /> {t('agentGraph.popover.member.actions.profile')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => {
            onCreateTask?.(memberName);
            onClose();
          }}
        >
          <Plus size={12} /> {t('agentGraph.popover.member.actions.task')}
        </Button>
      </div>
    </div>
  );
};
