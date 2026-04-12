/**
 * GraphNodePopover — renders popover for graph nodes using project UI components.
 * Lives in features/ (not in package) so it CAN import from @renderer/.
 * Reuses agentAvatarUrl, status helpers, and UI primitives from the project.
 */

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { ExternalLink, Loader2, MessageSquare, Plus, User } from 'lucide-react';

import { GraphTaskCard } from './GraphTaskCard';
import { isTaskInReviewCycle, resolveTaskReviewer } from '../utils/taskGraphSemantics';

import type { GraphNode } from '@claude-teams/agent-graph';
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
      const obj = JSON.parse(preview.length > 200 ? preview.slice(0, 200) : preview);
      // Common readable fields
      return (
        obj.subject ?? obj.name ?? obj.label ?? obj.file_path ?? obj.path ?? obj.query ?? undefined
      );
    } catch {
      // Truncated JSON — extract first quoted value
      const match = /"(?:subject|name|label|path|query)":\s*"([^"]{1,60})"/.exec(preview);
      if (match) return match[1];
    }
  }
  return preview.length > 50 ? preview.slice(0, 50) + '...' : preview;
}

function getSpawnStatusBadgeLabel(spawnStatus: GraphNode['spawnStatus']): string {
  if (spawnStatus === 'waiting' || spawnStatus === 'spawning') {
    return 'starting';
  }
  return spawnStatus ?? '';
}

interface GraphNodePopoverProps {
  node: GraphNode;
  teamName: string;
  onClose: () => void;
  onSendMessage?: (memberName: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (memberName: string) => void;
  onCreateTask?: (owner: string) => void;
  onStartTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  onApproveTask?: (taskId: string) => void;
  onRequestReview?: (taskId: string) => void;
  onRequestChanges?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onMoveBackToDone?: (taskId: string) => void;
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
  onDeleteTask,
}: GraphNodePopoverProps): React.JSX.Element => {
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
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">External team</div>
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
            Started by: <span className="text-[var(--color-text)]">{node.processRegisteredBy}</span>
          </div>
        )}
        {node.processRegisteredAt && (
          <div>At: {new Date(node.processRegisteredAt).toLocaleTimeString()}</div>
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
          <ExternalLink size={12} /> Open URL
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
  const teamData = useStore((state) => selectTeamDataForName(state, teamName));
  const tasksById = new Map((teamData?.tasks ?? []).map((task) => [task.id, task]));
  const hiddenTasks = (node.overflowTaskIds ?? [])
    .map((taskId) => tasksById.get(taskId) ?? null)
    .filter((task): task is TeamTaskWithKanban => task != null);

  return (
    <div className="min-w-[240px] max-w-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[var(--color-text)]">Hidden tasks</div>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {node.overflowCount ?? hiddenTasks.length}
        </Badge>
      </div>
      <div className="mt-2 max-h-[260px] space-y-1 overflow-y-auto pr-1">
        {hiddenTasks.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)]">No hidden tasks available.</div>
        ) : (
          hiddenTasks.map((task) => {
            const reviewer = resolveTaskReviewer(task, teamData?.kanbanState.tasks[task.id]);
            return (
              <button
                key={task.id}
                type="button"
                className="flex w-full items-start justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-2 text-left transition-colors hover:border-[var(--color-border-emphasis)]"
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
  const memberName =
    node.domainRef.kind === 'member' || node.domainRef.kind === 'lead'
      ? node.domainRef.memberName
      : 'team-lead';
  const avatarSrc = node.avatarUrl ?? agentAvatarUrl(memberName, 64);
  const statusLabel =
    node.state === 'active'
      ? 'Active'
      : node.state === 'idle'
        ? 'Idle'
        : node.state === 'terminated'
          ? 'Offline'
          : node.state === 'tool_calling'
            ? 'Running tool'
            : node.state;

  const statusDotColor =
    node.state === 'active' || node.state === 'thinking' || node.state === 'tool_calling'
      ? 'bg-emerald-400'
      : node.state === 'idle'
        ? 'bg-zinc-400'
        : node.state === 'error'
          ? 'bg-red-400'
          : 'bg-zinc-600';

  return (
    <div className="min-w-[200px] max-w-[280px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      {/* Header: avatar + name */}
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <img
            src={avatarSrc}
            alt={memberName}
            className="size-10 rounded-full border border-[var(--color-border)]"
          />
          <div
            className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-surface-raised)] ${statusDotColor}`}
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
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {statusLabel}
        </Badge>
        {node.kind === 'lead' && (
          <Badge
            variant="outline"
            className="border-blue-500/30 px-1.5 py-0 text-[10px] text-blue-400"
          >
            Lead
          </Badge>
        )}
        {node.spawnStatus && node.spawnStatus !== 'online' && (
          <Badge
            variant="outline"
            className="border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-400"
          >
            {getSpawnStatusBadgeLabel(node.spawnStatus)}
          </Badge>
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

      {/* TODO: Context usage disabled — LeadContextUsage.percent unreliable (jumps) */}

      {/* Current task indicator — reuses same pattern as MemberCard */}
      {node.currentTaskId && node.currentTaskSubject && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px]">
          <Loader2
            className="size-3 shrink-0 animate-spin"
            style={{ color: node.color ?? '#66ccff' }}
          />
          <span className="shrink-0 text-[var(--color-text-muted)]">working on</span>
          <button
            type="button"
            className="min-w-0 truncate rounded px-1.5 py-0.5 font-medium text-[var(--color-text)] transition-opacity hover:opacity-90"
            style={{ border: `1px solid ${node.color ?? '#66ccff'}40` }}
            onClick={(e) => {
              e.stopPropagation();
              onOpenTask?.(node.currentTaskId!);
              onClose();
            }}
          >
            {node.currentTaskSubject.length > 30
              ? `${node.currentTaskSubject.slice(0, 30)}…`
              : node.currentTaskSubject}
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
                ? 'Running tool'
                : node.activeTool.state === 'error'
                  ? 'Tool failed'
                  : 'Tool finished'}
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
            Recent tools
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
          <MessageSquare size={12} /> Message
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
          <User size={12} /> Profile
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
          <Plus size={12} /> Task
        </Button>
      </div>
    </div>
  );
};
