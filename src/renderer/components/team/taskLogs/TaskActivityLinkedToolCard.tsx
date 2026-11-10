import { useMemo } from 'react';

import { DisplayItemList } from '@renderer/components/chat/DisplayItemList';

import type { AIGroupDisplayItem, LinkedToolItem } from '@renderer/types/groups';

interface TaskActivityLinkedToolCardProps {
  linkedTool: LinkedToolItem;
}

export const TaskActivityLinkedToolCard = ({
  linkedTool,
}: TaskActivityLinkedToolCardProps): React.JSX.Element => {
  const items = useMemo<AIGroupDisplayItem[]>(
    () => [{ type: 'tool', tool: linkedTool }],
    [linkedTool]
  );
  const expandedItemIds = useMemo(() => new Set([`tool-${linkedTool.id}-0`]), [linkedTool.id]);

  return (
    <div className="pt-1">
      <DisplayItemList
        items={items}
        onItemClick={() => {}}
        expandedItemIds={expandedItemIds}
        aiGroupId={`task-activity:${linkedTool.id}`}
        order="chronological"
      />
    </div>
  );
};
