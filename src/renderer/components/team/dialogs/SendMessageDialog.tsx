import { useState } from 'react';

import { AutoResizeTextarea } from '@renderer/components/ui/auto-resize-textarea';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';

import type { ResolvedTeamMember, SendMessageResult } from '@shared/types';

interface SendMessageDialogProps {
  open: boolean;
  members: ResolvedTeamMember[];
  defaultRecipient?: string;
  sending: boolean;
  sendError: string | null;
  lastResult: SendMessageResult | null;
  onSend: (member: string, text: string, summary?: string) => void;
  onClose: () => void;
}

const NO_MEMBER = '__none__';

export const SendMessageDialog = ({
  open,
  members,
  defaultRecipient,
  sending,
  sendError,
  lastResult,
  onSend,
  onClose,
}: SendMessageDialogProps): React.JSX.Element => {
  const [member, setMember] = useState('');
  const textDraft = useDraftPersistence({ key: 'sendMessage:text' });
  const [summary, setSummary] = useState('');
  const [prevOpen, setPrevOpen] = useState(false);
  const [prevResult, setPrevResult] = useState<SendMessageResult | null>(null);

  // Reset form when dialog opens
  if (open && !prevOpen) {
    setMember(defaultRecipient ?? '');
    setSummary('');
    setPrevResult(lastResult);
  }
  if (open !== prevOpen) {
    setPrevOpen(open);
  }

  // Auto-close on successful send (lastResult changed while dialog is open)
  if (open && lastResult && lastResult !== prevResult) {
    setMember('');
    textDraft.clearDraft();
    setSummary('');
    setPrevResult(lastResult);
    onClose();
  }

  const canSend = member.trim().length > 0 && textDraft.value.trim().length > 0 && !sending;

  const handleSubmit = (): void => {
    if (!canSend) return;
    onSend(member.trim(), textDraft.value.trim(), summary.trim() || undefined);
    textDraft.clearDraft();
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Send Message</DialogTitle>
          <DialogDescription>Send a direct message to a team member.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="smd-recipient">Recipient</Label>
            <Select
              value={member || NO_MEMBER}
              onValueChange={(v) => setMember(v === NO_MEMBER ? '' : v)}
            >
              <SelectTrigger id="smd-recipient">
                <SelectValue placeholder="Select member..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_MEMBER}>Select member...</SelectItem>
                {members.map((m) => {
                  const role = formatAgentRole(m.agentType);
                  return (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}
                      {role ? ` (${role})` : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="smd-summary">Summary (optional)</Label>
            <Input
              id="smd-summary"
              placeholder="Brief description shown as preview..."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="smd-message">Message</Label>
            <AutoResizeTextarea
              id="smd-message"
              placeholder="Write your message..."
              value={textDraft.value}
              minRows={4}
              maxRows={12}
              onChange={(e) => textDraft.setValue(e.target.value)}
            />
            {textDraft.isSaved ? (
              <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
            ) : null}
          </div>

          {sendError ? <p className="text-xs text-red-400">{sendError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSend}>
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
