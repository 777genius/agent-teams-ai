import * as React from 'react';

import { cn } from '@renderer/lib/utils';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
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
            {selectedOption ? selectedOption.label : placeholder}
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
          <div className="flex items-center border-b border-[var(--color-border)] px-2">
            <CommandPrimitive.Input
              value={search}
              onValueChange={setSearch}
              placeholder={searchPlaceholder}
              className="flex h-8 w-full border-0 bg-transparent py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
          <CommandPrimitive.List
            id={listboxId}
            className="max-h-72 overflow-y-auto overscroll-contain p-1"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandPrimitive.Empty className="px-2 py-4 text-center text-xs text-[var(--color-text-muted)]">
              {emptyMessage}
            </CommandPrimitive.Empty>
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
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                      setSearch('');
                    }}
                    className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none data-[selected=true]:bg-[var(--color-surface-raised)] data-[selected=true]:text-[var(--color-text)]"
                  >
                    {renderOption ? (
                      renderOption(option, isSelected, search)
                    ) : (
                      <>
                        <Check
                          className={cn(
                            'mr-2 size-3.5 shrink-0',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
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
