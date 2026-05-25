import { useAppTranslation } from '@features/localization/renderer';
import { Lightbulb } from 'lucide-react';

import { ReportSection } from '../ReportSection';

import type {
  OutOfScopeFindings,
  ReportAgentTree,
  ReportBashCommands,
  SkillInvocation,
  SubagentBasicEntry,
  UserQuestion,
} from '@renderer/types/sessionReport';

interface InsightsSectionProps {
  skills: SkillInvocation[];
  bash: ReportBashCommands;
  lifecycleTasks: string[];
  userQuestions: UserQuestion[];
  outOfScope: OutOfScopeFindings[];
  agentTree: ReportAgentTree;
  subagentsList: SubagentBasicEntry[];
  defaultCollapsed?: boolean;
}

export const InsightsSection = ({
  skills,
  bash,
  lifecycleTasks,
  userQuestions,
  outOfScope,
  agentTree,
  subagentsList,
  defaultCollapsed,
}: InsightsSectionProps) => {
  const { t } = useAppTranslation('report');
  const agentUnit = t('insights.agent', { count: agentTree.agentCount });

  return (
    <ReportSection title={t('insights.title')} icon={Lightbulb} defaultCollapsed={defaultCollapsed}>
      {/* Skills invoked */}
      {skills.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.skillsInvoked', { count: skills.length })}
          </div>
          <div className="flex flex-col gap-1">
            {skills.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                <span className="font-mono text-text">{s.skill}</span>
                {s.argsPreview && <span className="truncate text-text-muted">{s.argsPreview}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bash commands */}
      <div className="mb-4">
        <div className="mb-2 text-xs font-medium text-text-muted">{t('insights.bashCommands')}</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-text-muted">{t('insights.total')}</div>
            <div className="text-sm font-medium text-text">{bash.total}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('insights.unique')}</div>
            <div className="text-sm font-medium text-text">{bash.unique}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted">{t('insights.repeated')}</div>
            <div className="text-sm font-medium text-text">{Object.keys(bash.repeated).length}</div>
          </div>
        </div>
        {Object.keys(bash.repeated).length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {Object.entries(bash.repeated)
              .slice(0, 10)
              .map(([cmd, count], idx) => (
                <div key={idx} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                  <span className="font-mono text-text-muted">{count}x</span>
                  <span className="truncate font-mono text-text-secondary">{cmd}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Task tool subagent list */}
      {subagentsList.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.taskDispatches', { count: subagentsList.length })}
          </div>
          <div className="flex flex-col gap-1">
            {subagentsList.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-text-muted">
                  {s.subagentType}
                </span>
                <span className="truncate text-text">{s.description}</span>
                {s.runInBackground && (
                  <span className="text-text-muted">{t('insights.background')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lifecycle tasks */}
      {lifecycleTasks.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.tasksCreated', { count: lifecycleTasks.length })}
          </div>
          <div className="flex flex-col gap-1">
            {lifecycleTasks.map((task, idx) => (
              <div key={idx} className="px-2 py-0.5 text-xs text-text-secondary">
                {task}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User questions */}
      {userQuestions.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.questionsAsked', { count: userQuestions.length })}
          </div>
          <div className="flex flex-col gap-2">
            {userQuestions.map((q, idx) => (
              <div key={idx} className="rounded-md bg-surface-raised px-3 py-2">
                <div className="text-xs text-text">{q.question}</div>
                {q.options.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {q.options.map((opt, optIdx) => (
                      <span
                        key={optIdx}
                        className="rounded px-1.5 py-0.5 text-xs text-text-muted"
                        style={{ backgroundColor: 'var(--color-surface-overlay)' }}
                      >
                        {opt}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent tree */}
      {agentTree.agentCount > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.agentTree', { count: agentTree.agentCount, unit: agentUnit })}
            {agentTree.hasTeamMode && (
              <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ color: '#60a5fa' }}>
                {t('insights.teamMode')}
              </span>
            )}
          </div>
          {agentTree.teamNames.length > 0 && (
            <div className="mb-2 text-xs text-text-muted">
              {t('insights.teams', { teams: agentTree.teamNames.join(', ') })}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {agentTree.agents.map((agent, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-text-muted">
                  {agent.agentType}
                </span>
                <span className="truncate font-mono text-text-secondary">
                  {agent.agentId.slice(0, 12)}...
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Out-of-scope findings */}
      {outOfScope.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-text-muted">
            {t('insights.outOfScopeFindings', { count: outOfScope.length })}
          </div>
          <div className="flex flex-col gap-2">
            {outOfScope.map((f, idx) => (
              <div key={idx} className="rounded-md bg-surface-raised px-3 py-2">
                <span
                  className="mr-2 rounded px-1.5 py-0.5 text-xs"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--assess-warning) 12%, transparent)',
                    color: 'var(--assess-warning)',
                  }}
                >
                  {f.keyword}
                </span>
                <span className="text-xs text-text-secondary">{f.snippet}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ReportSection>
  );
};
