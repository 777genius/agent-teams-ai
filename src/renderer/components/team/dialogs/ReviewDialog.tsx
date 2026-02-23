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
import { Textarea } from '@renderer/components/ui/textarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';

interface ReviewDialogProps {
  open: boolean;
  teamName: string;
  taskId: string | null;
  onCancel: () => void;
  onSubmit: (comment?: string) => void;
}

export const ReviewDialog = ({
  open,
  teamName,
  taskId,
  onCancel,
  onSubmit,
}: ReviewDialogProps): React.JSX.Element => {
  const draft = useDraftPersistence({
    key: `requestChanges:${teamName}:${taskId ?? ''}`,
    enabled: Boolean(teamName && taskId),
  });

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
          <Label htmlFor="review-comment">Comment (optional)</Label>
          <Textarea
            id="review-comment"
            className="min-h-[110px] text-xs"
            value={draft.value}
            placeholder="Describe what needs to change..."
            onChange={(event) => draft.setValue(event.target.value)}
          />
          {draft.isSaved ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
          ) : null}
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
