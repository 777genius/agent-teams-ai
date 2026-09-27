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

function buildContinuationFlags(
  { appearance, rows, teamName, localMemberNames, isCollapsed }: BuildWideChatContinuationFlagsArgs,
  groupAgentsAcrossRecipients: boolean
): readonly boolean[] {
  if (appearance !== 'wide-chat') return [];
  const flags = new Array<boolean>(rows.length).fill(false);
  let previous: ReturnType<typeof classifyActivityMessagePresentation> | undefined;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === 'composer-outbox-row') {
      const current = {
        kind: 'ordinary-user' as const,
        author: 'user',
        route: '',
        hasRenderableBody: true,
      };
      flags[index] = Boolean(
        previous?.kind === current.kind &&
        previous.author === current.author &&
        previous.route === current.route
      );
      previous = current;
      continue;
    }
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
      (previous.route === current.route ||
        (groupAgentsAcrossRecipients && current.kind === 'ordinary-agent'))
    );
    previous = current;
  }
  return flags;
}

/** Header grouping keeps recipient routes distinct, so every destination remains visible. */
export function buildWideChatContinuationFlags(
  args: BuildWideChatContinuationFlagsArgs
): readonly boolean[] {
  return buildContinuationFlags(args, false);
}

/** Avatar grouping follows the sender even when consecutive messages have different recipients. */
export function buildWideChatAvatarContinuationFlags(
  args: BuildWideChatContinuationFlagsArgs
): readonly boolean[] {
  return buildContinuationFlags(args, true);
}

export function getWideChatRowStyle(
  appearance: ChatAppearance,
  flags: readonly boolean[],
  rowIndex: number
): React.CSSProperties | undefined {
  if (appearance !== 'wide-chat') return undefined;
  return {
    boxSizing: 'border-box',
    paddingInlineEnd: 0,
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
