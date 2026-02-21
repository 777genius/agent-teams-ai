import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { cn } from '@renderer/lib/utils';
import {
  getMessageTypeLabel,
  getStructuredMessageSummary,
  parseStructuredAgentMessage,
} from '@renderer/utils/agentMessageFormatting';
import { CheckCircle2, Circle, ListPlus, LogOut, Power, PowerOff } from 'lucide-react';

import type { InboxMessage } from '@shared/types';

type StructuredMessage = Record<string, unknown>;

interface ActivityItemProps {
  message: InboxMessage;
  onCreateTask?: (subject: string, description: string) => void;
}

function getStringField(obj: StructuredMessage, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function formatIdleReason(reason: string | null): string {
  if (!reason) {
    return 'idle';
  }
  return reason;
}

function isCompactStructuredDisplay(parsed: StructuredMessage): boolean {
  const type = getStringField(parsed, 'type');
  return (
    type === 'idle_notification' ||
    type === 'shutdown_response' ||
    type === 'shutdown_request' ||
    type === 'shutdown_approved' ||
    type === 'teammate_terminated' ||
    type === 'task_completed'
  );
}

function agentAvatarUrl(name: string): string {
  return `https://robohash.org/${encodeURIComponent(name)}?size=48x48`;
}

const AgentAvatar = ({ name }: { name: string }): React.JSX.Element => (
  <img
    src={agentAvatarUrl(name)}
    alt={name}
    className="size-5 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
    loading="lazy"
  />
);

const CompactStatusLine = ({
  icon,
  text,
  className,
}: {
  icon: React.ReactNode;
  text: string;
  className?: string;
}): React.JSX.Element => (
  <div className={cn('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs', className)}>
    {icon}
    <span>{text}</span>
  </div>
);

const StructuredCompactDisplay = ({
  parsed,
}: {
  parsed: StructuredMessage;
}): React.JSX.Element | null => {
  const type = getStringField(parsed, 'type');
  const from = getStringField(parsed, 'from');
  const agentName = from ?? 'agent';

  if (type === 'idle_notification') {
    const idleReason = getStringField(parsed, 'idleReason');
    return (
      <CompactStatusLine
        icon={<Circle size={12} className="text-[var(--color-text-muted)]" />}
        text={`${agentName} is idle (${formatIdleReason(idleReason)})`}
        className="bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]"
      />
    );
  }

  if (type === 'shutdown_response') {
    const approved = parsed.approve === true;
    if (approved) {
      return (
        <CompactStatusLine
          icon={<PowerOff size={12} className="text-red-400" />}
          text={`${agentName} has shut down`}
          className="bg-red-500/5 text-red-300"
        />
      );
    }
    const reason = getStringField(parsed, 'content') ?? 'declined';
    return (
      <CompactStatusLine
        icon={<Power size={12} className="text-amber-400" />}
        text={`${agentName} rejected shutdown: ${reason}`}
        className="bg-amber-500/5 text-amber-300"
      />
    );
  }

  if (type === 'shutdown_request') {
    const recipient = getStringField(parsed, 'recipient') ?? agentName;
    return (
      <CompactStatusLine
        icon={<LogOut size={12} className="text-amber-400" />}
        text={`Shutdown requested for ${recipient}`}
        className="bg-amber-500/5 text-amber-300"
      />
    );
  }

  if (type === 'shutdown_approved' || type === 'teammate_terminated') {
    return (
      <CompactStatusLine
        icon={<PowerOff size={12} className="text-red-400" />}
        text={`${agentName} ${type === 'shutdown_approved' ? 'shutdown confirmed' : 'terminated'}`}
        className="bg-red-500/5 text-red-300"
      />
    );
  }

  if (type === 'task_completed') {
    const rawTaskId = parsed.taskId;
    const taskId =
      typeof rawTaskId === 'string' || typeof rawTaskId === 'number' ? rawTaskId : null;
    const taskLabel = taskId !== null ? `task #${taskId}` : 'a task';
    return (
      <CompactStatusLine
        icon={<CheckCircle2 size={12} className="text-emerald-400" />}
        text={`${agentName} completed ${taskLabel}`}
        className="bg-emerald-500/5 text-emerald-300"
      />
    );
  }

  return null;
};

const StructuredFallbackDisplay = ({
  parsed,
  autoSummary,
}: {
  parsed: StructuredMessage;
  autoSummary: string;
}): React.JSX.Element => (
  <div className="space-y-2">
    <p className="text-xs text-[var(--color-text-secondary)]">{autoSummary}</p>
    <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
      <summary className="cursor-pointer px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
        Raw JSON
      </summary>
      <pre className="overflow-auto px-2 pb-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </details>
  </div>
);

export const ActivityItem = ({ message, onCreateTask }: ActivityItemProps): React.JSX.Element => {
  const timestamp = Number.isNaN(Date.parse(message.timestamp))
    ? message.timestamp
    : new Date(message.timestamp).toLocaleString();
  const structured = parseStructuredAgentMessage(message.text);
  const messageType =
    structured && typeof structured.type === 'string' ? getMessageTypeLabel(structured.type) : null;
  const autoSummary = structured ? getStructuredMessageSummary(structured) : null;

  const handleCreateTask = (): void => {
    const subject = message.summary || autoSummary || `Task from ${message.from}`;
    const plainText = structured ? JSON.stringify(structured, null, 2) : message.text;
    const description = `From: ${message.from}\nAt: ${timestamp}\n\n${plainText}`.slice(0, 2000);
    onCreateTask?.(subject, description);
  };

  const isCompact = structured !== null && isCompactStructuredDisplay(structured);

  if (isCompact && structured) {
    return (
      <article className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <AgentAvatar name={message.from} />
            <StructuredCompactDisplay parsed={structured} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onCreateTask && (
              <button
                type="button"
                className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] group-hover:opacity-100"
                title="Create task from message"
                onClick={handleCreateTask}
              >
                <ListPlus size={14} />
              </button>
            )}
            <p className="text-[10px] text-[var(--color-text-muted)]">{timestamp}</p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar name={message.from} />
          <p className="truncate text-xs font-medium text-[var(--color-text)]">
            {message.from}
            {message.to && message.to !== message.from ? (
              <span className="font-normal text-[var(--color-text-muted)]">
                {' → '}
                {message.to}
              </span>
            ) : null}
          </p>
          {messageType ? (
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
              {messageType}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {onCreateTask && (
            <button
              type="button"
              className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] group-hover:opacity-100"
              title="Create task from message"
              onClick={handleCreateTask}
            >
              <ListPlus size={14} />
            </button>
          )}
          <p className="text-[10px] text-[var(--color-text-muted)]">{timestamp}</p>
        </div>
      </div>
      {message.summary ? (
        <p className="mb-1 text-xs font-medium text-[var(--color-text)]">{message.summary}</p>
      ) : autoSummary && autoSummary !== messageType ? (
        <p className="mb-2 text-xs font-medium text-[var(--color-text)]">{autoSummary}</p>
      ) : null}
      {structured ? (
        <StructuredFallbackDisplay
          parsed={structured}
          autoSummary={autoSummary ?? 'Structured message'}
        />
      ) : (
        <MarkdownViewer content={message.text} maxHeight="max-h-56" copyable className="mt-2" />
      )}
    </article>
  );
};
