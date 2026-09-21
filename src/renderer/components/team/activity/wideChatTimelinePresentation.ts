import { classifyActivityMessagePresentation } from './activityMessagePresentation';

import type { ChatAppearance } from './activityMessagePresentation';
import type { TimelineRow } from './timelineRows';

interface BuildWideChatContinuationFlagsArgs {
  appearance: ChatAppearance;
  rows: readonly TimelineRow[];
  teamName: string;
  localMemberNames?: Set<string>;
  isCollapsed: (stableKey: string, itemIndex: number) => boolean;
}

export function buildWideChatContinuationFlags({
  appearance,
  rows,
  teamName,
  localMemberNames,
  isCollapsed,
}: BuildWideChatContinuationFlagsArgs): readonly boolean[] {
  if (appearance !== 'wide-chat') return [];
  const flags = new Array<boolean>(rows.length).fill(false);
  let previous: ReturnType<typeof classifyActivityMessagePresentation> | undefined;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== 'message-row') {
      previous = undefined;
      continue;
    }
    const current = classifyActivityMessagePresentation(row.message, teamName, localMemberNames);
    const eligible =
      current.kind !== 'special' &&
      !isCollapsed(row.key, row.itemIndex) &&
      current.hasRenderableBody;
    if (!eligible) {
      previous = undefined;
      continue;
    }
    flags[index] = Boolean(
      previous?.kind === current.kind &&
      previous.author === current.author &&
      previous.route === current.route
    );
    previous = current;
  }
  return flags;
}

export function getWideChatRowStyle(
  appearance: ChatAppearance,
  flags: readonly boolean[],
  rowIndex: number
): React.CSSProperties | undefined {
  if (appearance !== 'wide-chat') return undefined;
  return {
    boxSizing: 'border-box',
    paddingInlineEnd: 40,
    paddingBlockStart: rowIndex === 0 ? 0 : flags[rowIndex] ? 4 : 12,
  };
}

export function collectScrollMarginObserverTargets(
  rootElement: HTMLElement,
  scrollElement: HTMLElement
): HTMLElement[] {
  const targets = new Set<HTMLElement>([rootElement, scrollElement]);
  let current: HTMLElement | null = rootElement;
  while (current && current !== scrollElement) {
    const parentElement: HTMLElement | null = current.parentElement;
    if (!parentElement) break;
    targets.add(parentElement);
    let previousSibling: Element | null = current.previousElementSibling;
    while (previousSibling) {
      if (previousSibling instanceof HTMLElement) targets.add(previousSibling);
      previousSibling = previousSibling.previousElementSibling;
    }
    current = parentElement;
  }
  return [...targets];
}
