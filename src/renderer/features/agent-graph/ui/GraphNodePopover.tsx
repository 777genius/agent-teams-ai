/**
 * GraphNodePopover — renders popover for graph nodes using project UI components.
 * Lives in features/ (not in package) so it CAN import from @renderer/.
 * Reuses agentAvatarUrl, status helpers, and UI primitives from the project.
 */

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { ExternalLink, Loader2, MessageSquare, Plus, User } from 'lucide-react';

import type { GraphNode } from '@claude-teams/agent-graph';

interface GraphNodePopoverProps {
  node: GraphNode;
  onClose: () => void;
  onSendMessage?: (memberName: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (memberName: string) => void;
  onCreateTask?: (owner: string) => void;
}

export const GraphNodePopover = ({
  node,
  onClose,
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
  onCreateTask,
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
    return <TaskPopoverContent node={node} onClose={onClose} onOpenDetail={onOpenTaskDetail} />;
  }

  // Process
  return (
    <div className="min-w-[180px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="font-mono text-xs font-bold text-[var(--color-text)]">{node.label}</div>
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
            {node.spawnStatus}
          </Badge>
        )}
      </div>

      {/* Context usage for lead */}
      {node.kind === 'lead' && node.contextUsage != null && node.contextUsage > 0 && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>Context</span>
            <span>{Math.round(node.contextUsage * 100)}%</span>
          </div>
          <div className="mt-0.5 h-1 rounded-full bg-[var(--color-border)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, node.contextUsage * 100)}%`,
                background:
                  node.contextUsage > 0.9
                    ? '#ef4444'
                    : node.contextUsage > 0.8
                      ? '#f59e0b'
                      : '#22c55e',
              }}
            />
          </div>
        </div>
      )}

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
            {node.recentTools.slice(0, 3).map((tool) => (
              <div
                key={`${tool.name}:${tool.finishedAt}:${tool.startedAt}`}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-[10px]"
              >
                <div
                  className="font-mono"
                  style={{ color: tool.state === 'error' ? '#ef4444' : '#22c55e' }}
                >
                  {tool.preview ? `${tool.name}: ${tool.preview}` : tool.name}
                </div>
                {tool.resultPreview && (
                  <div className="mt-0.5 text-[var(--color-text-muted)]">{tool.resultPreview}</div>
                )}
              </div>
            ))}
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

// ─── Task Popover ───────────────────────────────────────────────────────────

const TaskPopoverContent = ({
  node,
  onClose,
  onOpenDetail,
}: {
  node: GraphNode;
  onClose: () => void;
  onOpenDetail?: (taskId: string) => void;
}): React.JSX.Element => {
  const taskId = node.domainRef.kind === 'task' ? node.domainRef.taskId : '';

  const statusColor =
    node.taskStatus === 'in_progress'
      ? 'text-blue-400 border-blue-500/30'
      : node.taskStatus === 'completed'
        ? 'text-emerald-400 border-emerald-500/30'
        : 'text-zinc-400 border-zinc-500/30';

  const reviewColor =
    node.reviewState === 'review'
      ? 'text-amber-400 border-amber-500/30'
      : node.reviewState === 'needsFix'
        ? 'text-red-400 border-red-500/30'
        : node.reviewState === 'approved'
          ? 'text-emerald-400 border-emerald-500/30'
          : '';

  return (
    <div className="min-w-[200px] max-w-[280px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-xl">
      <div className="font-mono text-sm font-bold text-[var(--color-text)]">
        {node.displayId ?? node.label}
      </div>
      {node.sublabel && (
        <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
          {node.sublabel}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${statusColor}`}>
          {node.taskStatus ?? 'pending'}
        </Badge>
        {node.reviewState && node.reviewState !== 'none' && (
          <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${reviewColor}`}>
            {node.reviewState}
          </Badge>
        )}
        {node.needsClarification && (
          <Badge
            variant="outline"
            className="border-red-500/30 px-1.5 py-0 text-[10px] text-red-400"
          >
            needs clarification
          </Badge>
        )}
      </div>

      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => {
            onOpenDetail?.(taskId);
            onClose();
          }}
        >
          <ExternalLink size={12} /> Open task
        </Button>
      </div>
    </div>
  );
};
