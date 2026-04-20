import * as React from 'react';

import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
} from '@renderer/utils/memberHelpers';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';

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
  disabled?: boolean;
  className?: string;
}

const UNASSIGNED_VALUE = '__unassigned__';

export const MemberSelect = ({
  members,
  value,
  onChange,
  placeholder = 'Select member...',
  allowUnassigned = false,
  size = 'sm',
  disabled = false,
  className,
}: MemberSelectProps): React.JSX.Element => {
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

  // eslint-disable-next-line sonarjs/function-return-type -- option renderer returns mixed node structure
  const renderMemberInline = (member: ResolvedTeamMember): React.ReactNode => {
    const resolvedColor = colorMap.get(member.name);
    const colors = getTeamColorSet(resolvedColor ?? '');
    return (
      <span className="inline-flex items-center gap-1.5">
        <img
          src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, avatarSize)}
          alt=""
          className={`${avatarClass} shrink-0 rounded-full bg-[var(--color-surface-raised)]`}
          loading="lazy"
        />
        <span
          className={`rounded px-1.5 py-0.5 ${textSize} font-medium tracking-wide`}
          style={{
            backgroundColor: getThemedBadge(colors, isLight),
            color: colors.text,
            border: `1px solid ${colors.border}40`,
          }}
        >
          {member.name === 'team-lead' ? 'lead' : member.name}
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
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          className={cn(
            `flex ${triggerHeight} w-full items-center justify-between rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs shadow-sm transition-colors placeholder:text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] disabled:cursor-not-allowed disabled:opacity-50`,
            className
          )}
        >
          <span className="min-w-0 truncate text-left">
            {selectedMember ? (
              renderMemberInline(selectedMember)
            ) : value === null && allowUnassigned ? (
              <span className="text-xs text-[var(--color-text-muted)]">Unassigned</span>
            ) : (
              <span className="text-[var(--color-text-muted)]">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[200px] p-0"
        align="start"
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
              placeholder="Search members..."
              className="flex h-8 w-full border-0 bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
          <CommandPrimitive.List
            id={listboxId}
            className="max-h-72 overflow-y-auto overscroll-contain px-2 py-1"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandPrimitive.Empty className="py-4 pr-2 text-center text-xs text-[var(--color-text-muted)]">
              No members found.
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
                <span className="text-[var(--color-text-muted)]">Unassigned</span>
                {value === null ? (
                  <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                ) : null}
              </CommandPrimitive.Item>
            ) : null}
            {members
              .filter((m) => {
                if (!search.trim()) return true;
                const q = search.toLowerCase();
                return (
                  m.name.toLowerCase().includes(q) ||
                  (m.role?.toLowerCase().includes(q) ?? false) ||
                  (m.agentType?.toLowerCase().includes(q) ?? false)
                );
              })
              .map((m) => {
                const isSelected = m.name === value;
                const resolvedColor = colorMap.get(m.name);
                const colors = getTeamColorSet(resolvedColor ?? '');
                const role = formatAgentRole(m.role) ?? formatAgentRole(m.agentType);

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
                      {m.name === 'team-lead' ? 'lead' : m.name}
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
