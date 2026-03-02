import React, { useEffect, useMemo, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useStore } from '@renderer/store';
import { chipToken, serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { X } from 'lucide-react';

import { MemberBadge } from '../MemberBadge';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember, SendMessageResult } from '@shared/types';

interface QuotedMessage {
  from: string;
  text: string;
}

interface SendMessageDialogProps {
  open: boolean;
  members: ResolvedTeamMember[];
  defaultRecipient?: string;
  /** Pre-filled message text (e.g. from editor selection action) */
  defaultText?: string;
  /** Pre-filled inline code chip (from editor selection action) */
  defaultChip?: InlineChip;
  quotedMessage?: QuotedMessage;
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
  defaultText,
  defaultChip,
  quotedMessage,
  sending,
  sendError,
  lastResult,
  onSend,
  onClose,
}: SendMessageDialogProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const [quote, setQuote] = useState<QuotedMessage | undefined>(undefined);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [member, setMember] = useState('');
  const textDraft = useDraftPersistence({ key: 'sendMessage:text' });
  const chipDraft = useChipDraftPersistence('sendMessage:chips');
  const [summary, setSummary] = useState('');
  const [prevOpen, setPrevOpen] = useState(false);
  const [prevResult, setPrevResult] = useState<SendMessageResult | null>(null);

  // Reset form when dialog opens
  if (open && !prevOpen) {
    setMember(defaultRecipient ?? '');
    setSummary('');
    setQuote(quotedMessage);
    setQuoteExpanded(false);
    setPrevResult(lastResult);
    if (defaultChip) {
      const token = chipToken(defaultChip);
      textDraft.setValue(token + '\n');
      chipDraft.setChips([defaultChip]);
    } else if (defaultText) {
      textDraft.setValue(defaultText);
    }
  }
  if (open !== prevOpen) {
    setPrevOpen(open);
  }

  // Track whether auto-close is needed (setState in render phase is fine)
  const [pendingAutoClose, setPendingAutoClose] = useState(false);
  if (open && lastResult && lastResult !== prevResult) {
    setPrevResult(lastResult);
    setMember('');
    setSummary('');
    setPendingAutoClose(true);
  }

  // Side effects (onClose mutates parent state) must run in useEffect, not render phase
  useEffect(() => {
    if (pendingAutoClose) {
      textDraft.clearDraft();
      chipDraft.clearChipDraft();
      setPendingAutoClose(false);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on pendingAutoClose flag
  }, [pendingAutoClose]);

  const QUOTE_COLLAPSE_THRESHOLD = 120;
  const isQuoteLong = (quote?.text.length ?? 0) > QUOTE_COLLAPSE_THRESHOLD;

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

  const canSend =
    member.trim().length > 0 &&
    textDraft.value.trim().length > 0 &&
    summary.trim().length > 0 &&
    !sending;

  const handleChipRemove = (chipId: string): void => {
    const chip = chipDraft.chips.find((c) => c.id === chipId);
    if (chip) {
      textDraft.setValue(removeChipTokenFromText(textDraft.value, chip));
    }
    chipDraft.setChips(chipDraft.chips.filter((c) => c.id !== chipId));
  };

  const handleSubmit = (): void => {
    if (!canSend) return;
    const serialized = serializeChipsWithText(textDraft.value.trim(), chipDraft.chips);
    const finalText = quote ? buildReplyBlock(quote.from, quote.text, serialized) : serialized;
    onSend(member.trim(), finalText, summary.trim());
    textDraft.clearDraft();
    chipDraft.clearChipDraft();
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
                  const role = formatAgentRole(m.role) ?? formatAgentRole(m.agentType);
                  const resolvedColor = colorMap.get(m.name);
                  const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
                  return (
                    <SelectItem key={m.name} value={m.name}>
                      <span className="inline-flex items-center gap-1.5">
                        {memberColor ? (
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: memberColor.border }}
                          />
                        ) : null}
                        <span style={memberColor ? { color: memberColor.text } : undefined}>
                          {m.name}
                        </span>
                        {role ? (
                          <span className="text-[var(--color-text-muted)]">({role})</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="smd-message">Message</Label>
            <div className={quote ? 'flex flex-col' : 'contents'}>
              {quote ? (
                <div className="relative overflow-hidden rounded-t-md border border-b-0 border-blue-500/20 bg-blue-950/20 py-2 pl-3 pr-2">
                  {/* Decorative quotation mark */}
                  <span className="pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 select-none font-serif text-[64px] leading-none text-blue-400/[0.08]">
                    &ldquo;
                  </span>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-blue-300/40 hover:text-blue-200"
                        onClick={() => setQuote(undefined)}
                      >
                        <X size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Remove quote</TooltipContent>
                  </Tooltip>

                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] text-blue-300/60">Replying to</span>
                    <MemberBadge name={quote.from} color={colorMap.get(quote.from)} size="sm" />
                  </div>
                  <div
                    className={`pr-5 opacity-50 ${quoteExpanded ? '' : 'max-h-[3.75rem] overflow-hidden'}`}
                  >
                    <MarkdownViewer
                      content={quote.text}
                      bare
                      maxHeight={quoteExpanded ? 'max-h-48' : 'max-h-[3.75rem]'}
                    />
                  </div>
                  {isQuoteLong ? (
                    <button
                      type="button"
                      className="mt-0.5 text-[10px] text-blue-400/60 hover:text-blue-300"
                      onClick={() => setQuoteExpanded((v) => !v)}
                    >
                      {quoteExpanded ? 'less' : 'more'}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <MentionableTextarea
                id="smd-message"
                className={quote ? 'rounded-t-none' : undefined}
                placeholder="Write your message..."
                value={textDraft.value}
                onValueChange={textDraft.setValue}
                suggestions={mentionSuggestions}
                chips={chipDraft.chips}
                onChipRemove={handleChipRemove}
                projectPath={projectPath}
                onFileChipInsert={(chip) => chipDraft.setChips([...chipDraft.chips, chip])}
                minRows={4}
                maxRows={12}
                footerRight={
                  textDraft.isSaved ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
                  ) : null
                }
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="smd-summary">Summary</Label>
            <Input
              id="smd-summary"
              className="h-8 text-xs"
              placeholder="Brief summary reflecting the message intent"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Shown as notification preview. Team lead also sees this for peer messages.
            </p>
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
