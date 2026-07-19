import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { ChevronRight, Users } from 'lucide-react';

import type { OrganizationMapViewModel } from '../adapters/organizationMapViewModel';
interface OrgOverviewHudProps {
  viewModel: OrganizationMapViewModel;
  onSelectNode: (nodeId: string, reveal?: boolean) => void;
}

export function OrgOverviewHud({
  viewModel,
  onSelectNode,
}: Readonly<OrgOverviewHudProps>): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const [hoveredRootNodeId, setHoveredRootNodeId] = useState<string | null>(null);
  const summaries = useMemo(
    () => viewModel.organizationOverviews,
    [viewModel.organizationOverviews]
  );

  if (summaries.length === 0) return null;

  return (
    <TooltipProvider delayDuration={250}>
      <div
        data-organization-overview-scroll
        className="pointer-events-auto absolute inset-0 overflow-y-auto px-4 pb-6 pt-24"
      >
        <div
          data-organization-overview-grid
          className="mx-auto grid min-h-full max-w-[750px] grid-cols-[repeat(auto-fit,minmax(238px,238px))] content-center justify-center gap-5"
        >
          {summaries.map((summary) => {
            const isDimmed = hoveredRootNodeId !== null && hoveredRootNodeId !== summary.rootNodeId;
            return (
              <article
                key={summary.organizationId}
                data-organization-overview-card={summary.organizationId}
                role="button"
                tabIndex={0}
                className={`pointer-events-auto relative w-[238px] cursor-pointer overflow-hidden rounded-xl border bg-[rgba(7,14,29,0.97)] shadow-2xl shadow-black/35 backdrop-blur-xl transition-[opacity,transform,filter] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 ${
                  isDimmed ? 'opacity-60 saturate-50' : 'opacity-100 hover:scale-[1.015]'
                }`}
                style={{
                  borderColor: `${summary.color}66`,
                  boxShadow: `0 18px 50px rgba(0,0,0,.34), inset 3px 0 0 ${summary.color}`,
                }}
                onMouseEnter={() => setHoveredRootNodeId(summary.rootNodeId)}
                onMouseLeave={() => setHoveredRootNodeId(null)}
                onClick={() => onSelectNode(summary.rootNodeId, true)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === 'Enter' || event.key === ' ')
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectNode(summary.rootNodeId, true);
                  }
                }}
              >
                <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-4 pb-2.5 pt-3">
                  <div className="min-w-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <h3 className="truncate text-sm font-semibold text-slate-50">
                          {summary.name}
                        </h3>
                      </TooltipTrigger>
                      <TooltipContent side="top">{summary.name}</TooltipContent>
                    </Tooltip>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {t('organizations.graph.overviewCard.summary', {
                        groupCount: summary.groupCount,
                        teamCount: summary.teamCount,
                        agentCount: summary.agentCount,
                      })}
                    </p>
                  </div>
                  <ChevronRight size={15} className="mt-0.5 shrink-0 text-sky-200/70" />
                </header>
                <div className="px-4 py-2.5">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-medium text-emerald-300">
                      {t('organizations.graph.overviewCard.activeTasks', {
                        count: summary.activeTaskCount,
                      })}
                    </span>
                    <span
                      className={summary.attentionCount > 0 ? 'text-amber-300' : 'text-slate-400'}
                    >
                      {t('organizations.graph.overviewCard.attention', {
                        count: summary.attentionCount,
                      })}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${summary.healthPercent}%`, backgroundColor: summary.color }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[9px] text-slate-500">
                    <span>
                      {t('organizations.graph.overviewCard.teamsOnline', {
                        onlineCount: summary.onlineTeamCount,
                        teamCount: summary.teamCount,
                      })}
                    </span>
                    <span>{summary.healthPercent}%</span>
                  </div>
                  <div className="mt-2 flex min-h-5 flex-wrap gap-1">
                    {summary.largestGroups.map((group) => (
                      <Tooltip key={group.nodeId}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex max-w-[98px] items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.035] px-1.5 py-0.5 text-[9px] text-slate-300 transition-colors hover:border-sky-300/30 hover:bg-sky-400/10"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectNode(group.nodeId, true);
                            }}
                          >
                            <Users size={9} className="shrink-0 text-sky-300/70" />
                            <span className="truncate">{group.label}</span>
                            <span className="text-slate-500">{group.teamCount}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">{group.label}</TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
