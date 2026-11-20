import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

import { EditTeamDialog } from '../dialogs/EditTeamDialog';

import { buildDefinitionEditorInput } from './definitionEditorInput';

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

  const load = useCallback(async (): Promise<DefinitionEditorInput> => {
    const saved = await api.teams.getSavedRequest(logicalTeamName);
    if (!saved) throw new Error(t('detail.editDefinition.notFound'));
    return buildDefinitionEditorInput(saved, logicalTeamName);
  }, [logicalTeamName, t]);

  useEffect(() => {
    let alive = true;
    void load().then(
      (next) => {
        if (alive) setInput(next);
      },
      (error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      alive = false;
    };
  }, [load]);

  if (loadError !== null) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('detail.editDefinition.loadFailed')}</DialogTitle>
            <DialogDescription>{loadError}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('detail.actions.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  if (!input) return null;

  return (
    <EditTeamDialog
      open
      teamName={logicalTeamName}
      currentName={input.currentName}
      currentDescription={input.currentDescription}
      currentColor={input.currentColor}
      currentMembers={input.currentMembers}
      leadMember={input.leadMember}
      resolvedMemberColorMap={resolvedMemberColorMap}
      isTeamAlive={false}
      isTeamProvisioning={false}
      projectPath={projectPath}
      onClose={onClose}
      onChangeLeadRuntime={onChangeLeadRuntime}
      onSaved={async () => {
        // Show the saved definition in the dialog's own baseline, then refresh the screen.
        setInput(await load());
        await onSaved();
      }}
    />
  );
};
