import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import {
  buildMembersFromDrafts,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  MembersEditorSection,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { Loader2 } from 'lucide-react';

import type { ResolvedTeamMember } from '@shared/types';

const TEAM_COLOR_NAMES = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'cyan',
  'orange',
  'pink',
] as const;

interface EditTeamDialogProps {
  open: boolean;
  teamName: string;
  currentName: string;
  currentDescription: string;
  currentColor: string;
  currentMembers: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  projectPath?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function membersToDrafts(members: ResolvedTeamMember[]) {
  return createMemberDraftsFromInputs(filterEditableMemberInputs(members));
}

export const EditTeamDialog = ({
  open,
  teamName,
  currentName,
  currentDescription,
  currentColor,
  currentMembers,
  isTeamAlive = false,
  projectPath,
  onClose,
  onSaved,
}: EditTeamDialogProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  const [color, setColor] = useState(currentColor);
  const [members, setMembers] = useState(() => membersToDrafts(currentMembers));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFileListCacheWarmer(projectPath ?? null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setDescription(currentDescription);
      setColor(currentColor);
      setMembers(membersToDrafts(currentMembers));
      setError(null);
    }
  }, [open, currentName, currentDescription, currentColor, currentMembers]);

  const handleSave = (): void => {
    if (!name.trim()) {
      setError('Team name cannot be empty');
      return;
    }
    const builtMembers = buildMembersFromDrafts(members);
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        await api.teams.updateConfig(teamName, {
          name: name.trim(),
          description: description.trim(),
          color,
        });
        await api.teams.replaceMembers(teamName, { members: builtMembers });
        onSaved();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save');
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Team</DialogTitle>
          <DialogDescription>Change team name, description and color</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="edit-team-name"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Name
            </label>
            <input
              id="edit-team-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && name.trim()) handleSave();
              }}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
              placeholder="Team name"
            />
          </div>
          <div>
            <label
              htmlFor="edit-team-description"
              className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Description
            </label>
            <textarea
              id="edit-team-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
              placeholder="Team description (optional)"
            />
          </div>
          <div>
            <MembersEditorSection
              members={members}
              onChange={setMembers}
              validateMemberName={validateMemberNameInline}
              showWorkflow
              showJsonEditor={!isTeamAlive}
              draftKeyPrefix={`editTeam:${teamName}`}
              projectPath={projectPath ?? null}
              lockProviderModel={isTeamAlive}
            />
          </div>
          {isTeamAlive ? (
            <p className="text-xs text-amber-300">
              Provider and model changes are locked while the team is live. Reconnect the team to
              change them safely.
            </p>
          ) : null}
          <div>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- Color picker is a group of buttons, not a single input */}
            <label className="label-optional mb-1 block text-xs font-medium">
              Color (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              {TEAM_COLOR_NAMES.map((colorName) => {
                const colorSet = getTeamColorSet(colorName);
                const isSelected = color === colorName;
                return (
                  <button
                    key={colorName}
                    type="button"
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full border-2 transition-all',
                      isSelected ? 'scale-110' : 'opacity-70 hover:opacity-100'
                    )}
                    style={{
                      backgroundColor: getThemedBadge(colorSet, isLight),
                      borderColor: isSelected ? colorSet.border : 'transparent',
                    }}
                    title={colorName}
                    onClick={() => setColor(isSelected ? '' : colorName)}
                  >
                    <span
                      className="size-3.5 rounded-full"
                      style={{ backgroundColor: colorSet.border }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
