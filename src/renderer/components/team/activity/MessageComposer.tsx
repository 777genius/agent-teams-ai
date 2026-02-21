import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { ChevronRight, MessageSquare } from 'lucide-react';

import type { ResolvedTeamMember, SendMessageResult } from '@shared/types';

interface MessageComposerProps {
  members: ResolvedTeamMember[];
  sending: boolean;
  sendError: string | null;
  lastResult: SendMessageResult | null;
  onSend: (member: string, text: string, summary?: string) => void;
}

const NO_MEMBER = '__none__';

export const MessageComposer = ({
  members,
  sending,
  sendError,
  lastResult,
  onSend,
}: MessageComposerProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState('');
  const [text, setText] = useState('');
  const [summary, setSummary] = useState('');

  const canSend = member.trim().length > 0 && text.trim().length > 0 && !sending;

  return (
    <div className="rounded-md border border-[var(--color-border-emphasis)] bg-[var(--color-surface-sidebar)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          Send Message
        </span>
        {lastResult ? (
          <span className="text-[10px] text-green-300">
            Sent ({lastResult.messageId.slice(0, 8)}...)
          </span>
        ) : null}
        <ChevronRight
          size={14}
          className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open ? (
        <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-2">
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="mc-recipient" className="text-xs text-[var(--color-text-muted)]">
                Recipient
              </Label>
              <Select
                value={member || NO_MEMBER}
                onValueChange={(value) => setMember(value === NO_MEMBER ? '' : value)}
              >
                <SelectTrigger id="mc-recipient" className="h-8 text-xs" aria-label="Recipient">
                  <SelectValue placeholder="Select member..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MEMBER}>Select member...</SelectItem>
                  {members.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="mc-summary" className="text-xs text-[var(--color-text-muted)]">
                Summary (optional)
              </Label>
              <Input
                id="mc-summary"
                className="h-8 text-xs"
                value={summary}
                aria-label="Summary"
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="mc-message" className="text-xs text-[var(--color-text-muted)]">
                Message
              </Label>
              <Textarea
                id="mc-message"
                className="min-h-[80px] text-xs"
                value={text}
                aria-label="Message text"
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canSend}
              aria-label="Send message"
              onClick={() => {
                onSend(member.trim(), text, summary.trim() || undefined);
                setText('');
                setSummary('');
              }}
            >
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </div>

          {sendError ? <p className="mt-2 text-[10px] text-red-300">{sendError}</p> : null}
        </div>
      ) : null}
    </div>
  );
};
