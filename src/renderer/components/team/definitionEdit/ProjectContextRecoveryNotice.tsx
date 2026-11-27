import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';

import { findTeamProjectSelectionTarget } from '../teamProjectSelection';

/** A failed edit can be blocked by a different project; navigate by its verified full path. */
export const ProjectContextRecoveryNotice = ({
  teamName,
  onNavigate,
}: {
  teamName: string;
  onNavigate: () => void;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const target = useStore((state) =>
    projectPath
      ? findTeamProjectSelectionTarget(state.repositoryGroups, state.projects, projectPath) !== null
      : false
  );
  useEffect(() => {
    let current = true;
    setProjectPath(null);
    if (typeof api.teams.getProjectContextView !== 'function') return;
    void api.teams
      .getProjectContextView(teamName, null)
      .then((view) => {
        if (current && view.state === 'needs_project') {
          setProjectPath(view.recoveryProjectPath ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [teamName]);
  if (!projectPath) return null;
  return (
    <div className="space-y-2 text-xs text-text-secondary" role="status">
      <p className="break-all">
        {t('projectContextView.recoveryProject', { project: projectPath })}
      </p>
      {target && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            useStore.getState().openTeamTab(teamName, projectPath);
            onNavigate();
          }}
        >
          {t('projectContextView.openProject')}
        </Button>
      )}
    </div>
  );
};
