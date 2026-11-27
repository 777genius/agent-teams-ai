import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';

import { EditTeamDialog } from '../dialogs/EditTeamDialog';

import { buildDefinitionEditorInput } from './definitionEditorInput';
import { DefinitionLoadErrorDialog } from './DefinitionLoadErrorDialog';

import type { DefinitionEditorInput } from './definitionEditorInput';

interface Props {
  /** The per-project (logical) team: the only authority for roster and metadata. */
  logicalTeamName: string;
  resolvedMemberColorMap?: ReadonlyMap<string, string>;
  projectPath?: string | null;
  onClose: () => void;
  onChangeLeadRuntime: () => void;
  onSaved: () => Promise<void> | void;
}

/**
 * The ordinary Edit Team dialog, fed by the saved team definition instead of
 * the snapshot of one project's run, so what is edited is exactly what is saved.
 */
export const TeamDefinitionEditDialog = ({
  logicalTeamName,
  resolvedMemberColorMap,
  projectPath,
  onClose,
  onChangeLeadRuntime,
  onSaved,
}: Readonly<Props>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [input, setInput] = useState<DefinitionEditorInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isTeamAlive, setIsTeamAlive] = useState(false);

  const load = useCallback(async (): Promise<{ input: DefinitionEditorInput; alive: boolean }> => {
    const [saved, alive] = await Promise.all([
      api.teams.getSavedRequest(logicalTeamName),
      api.teams.processAlive(logicalTeamName),
    ]);
    if (!saved) throw new Error(t('detail.editDefinition.notFound'));
    return { input: buildDefinitionEditorInput(saved, logicalTeamName), alive };
  }, [logicalTeamName, t]);

  useEffect(() => {
    let alive = true;
    void load().then(
      (next) => {
        if (alive) {
          setInput(next.input);
          setIsTeamAlive(next.alive);
        }
      },
      (error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      alive = false;
    };
  }, [load]);

  if (loadError !== null)
    return <DefinitionLoadErrorDialog message={loadError} onClose={onClose} />;
  if (!input) return null;

  return (
    <EditTeamDialog
      open
      teamName={logicalTeamName}
      currentName={input.currentName}
      currentDescription={input.currentDescription}
      currentColor={input.currentColor}
      currentLeadPrompt={input.currentLeadPrompt}
      currentMembers={input.currentMembers}
      leadMember={input.leadMember}
      resolvedMemberColorMap={resolvedMemberColorMap}
      isTeamAlive={isTeamAlive}
      isTeamProvisioning={false}
      projectPath={projectPath}
      onClose={onClose}
      onChangeLeadRuntime={onChangeLeadRuntime}
      onSaved={async () => {
        // Show the saved definition in the dialog's own baseline, then refresh the screen.
        const next = await load();
        setInput(next.input);
        setIsTeamAlive(next.alive);
        await onSaved();
      }}
    />
  );
};
