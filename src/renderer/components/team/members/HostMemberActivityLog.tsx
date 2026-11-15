import { useLayoutEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { BaseItem } from '@renderer/components/chat/items/BaseItem';
import {
  formatToolOutputForDisplay,
  renderInput,
  renderOutput,
} from '@renderer/components/chat/items/linkedTool/renderHelpers';
import { highlightQueryInText } from '@renderer/components/chat/searchHighlightUtils';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { Brain, Info, MessageSquare, Users, Wrench } from 'lucide-react';

import { DEFAULT_CLAUDE_LOGS_FILTER } from '../claudeLogsFilterState';

import type { ClaudeLogsFilterState } from '../claudeLogsFilterState';
import type { ClaudeLogsViewerState } from '../CliLogsRichView';
import type { HostActivityFact, HostMemberActivityLog as Log } from '@shared/types/teamActivity';
import type { UIEvent } from 'react';

export interface HostLogViewOptions {
  searchQuery: string;
  filter: ClaudeLogsFilterState;
  viewerState: ClaudeLogsViewerState;
  onViewerStateChange(state: ClaudeLogsViewerState): void;
  maxHeight?: number;
}

/** Reuses the existing Logs viewport address across reads and fullscreen remounts. */
export function useHostLogViewport(view: HostLogViewOptions | undefined, logs: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current,
      viewport = view?.viewerState.viewport;
    if (!element || !viewport) return;
    if (viewport.mode === 'edge') {
      element.scrollTop = viewport.edge === 'newest' ? 0 : element.scrollHeight;
      return;
    }
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-host-log-anchor]')].find(
      (item) => item.dataset.hostLogAnchor === viewport.anchorId
    );
    if (anchor)
      element.scrollTop +=
        anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        viewport.offsetTop;
  }, [logs, view?.viewerState]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!view) return;
    const element = event.currentTarget;
    let viewport: ClaudeLogsViewerState['viewport'];
    if (element.scrollTop <= 8) viewport = { mode: 'edge', edge: 'newest' };
    else if (element.scrollHeight - element.clientHeight - element.scrollTop <= 8)
      viewport = { mode: 'edge', edge: 'oldest' };
    else {
      const top = element.getBoundingClientRect().top;
      const anchor = [...element.querySelectorAll<HTMLElement>('[data-host-log-anchor]')].find(
        (item) => item.getBoundingClientRect().bottom > top
      );
      if (!anchor?.dataset.hostLogAnchor) return;
      viewport = {
        mode: 'anchor',
        anchorId: anchor.dataset.hostLogAnchor,
        offsetTop: anchor.getBoundingClientRect().top - top,
      };
    }
    if (JSON.stringify(viewport) !== JSON.stringify(view.viewerState.viewport))
      view.onViewerStateChange({ ...view.viewerState, viewport });
  };
  return { ref, onScroll };
}

const contentOf = (event: HostActivityFact) =>
  event.data.kind === 'subagent' && event.data.fact ? event.data.fact : event.data;
const childKey = (event: HostActivityFact): string | null =>
  event.data.kind === 'subagent'
    ? JSON.stringify([
        event.inputId ?? null,
        event.data.childId ?? event.eventId,
        event.data.parentToolRef ?? null,
      ])
    : null;
const factKey = (event: HostActivityFact): string => {
  const data = contentOf(event),
    scope = [event.inputId ?? null, childKey(event), data.kind];
  if (data.kind === 'text' || data.kind === 'thinking')
    return JSON.stringify([...scope, data.messageRef, data.block]);
  if (data.kind === 'tool' || data.kind === 'tool-result')
    return JSON.stringify([...scope, data.toolRef]);
  if (data.kind === 'usage') return JSON.stringify(scope);
  return event.eventId;
};
function latestFacts(events: HostActivityFact[]): HostActivityFact[] {
  const latest = new Map<string, HostActivityFact>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const key = factKey(event),
      data = contentOf(event);
    const previous = latest.get(key),
      old = previous && contentOf(previous);
    if (
      (data.kind === 'text' || data.kind === 'thinking') &&
      data.phase === 'snapshot' &&
      old &&
      (old.kind === 'text' || old.kind === 'thinking') &&
      old.phase === 'complete'
    )
      continue;
    latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => b.sequence - a.sequence);
}
const toolKey = (event: HostActivityFact, toolRef: string) =>
  JSON.stringify([event.inputId ?? null, childKey(event), toolRef]);
