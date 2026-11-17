import { useState } from 'react';

import {
  useRetainedLegacyLaunch,
  useRetainedLegacyProjectRebind,
} from '@features/agent-backend/renderer';
import { Button } from '@renderer/components/ui/button';

import { ProjectPathSelector } from './ProjectPathSelector';

import type { ComponentProps } from 'react';

type Props = ComponentProps<typeof ProjectPathSelector> & { markEdited: () => void };
const OriginalProjectSelector = (props: Props) => {
  const original = useRetainedLegacyLaunch()!;
  const rebind = useRetainedLegacyProjectRebind()!;
  const [mode, setMode] = useState(props.cwdMode);
  const [project, setProject] = useState(props.selectedProjectPath);
  const [custom, setCustom] = useState(props.customCwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = (mode === 'project' ? project : custom).trim();
  const change = async () => {
    if (busy || !path) return;
    setBusy(true);
    setError(null);
    try {
      await rebind(path, (selected) => {
        props.markEdited();
        props.onCwdModeChange(mode);
        if (mode === 'project') props.onSelectedProjectPathChange(selected);
        else props.onCustomCwdChange(selected);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Project change is unavailable.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="original-runtime-project">
      <div className="rounded-md border border-[var(--color-border)] p-3 text-xs">
        <p className="font-medium">Original runtime for this team</p>
        <p className="mt-1 break-all text-[var(--color-text-secondary)]">
          Current project: {original.choice.projectPath}
        </p>
        <p className="mt-1 text-[var(--color-text-secondary)]">
          Models, account and Launch use this runtime. The team has not been moved to Host.
        </p>
      </div>
      <fieldset disabled={busy} className="space-y-2">
        <ProjectPathSelector
          {...props}
          cwdMode={mode}
          onCwdModeChange={setMode}
          selectedProjectPath={project}
          onSelectedProjectPathChange={setProject}
          customCwd={custom}
          onCustomCwdChange={setCustom}
          customFolder={undefined}
        />
        {path !== original.choice.projectPath ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !path}
            onClick={() => void change()}
          >
            {busy ? 'Checking project…' : 'Use this project'}
          </Button>
        ) : null}
      </fieldset>
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
};
export const LaunchTeamProjectSelector = (props: Props) => {
  const original = useRetainedLegacyLaunch();
  if (original) return <OriginalProjectSelector key={original.choice.scopeId} {...props} />;
  return (
    <ProjectPathSelector
      {...props}
      onCwdModeChange={(value) => {
        props.markEdited();
        props.onCwdModeChange(value);
      }}
      onSelectedProjectPathChange={(value) => {
        props.markEdited();
        props.onSelectedProjectPathChange(value);
      }}
      onCustomCwdChange={(value) => {
        props.markEdited();
        props.onCustomCwdChange(value);
      }}
    />
  );
};
