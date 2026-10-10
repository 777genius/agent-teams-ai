import { useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { cn } from '@renderer/lib/utils';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface ComposerRecipientOption {
  name: string;
  color?: string;
  avatarUrl?: string;
  role?: string;
  isLead?: boolean;
  draftPreview?: string;
}

export interface MessageComposerRecipientSelectorProps {
  members: ComposerRecipientOption[];
  selectedName: string | null;
  allLabel: string;
  allColor?: string;
  allDraftPreview?: string;
  disabled?: boolean;
  crossTeam?: boolean;
  onSelect: (name: string | null) => void;
}

/** Shared recipient presentation; the conversation owns routing and draft selection. */
export function MessageComposerRecipientSelector({
  members,
  selectedName,
  allLabel,
  allColor,
  allDraftPreview,
  disabled,
  crossTeam,
  onSelect,
}: MessageComposerRecipientSelectorProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = members.find((member) => member.name === selectedName);
  const select = (name: string | null) => {
    if (disabled) return;
    onSelect(name);
    setOpen(false);
    setSearch('');
  };
  const preview = (text?: string, indent = false) =>
    text ? (
      <span
        className={cn(
          'block truncate text-[10px] text-[var(--color-text-secondary)]',
          indent && 'pl-5'
        )}
      >
        <span className="font-medium text-blue-400">{t('messages.chats.draft')}:</span> {text}
      </span>
    ) : null;
  const query = search.toLowerCase().trim();
  const filtered = members
    .filter((member) => !query || member.name.toLowerCase().includes(query))
    .sort((a, b) => Number(!!b.isLead) - Number(!!a.isLead));
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('messageComposer.recipient.select')}
          className={cn(
            'message-composer-recipient-selector inline-flex min-w-0 items-center justify-end gap-1 overflow-hidden whitespace-nowrap pl-2 pr-1 text-xs transition-colors disabled:opacity-50',
            crossTeam
              ? 'hover:bg-[var(--cross-team-bg)]/80 bg-[var(--cross-team-bg)]'
              : 'hover:bg-white/[0.025]'
          )}
        >
          {selectedName !== null ? (
            <MemberBadge
              name={selectedName}
              color={selected?.color}
              size="sm"
              avatarUrl={selected?.avatarUrl}
              hideAvatar={selectedName === 'user'}
              disableHoverCard
              variant="text"
            />
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]">
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: allColor }}
              />
              {allLabel}
            </span>
          )}
          <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          setSearch('');
          setTimeout(() => searchRef.current?.focus(), 0);
        }}
      >
        {members.length > 5 ? (
          <div className="relative mb-1">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              ref={searchRef}
              type="text"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-6 pr-2 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
              placeholder={t('messageComposer.recipient.searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        ) : null}
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
              selectedName === null && 'bg-[var(--color-surface-raised)]'
            )}
            onClick={() => select(null)}
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: allColor }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[var(--color-text)]">{allLabel}</span>
              {preview(allDraftPreview)}
            </span>
            {selectedName === null ? (
              <Check size={12} className="ml-auto shrink-0 text-blue-400" />
            ) : null}
          </button>
          <div className="my-1 h-px bg-[var(--color-border)]" />
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">
              {t('messageComposer.recipient.noResults')}
            </div>
          ) : (
            filtered.map((member) => (
              <button
                key={member.name}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                  member.name === selectedName && 'bg-[var(--color-surface-raised)]'
                )}
                onClick={() => select(member.name)}
              >
                <span className="min-w-0 flex-1">
                  <MemberBadge
                    name={member.name}
                    color={member.color}
                    size="sm"
                    avatarUrl={member.avatarUrl}
                    hideAvatar={member.name === 'user'}
                    disableHoverCard
                  />
                  {preview(member.draftPreview, true)}
                </span>
                {member.role ? (
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                    {member.role}
                  </span>
                ) : null}
                {member.name === selectedName ? (
                  <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
