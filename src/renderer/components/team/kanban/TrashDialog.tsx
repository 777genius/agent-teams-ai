import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { formatDistanceToNow } from 'date-fns';
import { RotateCcw, Trash2 } from 'lucide-react';

import type { TeamTask } from '@shared/types';

interface TrashDialogProps {
  open: boolean;
  tasks: TeamTask[];
  onClose: () => void;
  onRestore?: (taskId: string) => void;
}

export const TrashDialog = ({
  open,
  tasks,
  onClose,
  onRestore,
}: TrashDialogProps): React.JSX.Element => {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Trash2 size={14} className="text-[var(--color-text-muted)]" />
            Trash
          </DialogTitle>
        </DialogHeader>

        {tasks.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
            No deleted tasks
          </div>
        ) : (
          <TooltipProvider delayDuration={300}>
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="pb-2 pr-3 font-medium">#</th>
                    <th className="pb-2 pr-3 font-medium">Subject</th>
                    <th className="pb-2 pr-3 font-medium">Owner</th>
                    <th className="pb-2 pr-3 font-medium">Deleted</th>
                    {onRestore ? <th className="pb-2 font-medium" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr
                      key={task.id}
                      className="border-b border-[var(--color-border-subtle)] last:border-0"
                    >
                      <td className="py-2 pr-3 text-[var(--color-text-muted)]">
                        {formatTaskDisplayLabel(task)}
                      </td>
                      <td className="py-2 pr-3 text-[var(--color-text)]">{task.subject}</td>
                      <td className="py-2 pr-3 text-[var(--color-text-secondary)]">
                        {task.owner ?? 'Unassigned'}
                      </td>
                      <td className="py-2 pr-3 text-[var(--color-text-muted)]">
                        {task.deletedAt
                          ? formatDistanceToNow(new Date(task.deletedAt), { addSuffix: true })
                          : '—'}
                      </td>
                      {onRestore ? (
                        <td className="py-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-emerald-500/10 hover:text-emerald-400"
                                onClick={() => onRestore(task.id)}
                                aria-label="Restore task"
                              >
                                <RotateCcw size={12} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left">Restore</TooltipContent>
                          </Tooltip>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TooltipProvider>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
