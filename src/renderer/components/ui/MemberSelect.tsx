import * as React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronsUpDown, UserRound } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberSelectProps {
  members: ResolvedTeamMember[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  /** Show "Unassigned" option at the top of the list */
  allowUnassigned?: boolean;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Full select by default. Avatar mode is for dense toolbars/sidebar surfaces. */
  triggerVariant?: 'default' | 'avatar';
  popoverAlign?: 'start' | 'center' | 'end';
  disabled?: boolean;
  className?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  getMemberLabel?: (member: ResolvedTeamMember) => string;
  getMemberDescription?: (member: ResolvedTeamMember) => string | null | undefined;
  ariaLabel?: string;
}

const UNASSIGNED_VALUE = '__unassigned__';

export const MemberSelect = ({
  members,
  value,
  onChange,
  placeholder = 'Select member...',
  allowUnassigned = false,
  size = 'sm',
  triggerVariant = 'default',
  popoverAlign,
  disabled = false,
  className,
  searchPlaceholder,
  emptyMessage,
  getMemberLabel,
  getMemberDescription,
  ariaLabel,
}: MemberSelectProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const listboxId = React.useId();
  const { isLight } = useTheme();

  const colorMap = React.useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = React.useMemo(() => buildMemberAvatarMap(members), [members]);
  const selectedMember = React.useMemo(
    () => (value ? members.find((m) => m.name === value) : null),
    [members, value]
  );

  const avatarSize = size === 'md' ? 32 : 24;
  const avatarClass = size === 'md' ? 'size-6' : 'size-5';
  const textSize = size === 'md' ? 'text-xs' : 'text-[10px]';
  const triggerHeight = size === 'md' ? 'h-9' : 'h-8';
  const isAvatarTrigger = triggerVariant === 'avatar';
  const effectivePopoverAlign = popoverAlign ?? (isAvatarTrigger ? 'end' : 'start');
  const avatarTriggerSize = size === 'md' ? 'size-9' : 'size-8';
  const resolveMemberLabel = React.useCallback(
    (member: ResolvedTeamMember): string =>
      getMemberLabel?.(member) ?? (member.name === 'team-lead' ? 'lead' : member.name),
    [getMemberLabel]
  );
  const resolveMemberDescription = React.useCallback(
    (member: ResolvedTeamMember): string | null | undefined =>
      getMemberDescription?.(member) ??
      formatAgentRole(member.role) ??
      formatAgentRole(member.agentType),
    [getMemberDescription]
  );
  const selectedLabel =
    selectedMember != null
      ? resolveMemberLabel(selectedMember)
      : value
        ? displayMemberName(value)
        : allowUnassigned
          ? t('members.unassigned')
          : placeholder;
  const triggerAriaLabel =
    ariaLabel ?? (isAvatarTrigger ? `Select member: ${selectedLabel}` : undefined);

  const renderAvatarByName = (name: string): React.ReactNode => (
    <img
      src={avatarMap.get(name) ?? agentAvatarUrl(name, avatarSize)}
      alt=""
      className={`${avatarClass} shrink-0 rounded-full bg-[var(--color-surface-raised)]`}
      loading="lazy"
    />
  );
  const renderMemberAvatar = (member: ResolvedTeamMember): React.ReactNode =>
    renderAvatarByName(member.name);

  // eslint-disable-next-line sonarjs/function-return-type -- option renderer returns mixed node structure
  const renderMemberInline = (member: ResolvedTeamMember): React.ReactNode => {
    const resolvedColor = colorMap.get(member.name);
    const colors = getTeamColorSet(resolvedColor ?? '');
    const label = resolveMemberLabel(member);
    return (
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
        <img
          src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, avatarSize)}
          alt=""
          className={`${avatarClass} shrink-0 rounded-full bg-[var(--color-surface-raised)]`}
          loading="lazy"
        />
        <span
          className={`min-w-0 truncate rounded px-1.5 py-0.5 ${textSize} font-medium tracking-wide`}
          style={{
            backgroundColor: getThemedBadge(colors, isLight),
            color: colors.text,
            border: `1px solid ${colors.border}40`,
          }}
        >
          {label}
        </span>
      </span>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-label={triggerAriaLabel}
          title={isAvatarTrigger ? selectedLabel : undefined}
          disabled={disabled}
          className={cn(
            isAvatarTrigger
              ? `inline-flex ${avatarTriggerSize} shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-transparent p-0 text-xs shadow-sm transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] disabled:cursor-not-allowed disabled:opacity-50`
              : `flex ${triggerHeight} w-full items-center justify-between rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs shadow-sm transition-colors placeholder:text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] disabled:cursor-not-allowed disabled:opacity-50`,
            className
          )}
        >
          {isAvatarTrigger ? (
            selectedMember ? (
              renderMemberAvatar(selectedMember)
            ) : value ? (
              renderAvatarByName(value)
            ) : (
              <UserRound className="size-4 text-[var(--color-text-muted)]" />
            )
          ) : (
            <>
              <span className="min-w-0 truncate text-left">
                {selectedMember ? (
                  renderMemberInline(selectedMember)
                ) : value === null && allowUnassigned ? (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {t('members.unassigned')}
                  </span>
                ) : (
                  <span className="text-[var(--color-text-muted)]">{placeholder}</span>
                )}
              </span>
              <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          isAvatarTrigger ? 'w-56 p-0' : 'w-[var(--radix-popover-trigger-width)] min-w-[200px] p-0'
        )}
        align={effectivePopoverAlign}
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions
      >
        <CommandPrimitive
          className="flex size-full flex-col overflow-hidden rounded-md bg-[var(--color-surface)]"
          shouldFilter={false}
        >
          <div className="flex items-center border-b border-[var(--color-border)]">
            <CommandPrimitive.Input
              value={search}
              onValueChange={setSearch}
              placeholder={searchPlaceholder ?? t('members.searchPlaceholder')}
              className="flex h-8 w-full border-0 bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
          <CommandPrimitive.List
            id={listboxId}
            className="max-h-72 overflow-y-auto overscroll-contain px-2 py-1"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandPrimitive.Empty className="py-4 pr-2 text-center text-xs text-[var(--color-text-muted)]">
              {emptyMessage ?? t('members.emptyMessage')}
            </CommandPrimitive.Empty>
            {allowUnassigned && !search.trim() ? (
              <CommandPrimitive.Item
                value={UNASSIGNED_VALUE}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                  setSearch('');
                }}
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
              >
                <span className="text-[var(--color-text-muted)]">{t('members.unassigned')}</span>
                {value === null ? (
                  <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                ) : null}
              </CommandPrimitive.Item>
            ) : null}
            {members
              .filter((m) => {
                if (!search.trim()) return true;
                const q = search.toLowerCase();
                const label = resolveMemberLabel(m);
                const description = resolveMemberDescription(m);
                return (
                  m.name.toLowerCase().includes(q) ||
                  label.toLowerCase().includes(q) ||
                  (description?.toLowerCase().includes(q) ?? false) ||
                  (m.role?.toLowerCase().includes(q) ?? false) ||
                  (m.agentType?.toLowerCase().includes(q) ?? false)
                );
              })
              .map((m) => {
                const isSelected = m.name === value;
                const resolvedColor = colorMap.get(m.name);
                const colors = getTeamColorSet(resolvedColor ?? '');
                const label = resolveMemberLabel(m);
                const role = resolveMemberDescription(m);

                return (
                  <CommandPrimitive.Item
                    key={m.name}
                    value={m.name}
                    onSelect={() => {
                      onChange(m.name);
                      setOpen(false);
                      setSearch('');
                    }}
                    className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
                  >
                    <img
                      src={avatarMap.get(m.name) ?? agentAvatarUrl(m.name, avatarSize)}
                      alt=""
                      className={`${avatarClass} shrink-0 rounded-full bg-[var(--color-surface-raised)]`}
                      loading="lazy"
                    />
                    <span className="min-w-0 truncate font-medium" style={{ color: colors.text }}>
                      {label}
                    </span>
                    {role ? (
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {role}
                      </span>
                    ) : null}
                    {isSelected ? (
                      <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                    ) : null}
                  </CommandPrimitive.Item>
                );
              })}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
};
