import { useMemo, useState } from 'react';

import { DisplayItemList } from '@renderer/components/chat/DisplayItemList';
import { LastOutputDisplay } from '@renderer/components/chat/LastOutputDisplay';
import { SystemChatGroup } from '@renderer/components/chat/SystemChatGroup';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { enhanceAIGroup } from '@renderer/utils/aiGroupEnhancer';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import { createAgentBlockRegex, stripAgentBlocks } from '@shared/constants/agentBlocks';
import { format } from 'date-fns';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';

import type { EnhancedChunk } from '@renderer/types/data';
import type { AIGroup, UserGroup } from '@renderer/types/groups';

interface MemberExecutionLogProps {
  chunks: EnhancedChunk[];
  memberName?: string;
}

type ExpandedItemIdsByGroup = Map<string, Set<string>>;

export const MemberExecutionLog = ({
  chunks,
  memberName,
}: MemberExecutionLogProps): React.JSX.Element => {
  const conversation = useMemo(() => transformChunksToConversation(chunks, [], false), [chunks]);

  // Store collapsed groups instead of expanded: by default, everything is expanded.
  // This avoids resetting state in an effect when conversation changes.
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [expandedItemIdsByGroup, setExpandedItemIdsByGroup] = useState<ExpandedItemIdsByGroup>(
    new Map()
  );

  if (!conversation.items.length) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        Nothing to display
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 overflow-hidden">
      {conversation.items.map((item) => {
        if (item.type === 'system') {
          return <SystemChatGroup key={item.group.id} systemGroup={item.group} />;
        }
        if (item.type === 'user') {
          return <UserLogItem key={item.group.id} group={item.group} />;
        }
        if (item.type === 'ai') {
          return (
            <AIExecutionGroup
              key={item.group.id}
              group={item.group}
              memberName={memberName}
              expanded={!collapsedGroupIds.has(item.group.id)}
              expandedItemIds={expandedItemIdsByGroup.get(item.group.id) ?? new Set()}
              onToggleExpanded={() => {
                setCollapsedGroupIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.group.id)) next.delete(item.group.id);
                  else next.add(item.group.id);
                  return next;
                });
              }}
              onToggleItem={(itemId) => {
                setExpandedItemIdsByGroup((prev) => {
                  const next = new Map(prev);
                  const current = new Set(next.get(item.group.id) ?? []);
                  if (current.has(itemId)) current.delete(itemId);
                  else current.add(itemId);
                  next.set(item.group.id, current);
                  return next;
                });
              }}
            />
          );
        }
        if (item.type === 'compact') {
          // Compact boundaries are useful in full session view but noisy here
          return null;
        }
        return null;
      })}
    </div>
  );
};

/** Extract agent-only instruction blocks and human-visible text from a message. */
function splitAgentBlocks(raw: string): { humanText: string; agentInfo: string[] } {
  const agentInfo: string[] = [];
  const regex = createAgentBlockRegex();
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    const content = m[0]
      .replace(/^```info_for_agent\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
    if (content) agentInfo.push(content);
  }
  const humanText = stripAgentBlocks(raw);
  return { humanText, agentInfo };
}

const UserLogItem = ({ group }: { group: UserGroup }): React.JSX.Element => {
  const text = group.content.rawText ?? group.content.text ?? '';
  const { humanText, agentInfo } = useMemo(() => splitAgentBlocks(text), [text]);
  const [agentInfoOpen, setAgentInfoOpen] = useState(false);

  if (!humanText && agentInfo.length === 0) {
    return (
      <div className="py-1 text-[10px] text-[var(--color-text-muted)]">
        {format(group.timestamp, 'h:mm:ss a')} — (empty)
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-1 overflow-hidden py-1">
      <div className="text-[10px] text-[var(--color-text-muted)]">
        {format(group.timestamp, 'h:mm:ss a')}
      </div>
      {humanText && (
        <div className="min-w-0 overflow-x-auto break-words text-xs text-[var(--chat-user-text)]">
          <MarkdownViewer content={humanText} copyable />
        </div>
      )}
      {agentInfo.length > 0 && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setAgentInfoOpen((v) => !v)}
          >
            <ChevronRight
              size={10}
              className={`shrink-0 transition-transform ${agentInfoOpen ? 'rotate-90' : ''}`}
            />
            <Bot size={10} className="shrink-0" />
            Agent instructions
          </button>
          {agentInfoOpen && (
            <pre className="overflow-x-auto border-t border-[var(--color-border)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              {agentInfo.join('\n\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

interface AIExecutionGroupProps {
  group: AIGroup;
  memberName?: string;
  expanded: boolean;
  expandedItemIds: Set<string>;
  onToggleExpanded: () => void;
  onToggleItem: (itemId: string) => void;
}

const AIExecutionGroup = ({
  group,
  memberName,
  expanded,
  expandedItemIds,
  onToggleExpanded,
  onToggleItem,
}: AIExecutionGroupProps): React.JSX.Element => {
  const enhanced = useMemo(() => {
    if (!memberName) {
      return enhanceAIGroup(group);
    }
    const normalized = memberName.trim().toLowerCase();
    const filteredProcesses = group.processes.filter(
      (p) => p.team?.memberName?.toLowerCase() === normalized
    );
    return enhanceAIGroup({ ...group, processes: filteredProcesses });
  }, [group, memberName]);
  const hasToggleContent = enhanced.displayItems.length > 0;

  return (
    <div className="space-y-3 border-l-2 pl-3" style={{ borderColor: 'var(--chat-ai-border)' }}>
      {hasToggleContent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
            >
              <Bot className="size-4 shrink-0 text-[var(--color-text-secondary)]" />
              <span className="shrink-0 text-xs font-semibold text-[var(--color-text-secondary)]">
                Claude
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
                {enhanced.itemsSummary}
              </span>
              <ChevronDown
                className={`size-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
        </Tooltip>
      ) : null}

      {hasToggleContent && expanded ? (
        <div className="py-1 pl-2">
          <DisplayItemList
            items={enhanced.displayItems}
            order="newest-first"
            onItemClick={onToggleItem}
            expandedItemIds={expandedItemIds}
            aiGroupId={group.id}
          />
        </div>
      ) : null}

      <LastOutputDisplay lastOutput={enhanced.lastOutput} aiGroupId={group.id} />
    </div>
  );
};
