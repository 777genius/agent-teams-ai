import { useAppTranslation } from '@features/localization/renderer';
import { severityColor } from '@renderer/utils/reportAssessments';
import { Users } from 'lucide-react';

import { ReportSection } from '../ReportSection';

import type { ReportSubagentMetrics } from '@renderer/types/sessionReport';

const fmtCost = (v: number) => `$${v.toFixed(4)}`;
const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

interface SubagentSectionProps {
  data: ReportSubagentMetrics;
  defaultCollapsed?: boolean;
}

export const SubagentSection = ({ data, defaultCollapsed }: SubagentSectionProps) => {
  const { t } = useAppTranslation('report');
  return (
    <ReportSection title={t('subagents.title')} icon={Users} defaultCollapsed={defaultCollapsed}>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-text-muted">{t('subagents.metrics.count')}</div>
          <div className="text-sm font-medium text-text">{data.count}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('subagents.metrics.totalTokens')}</div>
          <div className="text-sm font-medium text-text">{data.totalTokens.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('subagents.metrics.totalDuration')}</div>
          <div className="text-sm font-medium text-text">{fmtDuration(data.totalDurationMs)}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('subagents.metrics.totalCost')}</div>
          <div className="text-sm font-medium text-text">{fmtCost(data.totalCostUsd)}</div>
        </div>
      </div>

      {data.byAgent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="pb-2 pr-4">{t('subagents.table.description')}</th>
                <th className="pb-2 pr-4">{t('subagents.table.type')}</th>
                <th className="pb-2 pr-4 text-right">{t('subagents.table.tokens')}</th>
                <th className="pb-2 pr-4 text-right">{t('subagents.table.duration')}</th>
                <th className="pb-2 text-right">{t('subagents.table.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((agent, idx) => (
                <tr key={idx} className="border-border/50 border-b">
                  <td className="max-w-48 py-1.5 pr-4 text-text">
                    <div className="truncate" title={agent.description}>
                      {agent.description}
                    </div>
                    {agent.modelMismatch && (
                      <div
                        className="mt-0.5 truncate text-[10px]"
                        style={{ color: severityColor('warning') }}
                        title={agent.modelMismatch.recommendation}
                      >
                        {agent.modelMismatch.recommendation}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 text-text-secondary">{agent.subagentType}</td>
                  <td className="py-1.5 pr-4 text-right text-text">
                    {agent.totalTokens.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-4 text-right text-text">
                    {fmtDuration(agent.totalDurationMs)}
                  </td>
                  <td className="py-1.5 text-right text-text">{fmtCost(agent.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportSection>
  );
};
