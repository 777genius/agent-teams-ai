import { FolderOpen, Globe2 } from 'lucide-react';

import type { RuntimeLocalProviderScopeDto } from '../../contracts';
import type { JSX } from 'react';

interface LocalProviderScopeSelectorProps {
  readonly value: RuntimeLocalProviderScopeDto;
  readonly disabled?: boolean;
  readonly onChange: (scope: RuntimeLocalProviderScopeDto) => void;
}

/** Selects whether a local provider is written to global or project OpenCode config. */
export const LocalProviderScopeSelector = ({
  value,
  disabled = false,
  onChange,
}: LocalProviderScopeSelectorProps): JSX.Element => {
  return (
    <div
      role="radiogroup"
      aria-label="Available for"
      className="inline-grid grid-cols-2 gap-1 justify-self-start rounded-xl bg-white/[0.035] p-1 ring-1 ring-inset ring-white/[0.08]"
    >
      {(
        [
          { value: 'global', label: 'All projects', icon: Globe2 },
          { value: 'project', label: 'Select project', icon: FolderOpen },
        ] as const
      ).map((option) => {
        const active = value === option.value;
        const OptionIcon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-all ${
              active
                ? 'bg-gradient-to-r from-indigo-400/20 to-sky-400/10 text-indigo-100 shadow-[0_4px_14px_rgba(79,70,229,0.12)] ring-1 ring-inset ring-indigo-300/15'
                : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text-secondary)]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={() => onChange(option.value)}
          >
            <OptionIcon className="size-3.5" aria-hidden="true" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
