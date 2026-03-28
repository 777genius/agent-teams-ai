/**
 * GraphNodePopover — renders popover for graph nodes using project UI components.
 * Lives in features/ (not in package) so it CAN import from @renderer/.
 * Reuses agentAvatarUrl, status helpers, and UI primitives from the project.
 */

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { MessageSquare, ExternalLink, User, Plus } from 'lucide-react';

import type { GraphNode } from '@claude-teams/agent-graph';

interface GraphNodePopoverProps {
  node: GraphNode;
  onClose: () => void;
  onSendMessage?: (memberName: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (memberName: string) => void;
  onCreateTask?: (owner: string) => void;
}

export function GraphNodePopover({
  node,
  onClose,
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
  onCreateTask,
}: GraphNodePopoverProps): React.JSX.Element {
  if (node.kind === 'member' || node.kind === 'lead') {
    return (
      <MemberPopoverContent
        node={node}
        onClose={onClose}
        onSendMessage={onSendMessage}
        onOpenProfile={onOpenMemberProfile}
        onCreateTask={onCreateTask}
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
}

// ─── Member Popover ─────────────────────────────────────────────────────────

function MemberPopoverContent({
  node,
  onClose,
  onSendMessage,
  onOpenProfile,
  onCreateTask,
}: {
  node: GraphNode;
  onClose: () => void;
  onSendMessage?: (name: string) => void;
  onOpenProfile?: (name: string) => void;
  onCreateTask?: (owner: string) => void;
}): React.JSX.Element {
  const memberName = node.domainRef.kind === 'member' ? node.domainRef.memberName : 'team-lead';
  const avatarSrc = node.avatarUrl ?? agentAvatarUrl(memberName, 64);
  const statusLabel =
    node.state === 'active'
      ? 'Active'
      : node.state === 'idle'
        ? 'Idle'
        : node.state === 'terminated'
          ? 'Offline'
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
}

// ─── Task Popover ───────────────────────────────────────────────────────────

function TaskPopoverContent({
  node,
  onClose,
  onOpenDetail,
}: {
  node: GraphNode;
  onClose: () => void;
  onOpenDetail?: (taskId: string) => void;
}): React.JSX.Element {
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
}
