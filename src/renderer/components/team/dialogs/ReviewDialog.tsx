import { useState } from 'react';

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

interface ReviewDialogProps {
  open: boolean;
  taskId: string | null;
  onCancel: () => void;
  onSubmit: (comment?: string) => void;
}

export const ReviewDialog = ({
  open,
  taskId,
  onCancel,
  onSubmit,
}: ReviewDialogProps): React.JSX.Element => {
  const [comment, setComment] = useState('');

  const handleCancel = (): void => {
    setComment('');
    onCancel();
  };

  const handleSubmit = (): void => {
    const trimmed = comment.trim() || undefined;
    setComment('');
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
            value={comment}
            placeholder="Describe what needs to change..."
            onChange={(event) => setComment(event.target.value)}
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
