import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

interface ReviewDialogProps {
  open: boolean;
  teamName: string;
  taskId: string | null;
  members: ResolvedTeamMember[];
  onCancel: () => void;
  onSubmit: (comment?: string) => void;
}

export const ReviewDialog = ({
  open,
  teamName,
  taskId,
  members,
  onCancel,
  onSubmit,
}: ReviewDialogProps): React.JSX.Element => {
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const draft = useDraftPersistence({
    key: `requestChanges:${teamName}:${taskId ?? ''}`,
    enabled: Boolean(teamName && taskId),
  });
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );

  const handleCancel = (): void => {
    onCancel();
  };

  const handleSubmit = (): void => {
    const trimmed = draft.value.trim() || undefined;
    draft.clearDraft();
    onSubmit(trimmed);
  };

  return (
    <Dialog
      open={open && taskId !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Request Changes</DialogTitle>
          <DialogDescription>Task #{taskId}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <Label htmlFor="review-comment" className="label-optional">
            Comment (optional)
          </Label>
          <MentionableTextarea
            id="review-comment"
            className="min-h-[110px] text-xs"
            value={draft.value}
            onValueChange={draft.setValue}
            placeholder="Describe what needs to change..."
            suggestions={mentionSuggestions}
            projectPath={projectPath}
            footerRight={
              draft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
              ) : undefined
            }
          />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={handleSubmit}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
