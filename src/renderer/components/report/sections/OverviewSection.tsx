import { useAppTranslation } from '@features/localization/renderer';
import { assessmentColor } from '@renderer/utils/reportAssessments';
import { Activity } from 'lucide-react';

import { ReportSection } from '../ReportSection';

import type { ReportOverview } from '@renderer/types/sessionReport';

interface OverviewSectionProps {
  data: ReportOverview;
}

export const OverviewSection = ({ data }: OverviewSectionProps) => {
  const { t } = useAppTranslation('report');
  return (
    <ReportSection title={t('overview.title')} icon={Activity}>
      <div className="mb-3 truncate text-xs text-text-muted">{data.firstMessage}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.duration')}</div>
          <div className="text-sm font-medium text-text">{data.durationHuman}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.messages')}</div>
          <div className="text-sm font-medium text-text">{data.totalMessages.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.contextUsage')}</div>
          <div
            className="text-sm font-medium"
            style={{ color: assessmentColor(data.contextAssessment) }}
          >
            {data.contextConsumptionPct != null ? `${data.contextConsumptionPct}%` : 'N/A'}
            {data.contextAssessment && (
              <span className="ml-1 text-xs">({data.contextAssessment})</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.compactions')}</div>
          <div className="text-sm font-medium text-text">{data.compactionCount}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.branch')}</div>
          <div className="truncate text-sm font-medium text-text">{data.gitBranch}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.subagents')}</div>
          <div className="text-sm font-medium text-text">
            {data.hasSubagents ? t('overview.yes') : t('overview.no')}
          </div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.project')}</div>
          <div className="truncate text-sm font-medium text-text" title={data.projectPath}>
            {data.projectPath}
          </div>
        </div>
        <div>
          <div className="text-xs text-text-muted">{t('overview.metrics.sessionId')}</div>
          <div className="truncate text-sm font-medium text-text" title={data.sessionId}>
            {data.sessionId.slice(0, 12)}...
          </div>
        </div>
      </div>
    </ReportSection>
  );
};