const gapReason = (event: HostActivityFact): string | null => {
  const data = contentOf(event);
  return data.kind === 'gap'
    ? data.reason
    : data.kind === 'subagent' && data.phase === 'gap'
      ? (data.reason ?? 'unattributed')
      : null;
};
const toggle = (values: Set<string>, key: string): Set<string> => {
  const next = new Set(values);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export const HostMemberActivityLog = ({
  log,
  expanded,
  onToggle,
  view,
}: {
  log: Log;
  expanded: boolean;
  onToggle(): void;
  view?: HostLogViewOptions;
}) => {
  const { t } = useAppTranslation('common');
  const { t: teamText } = useAppTranslation('team');
  const [localView, setLocalView] = useState<ClaudeLogsViewerState>(() => ({
    collapsedGroupIds: new Set(),
    expandedItemIds: new Set(),
    expandedSubagentIds: new Set(),
    viewport: { mode: 'edge', edge: 'newest' },
  }));
  const state = view?.viewerState ?? localView;
  const change = view?.onViewerStateChange ?? setLocalView;
  const groupId = JSON.stringify(['host', log.sessionId]);
  const open = view ? !state.collapsedGroupIds.has(groupId) : expanded;
  const query = view?.searchQuery.trim() ?? '';
  const normalizedQuery = query.toLowerCase();
  const filter = view?.filter ?? DEFAULT_CLAUDE_LOGS_FILTER;
  const facts = latestFacts(log.events);
  const gaps = [
    ...new Set([
      ...log.gaps,
      ...facts.flatMap((event) => {
        const reason = gapReason(event);
        return reason ? [reason] : [];
      }),
    ]),
  ];
  const toolNames = new Map<string, string>();
  for (const event of facts) {
    const data = contentOf(event);
    if (data.kind === 'tool') toolNames.set(toolKey(event, data.toolRef), data.name);
  }
  const textOf = (event: HostActivityFact): string => {
    const data = contentOf(event);
    if (data.kind === 'text' || data.kind === 'thinking' || data.kind === 'process-output')
      return data.text;
    if (data.kind === 'tool') return data.name + ' ' + JSON.stringify(data.input);
    if (data.kind === 'tool-result')
      return (
        (toolNames.get(toolKey(event, data.toolRef)) ?? data.toolRef) +
        ' ' +
        (typeof data.content === 'string' ? data.content : JSON.stringify(data.content))
      );
    return JSON.stringify(data);
  };
  const visible = facts.filter((event) => {
    if (gapReason(event)) return true;
    const data = contentOf(event);
    const kind =
      data.kind === 'thinking'
        ? 'thinking'
        : data.kind === 'tool' || data.kind === 'tool-result'
          ? 'tool'
          : 'output';
    // SDK/HTTP facts have no captured stream. Legacy unmarked transcript rows also
    // pass either stream selection; assigning stdout here would invent provenance.
    return (
      (data.kind !== 'process-output' || filter.streams.has(data.stream)) &&
      filter.kinds.has(kind) &&
      (!query || textOf(event).toLowerCase().includes(normalizedQuery))
    );
  });
  const children = new Map<string, HostActivityFact[]>();
  for (const event of visible) {
    const key = childKey(event);
    if (key) children.set(key, [...(children.get(key) ?? []), event]);
  }
  const renderFact = (event: HostActivityFact) => {
    const data = contentOf(event),
      key = JSON.stringify([log.sessionId, factKey(event)]);
    const text = textOf(event);
    const label =
      data.kind === 'text' || data.kind === 'process-output'
        ? 'Output'
        : data.kind === 'thinking'
          ? 'Thinking'
          : data.kind === 'tool'
            ? data.name
            : data.kind === 'tool-result'
              ? (toolNames.get(toolKey(event, data.toolRef)) ?? data.toolRef) + ' result'
              : data.kind;
    const summary = data.kind === 'tool' ? data.toolRef : text.slice(0, 120);
    const isExpanded = state.expandedItemIds.has(key);
    return (
      <div
        key={key}
        data-host-log-anchor={key}
        data-host-log-event-id={event.eventId}
        data-host-log-sequence={event.sequence}
        data-host-log-kind={data.kind}
        data-host-log-stream={data.kind === 'process-output' ? data.stream : undefined}
        data-host-log-is-error={data.kind === 'tool-result' ? data.isError : undefined}
        className="min-w-0 break-words"
      >
        <BaseItem
          icon={
            data.kind === 'thinking' ? (
              <Brain size={16} />
            ) : data.kind === 'text' || data.kind === 'process-output' ? (
              <MessageSquare size={16} />
            ) : data.kind === 'tool' || data.kind === 'tool-result' ? (
              <Wrench size={16} />
            ) : (
              <Info size={16} />
            )
          }
          label={label}
          summary={
            query ? highlightQueryInText(summary, query, key, { forceAllActive: true }) : summary
          }
          status={data.kind === 'tool-result' && data.isError ? 'error' : undefined}
          isExpanded={isExpanded}
          onClick={() => change({ ...state, expandedItemIds: toggle(state.expandedItemIds, key) })}
        >
          <div data-host-log-content>
            {data.kind === 'tool' &&
            data.input !== null &&
            typeof data.input === 'object' &&
            !Array.isArray(data.input) ? (
              <div className="max-h-96 overflow-auto rounded bg-[var(--code-bg)] p-3 font-mono text-xs">
                {renderInput(data.name, data.input, {
                  replaceAll: t('toolViewer.replaceAll'),
                  agentAction: t('toolViewer.agent.action'),
                  agentTeammate: t('toolViewer.agent.teammate'),
                  agentTeam: t('toolViewer.agent.team'),
                  agentRuntime: t('toolViewer.agent.runtime'),
                  agentType: t('toolViewer.agent.type'),
                  startupInstructionsHidden: t('toolViewer.agent.startupInstructionsHidden'),
                  noInputRecorded: t('toolViewer.noInputRecorded'),
                })}
              </div>
            ) : data.kind === 'tool-result' ? (
              renderOutput(
                formatToolOutputForDisplay(
                  toolNames.get(toolKey(event, data.toolRef)) ?? data.toolRef,
                  typeof data.content === 'string' || Array.isArray(data.content)
                    ? data.content
                    : JSON.stringify(data.content)
                )
              )
            ) : (
              <MarkdownViewer
                content={data.kind === 'tool' ? JSON.stringify(data.input, null, 2) : text}
                copyable
                maxHeight="max-h-96"
                itemId={key}
                searchQueryOverride={query}
              />
            )}
          </div>
        </BaseItem>
      </div>
    );
  };
  const renderedChildren = new Set<string>();
  return (
    <div className="rounded-md border border-[var(--color-border)] text-xs">
      <button
        type="button"
        className="w-full px-3 py-2 text-left"
        aria-expanded={open}
        onClick={
          view
            ? () =>
                change({ ...state, collapsedGroupIds: toggle(state.collapsedGroupIds, groupId) })
            : onToggle
        }
      >
        {log.memberName || 'Task'} · Captured runtime activity{' '}
        {log.generation ? '· generation ' + log.generation : ''}
        <span className="ml-2 text-[var(--color-text-muted)]">
          {log.messageCount} observed messages · timestamps unavailable
        </span>
      </button>
      {gaps.length > 0 && (
        <p role="status" className="px-3 pb-2 text-amber-500">
          Partial activity: {gaps.join('; ')}
        </p>
      )}
      {open && (
        <div className="space-y-2 border-t border-[var(--color-border)] p-3">
          {visible.map((event) => {
            const child = childKey(event);
            if (!child) return renderFact(event);
            if (renderedChildren.has(child)) return null;
            renderedChildren.add(child);
            const key = JSON.stringify([log.sessionId, 'child', child]);
            return (
              <div key={key} data-host-log-anchor={key}>
                <BaseItem
                  icon={<Users size={16} />}
                  label="Subagent"
                  summary={
                    event.data.kind === 'subagent'
                      ? (event.data.childId ?? event.data.reason ?? 'Unknown attribution')
                      : undefined
                  }
                  isExpanded={state.expandedSubagentIds.has(key)}
                  onClick={() =>
                    change({
                      ...state,
                      expandedSubagentIds: toggle(state.expandedSubagentIds, key),
                    })
                  }
                >
                  {children.get(child)!.map(renderFact)}
                </BaseItem>
              </div>
            );
          })}
          {visible.length === 0 && (
            <p>
              {log.events.length
                ? teamText('claudeLogs.noMatchingLogs')
                : 'No retained content facts are available.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
