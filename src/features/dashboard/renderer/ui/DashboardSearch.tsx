import { useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Search } from 'lucide-react';

import type React from 'react';

export interface DashboardSearchProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: React.Ref<HTMLInputElement>;
  placeholder: string;
  paletteLabel: string;
  paletteShortcut: string;
  onOpenPalette: () => void;
}

export function DashboardSearch({
  value,
  onChange,
  inputRef,
  placeholder,
  paletteLabel,
  paletteShortcut,
  onOpenPalette,
}: Readonly<DashboardSearchProps>): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  return (
    <div className="relative w-full">
      <div
        className={`relative flex h-14 items-center gap-3 border-b px-4 transition-colors duration-200 ${
          focused ? 'border-zinc-500' : 'border-border hover:border-zinc-600'
        }`}
      >
        <Search className="size-5 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={paletteLabel}
              onClick={onOpenPalette}
              className="shrink-0 rounded px-2 py-1 font-mono text-sm text-text-muted transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              {paletteShortcut}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{paletteLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
