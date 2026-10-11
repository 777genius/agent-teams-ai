import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { isImeComposing } from '@renderer/utils/imeComposition';

import { append, canMoveFolder, validateName } from '../../core/domain/folders';
import { moveRequest } from '../adapters/moveRequest';
import { folderController, panelController } from '../composition';
import { folderChoices } from '../view-models/folderChoices';

import type { TaskIdentity } from '../../core/domain/folders';
import type { Projection } from '../view-models/projection';
export type FolderDialog =
  | { kind: 'create'; parent: string | null }
  | { kind: 'delete'; id: string }
  | { kind: 'reset' }
  | { kind: 'moveFolder'; id: string }
  | { kind: 'renameTask'; identity: TaskIdentity; name: string };
export const FolderDialogs = ({
  action,
  close,
  projection,
  move,
  created,
  renameTask,
}: {
  action: FolderDialog | null;
  close(): void;
  projection: Projection;
  move: TaskIdentity | null;
  created(id: string, parent: string | null): void;
  renameTask(team: string, id: string, name: string): void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const inputName = action?.kind === 'renameTask' && !edited ? action.name : name;
  const [target, setTarget] = useState('unfiled');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = !!action || !!move;
  const isMove = !!move || action?.kind === 'moveFolder';
  const title =
    action?.kind === 'create'
      ? t('taskFolders.newFolder')
      : action?.kind === 'delete'
        ? t('taskFolders.deleteFolder')
        : action?.kind === 'reset'
          ? t('taskFolders.reset')
          : action?.kind === 'renameTask'
            ? t('taskContextMenu.rename')
            : t('taskFolders.move');
  const dismiss = (): void => {
    if (busy) return;
    close();
    moveRequest.close();
    panelController.hold('dialog', false);
    setName('');
    setEdited(false);
    setError(false);
    setTarget('unfiled');
  };
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (action?.kind === 'create') {
      try {
        validateName(name);
      } catch {
        setError(true);
        return;
      }
    }
    setBusy(true);
    try {
      if (action?.kind === 'create') {
        const id = crypto.randomUUID();
        await folderController.execute({ type: 'create', id, parent: action.parent, name });
        created(id, action.parent);
      } else if (action?.kind === 'delete')
        await folderController.execute({ type: 'delete', id: action.id });
      else if (action?.kind === 'reset') await folderController.reset();
      else if (action?.kind === 'moveFolder')
        await folderController.execute({
          type: 'moveFolder',
          id: action.id,
          parent: target === 'unfiled' ? null : target,
          anchor: append,
        });
      else if (action?.kind === 'renameTask')
        renameTask(action.identity.teamName, action.identity.taskId, inputName);
      else if (move)
        await folderController.execute({
          type: 'moveTask',
          identity: move,
          parent: target === 'unfiled' ? null : target,
          anchor: append,
        });
      close();
      moveRequest.close();
      panelController.hold('dialog', false);
      setName('');
      setEdited(false);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && busy) return;
        panelController.hold('dialog', value);
        if (!value) dismiss();
      }}
    >
      <DialogContent closeDisabled={busy}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t(
            action?.kind === 'delete'
              ? 'taskFolders.deleteDescription'
              : action?.kind === 'reset'
                ? 'taskFolders.resetDescription'
                : 'taskFolders.organizationDescription'
          )}
        </DialogDescription>
        {(action?.kind === 'create' || action?.kind === 'renameTask') && (
          <Input
            autoFocus
            aria-label={t(
              action?.kind === 'renameTask' ? 'taskContextMenu.rename' : 'taskFolders.folderName'
            )}
            value={inputName}
            onChange={(e) => {
              setName(e.target.value);
              setEdited(true);
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposing(e)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        )}
        {isMove && (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger aria-label={t('taskFolders.destination')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unfiled">
                {t(action?.kind === 'moveFolder' ? 'taskFolders.root' : 'taskFolders.unfiled')}
              </SelectItem>
              {folderChoices(projection.snapshot)
                .filter(
                  (f) =>
                    action?.kind !== 'moveFolder' ||
                    canMoveFolder(projection.snapshot, action.id, f.id)
                )
                .map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {t(action?.kind === 'create' ? 'taskFolders.invalidName' : 'taskFolders.saveError')}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={dismiss}>
            {t('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
