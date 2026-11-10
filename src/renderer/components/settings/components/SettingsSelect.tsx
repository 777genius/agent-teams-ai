/**
 * SettingsSelect - Custom dropdown select component with styled dropdown menu.
 * Avoids browser default select styling for a consistent dark theme experience.
 */

import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

interface SettingsSelectProps<T extends string | number> {
  readonly value: T;
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly dropUp?: boolean;
  /** When true, trigger spans full width and dropdown aligns left */
  readonly fullWidth?: boolean;
}

export const SettingsSelect = <T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  dropUp = false,
  fullWidth = false,
}: SettingsSelectProps<T>): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find current label
  const currentLabel = options.find((opt) => opt.value === value)?.label ?? 'Select...';

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (optionValue: T): void => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex h-8 items-center justify-between gap-2 rounded-md border bg-transparent px-2 text-sm transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-zinc-700 ${fullWidth ? 'w-full' : 'min-w-[140px]'} ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${isOpen ? 'ring-1 ring-zinc-700' : ''} `}
        style={{
          color: 'var(--color-text-secondary)',
          borderColor: isOpen ? 'var(--color-border)' : 'var(--color-border-subtle)',
        }}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={`size-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: 'var(--color-text-muted)' }}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className={`absolute z-50 min-w-max overflow-hidden rounded-md border py-1 shadow-xl shadow-black/20 ${fullWidth ? 'inset-x-0' : 'right-0'} ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            borderColor: 'var(--color-border-subtle)',
          }}
        >
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                value === option.value ? 'bg-indigo-500/10 text-indigo-400' : 'hover:bg-white/5'
              } `}
              style={value !== option.value ? { color: 'var(--color-text-secondary)' } : undefined}
            >
              <span className="whitespace-nowrap">{option.label}</span>
              {value === option.value && <Check className="size-4 shrink-0 text-indigo-400" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
