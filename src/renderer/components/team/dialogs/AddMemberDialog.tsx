import { useCallback, useMemo, useState } from 'react';

import { RoleSelect } from '@renderer/components/team/RoleSelect';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { CUSTOM_ROLE, NO_ROLE } from '@renderer/constants/teamRoles';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { Loader2 } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

interface AddMemberDialogProps {
  open: boolean;
  teamName: string;
  existingNames: string[];
  onClose: () => void;
  onAdd: (name: string, role?: string, workflow?: string) => void;
  adding?: boolean;
  /** Project path for @file mentions in workflow field. */
  projectPath?: string | null;
  /** Existing team members for @mention suggestions. */
  existingMembers?: ResolvedTeamMember[];
}

export const AddMemberDialog = ({
  open,
  teamName,
  existingNames,
  onClose,
  onAdd,
  adding,
  projectPath,
  existingMembers = [],
}: AddMemberDialogProps): React.JSX.Element => {
  const [name, setName] = useState('');
  const [roleSelect, setRoleSelect] = useState<string>(NO_ROLE);
  const [customRole, setCustomRole] = useState('');
  const [error, setError] = useState<string | null>(null);

  const draftKey = `addMember:${teamName}:workflow`;
  const workflowDraft = useDraftPersistence({
    key: draftKey,
    enabled: open,
  });

  // Pre-warm file list cache for @file mentions
  useFileListCacheWarmer(open && projectPath ? projectPath : null);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      existingMembers
        .filter((m) => !m.removedAt)
        .map((m) => ({
          id: m.name,
          name: m.name,
          subtitle: m.role ?? undefined,
          color: m.color,
        })),
    [existingMembers]
  );

  const effectiveRole =
    roleSelect === CUSTOM_ROLE
      ? customRole.trim()
      : roleSelect === NO_ROLE
        ? undefined
        : roleSelect;

  const validate = (): string | null => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return 'Name is required';
    if (trimmed.length < 2) return 'Name must be at least 2 characters';
    if (trimmed.length > 30) return 'Name must be at most 30 characters';
    if (!NAME_REGEX.test(trimmed))
      return 'Name must be lowercase alphanumeric with hyphens (e.g. alice, dev-1)';
    if (trimmed === 'user') return 'Name "user" is reserved';
    if (trimmed === 'team-lead') return 'Name "team-lead" is reserved';
    if (existingNames.some((n) => n.toLowerCase() === trimmed)) return 'Name is already taken';
    return null;
  };

  const handleSubmit = (): void => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const wf = workflowDraft.value.trim() || undefined;
    onAdd(name.trim().toLowerCase(), effectiveRole, wf);
    // Reset form fields after successful submission
    setName('');
    setRoleSelect(NO_ROLE);
    setCustomRole('');
    workflowDraft.clearDraft();
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setName('');
      setRoleSelect(NO_ROLE);
      setCustomRole('');
      workflowDraft.setValue('');
      workflowDraft.clearDraft();
      setError(null);
      onClose();
    }
  };

  const handleWorkflowChange = useCallback(
    (v: string) => {
      workflowDraft.setValue(v);
    },
    [workflowDraft]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Member</DialogTitle>
          <DialogDescription>Add a new member to {teamName}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. alice, dev-1"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                autoFocus
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>

            <div className="space-y-2">
              <Label className="label-optional">Role (optional)</Label>
              <RoleSelect
                value={roleSelect}
                onValueChange={setRoleSelect}
                customRole={customRole}
                onCustomRoleChange={setCustomRole}
              />
            </div>

            <div className="space-y-2">
              <Label className="label-optional">Workflow (optional)</Label>
              <MentionableTextarea
                className="text-xs"
                minRows={3}
                maxRows={8}
                value={workflowDraft.value}
                onValueChange={handleWorkflowChange}
                suggestions={mentionSuggestions}
                projectPath={projectPath ?? undefined}
                placeholder="How this agent should behave, what tasks it handles..."
                footerRight={
                  workflowDraft.isSaved ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
                  ) : null
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={adding}>
              Cancel
            </Button>
            <Button type="submit" disabled={adding || !name.trim()}>
              {adding ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
