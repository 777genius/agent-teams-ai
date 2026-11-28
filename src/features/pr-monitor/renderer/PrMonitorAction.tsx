import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { GitPullRequest } from 'lucide-react';

export function PrMonitorAction(): React.JSX.Element | null {
  const projectId = useStore((state) => state.selectedProjectId);
  const contextId = useStore((state) => state.activeContextId);
  const [eligible, setEligible] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEligible(null);
    if (projectId && api.prMonitor)
      void api.prMonitor
        .describe({ contextId, projectId })
        .then((result) => {
          if (!cancelled && result.ok) setEligible(`${contextId}\0${projectId}`);
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [contextId, projectId]);
  if (!projectId || eligible !== `${contextId}\0${projectId}`) return null;
  const open = (): void => {
    const store = useStore.getState();
    const existing = store.openTabs.find(
      (tab) => tab.type === 'pr-monitor' && tab.projectId === projectId
    );
    if (existing) store.setActiveTab(existing.id);
    else store.openTab({ type: 'pr-monitor', projectId, label: 'Pull Requests' });
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open project pull requests" onClick={open}>
          <GitPullRequest className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Pull Requests</TooltipContent>
    </Tooltip>
  );
}
