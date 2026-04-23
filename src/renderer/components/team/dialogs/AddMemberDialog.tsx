import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getNextSuggestedMemberName } from '@renderer/components/team/members/memberNameSets';
import {
  buildMembersFromDrafts,
  createMemberDraft,
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
import { Loader2 } from 'lucide-react';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface AddMemberEntry {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
}

interface AddMemberDialogProps {
  open: boolean;
  teamName: string;
  existingNames: string[];
  onClose: () => void;
  /** Called with the list of new members to add. */
  onAdd: (members: AddMemberEntry[]) => void;
  adding?: boolean;
  /** Project path for @file mentions in workflow field. */
  projectPath?: string | null;
  /** Existing team members with their colors — used so new drafts get the next available color */
  existingMembers?: readonly {
    name: string;
    color?: string;
    isolation?: 'worktree';
    removedAt?: number | string | null;
  }[];
}

const DIALOG_WIDTH = 'w-[720px]';

function deriveExistingWorktreeDefault(
  existingMembers: AddMemberDialogProps['existingMembers']
): boolean {
  const activeTeammates =
    existingMembers?.filter(
      (member) => !member.removedAt && member.name.trim().toLowerCase() !== 'team-lead'
    ) ?? [];
  return (
    activeTeammates.length > 0 && activeTeammates.every((member) => member.isolation === 'worktree')
  );
}

function buildInitialDrafts(existingNames: string[], worktreeDefault = false): MemberDraft[] {
  const suggestedName = getNextSuggestedMemberName(existingNames);
  return [
    createMemberDraft({
      name: suggestedName,
      isolation: worktreeDefault ? 'worktree' : undefined,
    }),
  ];
}

export const AddMemberDialog = ({
  open,
  teamName,
  existingNames,
  onClose,
  onAdd,
  adding,
  projectPath,
  existingMembers,
}: AddMemberDialogProps): React.JSX.Element => {
  const existingWorktreeDefault = deriveExistingWorktreeDefault(existingMembers);
  const [teammateWorktreeDefault, setTeammateWorktreeDefault] = useState(existingWorktreeDefault);
  const [members, setMembers] = useState<MemberDraft[]>(() =>
    buildInitialDrafts(existingNames, existingWorktreeDefault)
  );
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(open);

  // Combine existing names + names already in the draft list for duplicate validation
  const allNames = useMemo(() => {
    const draftNames = members.map((m) => m.name.trim().toLowerCase()).filter(Boolean);
    return [...existingNames.map((n) => n.toLowerCase()), ...draftNames];
  }, [existingNames, members]);

  const validateName = useCallback(
    (name: string): string | null => {
      const trimmed = name.trim().toLowerCase();
      if (!trimmed) return null;

      const inlineError = validateMemberNameInline(name);
      if (inlineError) return inlineError;

      if (trimmed === 'user' || trimmed === 'team-lead') return `Name "${trimmed}" is reserved`;

      // Check against existing team members
      if (existingNames.some((n) => n.toLowerCase() === trimmed)) return 'Name is already taken';

      // Check for duplicates within the draft list
      const draftOccurrences = members.filter(
        (m) => m.name.trim().toLowerCase() === trimmed
      ).length;
      if (draftOccurrences > 1) return 'Duplicate name in the list';

      return null;
    },
    [existingNames, members]
  );

  const hasValidMembers = useMemo(() => {
    const valid = members.filter((m) => {
      const name = m.name.trim();
      return name.length > 0 && !validateName(name);
    });
    return valid.length > 0;
  }, [members, validateName]);

  const handleSubmit = (): void => {
    const built = buildMembersFromDrafts(members);
    // Validate all entries
    const invalid = built.find((m) => validateName(m.name));
    if (invalid) {
      setError(validateName(invalid.name));
      return;
    }
    if (built.length === 0) {
      setError('Add at least one member');
      return;
    }
    setError(null);
    onAdd(
      built.map((m) => ({
        name: m.name,
        role: m.role,
        workflow: m.workflow,
        isolation: m.isolation,
        providerId: m.providerId,
        model: m.model,
        effort: m.effort,
      }))
    );
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setMembers(buildInitialDrafts(existingNames, teammateWorktreeDefault));
      setError(null);
      onClose();
    }
  };

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    if (open && !wasOpen) {
      setTeammateWorktreeDefault(existingWorktreeDefault);
      setMembers(buildInitialDrafts(existingNames, existingWorktreeDefault));
      setError(null);
    }
    wasOpenRef.current = open;
  }, [existingNames, existingWorktreeDefault, open]);

  const memberCount = members.filter((m) => m.name.trim() && !validateName(m.name)).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`${DIALOG_WIDTH} max-w-[90vw]`}>
        <DialogHeader>
          <DialogTitle>Add Members</DialogTitle>
          <DialogDescription>Add new members to {teamName}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          <MembersEditorSection
            members={members}
            onChange={setMembers}
            fieldError={error ?? undefined}
            validateMemberName={validateName}
            showWorkflow
            showJsonEditor={false}
            draftKeyPrefix={`addMember:${teamName}`}
            projectPath={projectPath}
            existingMembers={existingMembers}
            showWorktreeIsolationControls
            teammateWorktreeDefault={teammateWorktreeDefault}
            onTeammateWorktreeDefaultChange={setTeammateWorktreeDefault}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={adding}>
            Cancel
          </Button>
          <Button type="button" disabled={adding || !hasValidMembers} onClick={handleSubmit}>
            {adding ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {memberCount > 1 ? `Add ${memberCount} members` : 'Add member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
