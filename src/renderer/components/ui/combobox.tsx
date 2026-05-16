import * as React from 'react';

import { cn } from '@renderer/lib/utils';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronsUpDown, X } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Extra data for renderOption (e.g. sessionCount, path). */
  meta?: Record<string, unknown>;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  renderOption?: (option: ComboboxOption, isSelected: boolean, query: string) => React.ReactNode;
  /** Custom label renderer for the trigger button (closed state). */
  renderTriggerLabel?: (option: ComboboxOption) => React.ReactNode;
  /** Label for the reset item shown at the top of the dropdown. */
  resetLabel?: string;
  /** Called when the user clicks the reset item. */
  onReset?: () => void;
}

export const Combobox = ({
  options,
  value,
  onValueChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  emptyMessage = 'Nothing found.',
  disabled = false,
  className,
  renderOption,
  renderTriggerLabel,
  resetLabel,
  onReset,
}: ComboboxProps): React.JSX.Element => {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const listboxId = React.useId();

  const selectedOption = options.find((opt) => opt.value === value);

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
            'flex h-8 w-full items-center justify-between rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1 text-xs shadow-sm transition-colors placeholder:text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
        >
          <span className="min-w-0 truncate text-left">
            {selectedOption
              ? (renderTriggerLabel?.(selectedOption) ?? selectedOption.label)
              : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
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
              placeholder={searchPlaceholder}
              className="flex h-8 w-full border-0 bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
          <CommandPrimitive.List
            id={listboxId}
            className="max-h-72 overflow-y-auto overscroll-contain px-2 py-1"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandPrimitive.Empty className="py-4 pr-2 text-center text-xs text-[var(--color-text-muted)]">
              {emptyMessage}
            </CommandPrimitive.Empty>
            {onReset && value && !search.trim() ? (
              <CommandPrimitive.Item
                value="__reset__"
                onSelect={() => {
                  onReset();
                  setOpen(false);
                  setSearch('');
                }}
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
              >
                <X className="mr-2 size-3.5 shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-[var(--color-text-muted)]">
                  {resetLabel ?? 'Reset selection'}
                </span>
              </CommandPrimitive.Item>
            ) : null}
            {options
              .filter((opt) => {
                if (!search.trim()) return true;
                const q = search.toLowerCase();
                return (
                  opt.label.toLowerCase().includes(q) ||
                  opt.value.toLowerCase().includes(q) ||
                  (opt.description?.toLowerCase().includes(q) ?? false)
                );
              })
              .map((option) => {
                const isSelected = option.value === value;
                return (
                  <CommandPrimitive.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    aria-disabled={option.disabled === true}
                    onSelect={() => {
                      if (option.disabled) {
                        return;
                      }
                      onValueChange(option.value);
                      setOpen(false);
                      setSearch('');
                    }}
                    className={cn(
                      'relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]',
                      option.disabled && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    {renderOption ? (
                      renderOption(option, isSelected, search)
                    ) : (
                      <>
                        {isSelected ? <Check className="mr-2 size-3.5 shrink-0" /> : null}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-[var(--color-text)]">
                            {option.label}
                          </p>
                          {option.description ? (
                            <p className="truncate text-[var(--color-text-muted)]">
                              {option.description}
                            </p>
                          ) : null}
                        </div>
                      </>
                    )}
                  </CommandPrimitive.Item>
                );
              })}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
};
