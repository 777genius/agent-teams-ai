import { useAppTranslation } from '@features/localization/renderer';
import { severityColor } from '@renderer/utils/reportAssessments';
import { BarChart3 } from 'lucide-react';

import { AssessmentBadge } from '../AssessmentBadge';
import { ReportSection } from '../ReportSection';

import type {
  ReportFileReadRedundancy,
  ReportPromptQuality,
  ReportStartupOverhead,
  ReportTestProgression,
} from '@renderer/types/sessionReport';

interface QualitySectionProps {
  prompt: ReportPromptQuality;
  startup: ReportStartupOverhead;
  testProgression: ReportTestProgression;
  fileReadRedundancy: ReportFileReadRedundancy;
  defaultCollapsed?: boolean;
}

export const QualitySection = ({
  prompt,
  startup,
  testProgression,
  fileReadRedundancy,
  defaultCollapsed,
}: QualitySectionProps) => {
  const { t } = useAppTranslation('report');
  const snapshotUnit = t('quality.snapshot', { count: testProgression.snapshotCount });

  return (
    <ReportSection title={t('quality.title')} icon={BarChart3} defaultCollapsed={defaultCollapsed}>
      {/* Prompt quality */}
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-text-muted">{t('quality.promptQuality')}</div>
        <div className="mb-2 flex items-center gap-2">
          <AssessmentBadge assessment={prompt.assessment} metricKey="promptQuality" />
        </div>
        <div className="text-xs text-text-secondary">{prompt.note}</div>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <div className="text-xs text-text-muted">{t('quality.firstMessage')}</div>
            <div className="text-sm font-medium text-text">
              {prompt.firstMessageLengthChars.toLocaleString()} {t('quality.chars')}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.userMessages')}</div>
            <div className="text-sm font-medium text-text">{prompt.userMessageCount}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.corrections')}</div>
            <div className="text-sm font-medium text-text">{prompt.correctionCount}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.frictionRate')}</div>
            <div className="text-sm font-medium text-text">
              {(prompt.frictionRate * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      </div>

      {/* Startup overhead */}
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-text-muted">
            {t('quality.startupOverhead')}
          </span>
          <AssessmentBadge assessment={startup.overheadAssessment} metricKey="startup" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-text-muted">{t('quality.messagesBeforeWork')}</div>
            <div className="text-sm font-medium text-text">{startup.messagesBeforeFirstWork}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.tokensBeforeWork')}</div>
            <div className="text-sm font-medium text-text">
              {startup.tokensBeforeFirstWork.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.percentOfTotal')}</div>
            <div className="text-sm font-medium text-text">{startup.pctOfTotal}%</div>
          </div>
        </div>
      </div>

      {/* File read redundancy */}
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-text-muted">
            {t('quality.fileReadRedundancy')}
          </span>
          <AssessmentBadge
            assessment={fileReadRedundancy.redundancyAssessment}
            metricKey="fileReads"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-text-muted">{t('quality.totalReads')}</div>
            <div className="text-sm font-medium text-text">{fileReadRedundancy.totalReads}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.uniqueFiles')}</div>
            <div className="text-sm font-medium text-text">{fileReadRedundancy.uniqueFiles}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('quality.readsPerUniqueFile')}</div>
            <div className="text-sm font-medium text-text">
              {fileReadRedundancy.readsPerUniqueFile}x
            </div>
          </div>
        </div>
      </div>

      {/* Test progression */}
      <div>
        <div className="mb-2 text-xs font-medium text-text-muted">
          {t('quality.testProgression')}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <AssessmentBadge assessment={testProgression.trajectory} metricKey="testTrajectory" />
          <span className="text-xs text-text-muted">
            {testProgression.snapshotCount} {snapshotUnit}
          </span>
        </div>
        {testProgression.firstSnapshot && testProgression.lastSnapshot && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-text-muted">{t('quality.firstRun')}</div>
              <div className="text-sm text-text">
                <span style={{ color: severityColor('good') }}>
                  {testProgression.firstSnapshot.passed} {t('quality.passed')}
                </span>
                {' / '}
                <span style={{ color: severityColor('danger') }}>
                  {testProgression.firstSnapshot.failed} {t('quality.failed')}
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">{t('quality.lastRun')}</div>
              <div className="text-sm text-text">
                <span style={{ color: severityColor('good') }}>
                  {testProgression.lastSnapshot.passed} {t('quality.passed')}
                </span>
                {' / '}
                <span style={{ color: severityColor('danger') }}>
                  {testProgression.lastSnapshot.failed} {t('quality.failed')}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </ReportSection>
  );
};
