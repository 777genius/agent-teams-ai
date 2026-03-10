import { useMemo } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { Send } from 'lucide-react';

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

  const trimmed = draft.value.trim();
  const remaining = MAX_TEXT_LENGTH - trimmed.length;

  const handleSubmit = (): void => {
    const comment = trimmed || undefined;
    draft.clearDraft();
    onSubmit(comment);
  };

  return (
    <Dialog
      open={open && taskId !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Request Changes</DialogTitle>
          <DialogDescription>Task #{taskId ? deriveTaskDisplayId(taskId) : ''}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <MentionableTextarea
            id="review-comment"
            value={draft.value}
            onValueChange={draft.setValue}
            placeholder="Describe what needs to change... (Enter to submit)"
            suggestions={mentionSuggestions}
            projectPath={projectPath}
            onModEnter={handleSubmit}
            minRows={4}
            maxRows={12}
            maxLength={MAX_TEXT_LENGTH}
            cornerAction={
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleSubmit}
              >
                <Send size={12} />
                Submit
              </button>
            }
            footerRight={
              <div className="flex items-center gap-2">
                {remaining < 200 ? (
                  <span
                    className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                  >
                    {remaining} chars left
                  </span>
                ) : null}
                {draft.isSaved ? (
                  <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
                ) : null}
              </div>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
