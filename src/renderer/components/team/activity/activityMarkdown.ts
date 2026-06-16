import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import { linkifyTaskIdsInMarkdown } from '@renderer/utils/taskReferenceUtils';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { stripTeammateMessageBlocks } from '@shared/utils/inboxNoise';

import {
  encodeCacheParts,
  getCachedString,
  stringArrayCacheSignature,
  stringMapCacheSignature,
  taskRefsCacheSignature,
} from './activityRenderCache';

import type { InboxMessage } from '@shared/types';

interface ThoughtDisplayContentOptions {
  preserveLineBreaks?: boolean;
  stripAgentOnlyBlocks?: boolean;
}

const EMPTY_MEMBER_COLOR_MAP = new Map<string, string>();
const thoughtDisplayContentCache = new Map<string, string>();

export function buildThoughtDisplayContent(
  thought: Pick<InboxMessage, 'text' | 'taskRefs'>,
  memberColorMap?: ReadonlyMap<string, string>,
  teamNames: string[] = [],
  options: ThoughtDisplayContentOptions = {}
): string {
  const { preserveLineBreaks = true, stripAgentOnlyBlocks = false } = options;
  const cacheKey = encodeCacheParts([
    thought.text,
    taskRefsCacheSignature(thought.taskRefs),
    stringMapCacheSignature(memberColorMap),
    stringArrayCacheSignature(teamNames),
    preserveLineBreaks ? '1' : '0',
    stripAgentOnlyBlocks ? '1' : '0',
  ]);

  return getCachedString(thoughtDisplayContentCache, cacheKey, () => {
    let text = stripTeammateMessageBlocks(thought.text);
    if (stripAgentOnlyBlocks) {
      text = stripAgentBlocks(text);
    }
    if (preserveLineBreaks) {
      text = text.replace(/\n/g, '  \n');
    }
    text = linkifyTaskIdsInMarkdown(text, thought.taskRefs);
    if ((memberColorMap && memberColorMap.size > 0) || teamNames.length > 0) {
      text = linkifyAllMentionsInMarkdown(
        text,
        (memberColorMap ?? EMPTY_MEMBER_COLOR_MAP) as Map<string, string>,
        teamNames
      );
    }
    return text;
  });
}
