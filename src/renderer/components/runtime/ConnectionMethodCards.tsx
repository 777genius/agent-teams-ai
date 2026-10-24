import { useAppTranslation } from '@features/localization/renderer';
import { Loader2 } from 'lucide-react';

import type { CliProviderAuthMode } from '@shared/types';

export type ConnectionMethodCardId = CliProviderAuthMode | 'compatible';

export interface ConnectionMethodCardOption {
  readonly id: ConnectionMethodCardId;
  readonly title: string;
  readonly description: string;
}

/** Single-select connection method cards: exactly one card is checked at a time. */
export const ConnectionMethodCards = ({
  options,
  selectedId,
  selectedIsDraft = false,
  disabled,
  connectionSaving,
  pendingConnectionAction,
  onSelect,
}: Readonly<{
  options: ConnectionMethodCardOption[];
  selectedId?: ConnectionMethodCardId;
  selectedIsDraft?: boolean;
  disabled: boolean;
  connectionSaving: boolean;
  pendingConnectionAction: string | null;
  onSelect: (id: ConnectionMethodCardId) => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const gridClassName =
    options.length === 3 ? 'grid gap-2 md:grid-cols-3' : 'grid gap-2 sm:grid-cols-2';

  return (
    <div
      role="radiogroup"
      aria-label={t('providerRuntime.connection.method')}
      className={gridClassName}
    >
      {options.map((option) => {
        const selected = selectedId === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`connection-method-${option.id}`}
            onClick={() => onSelect(option.id)}
            disabled={disabled}
            className="rounded-md border p-3 text-left transition-colors disabled:opacity-60"
            style={{
              borderColor: selected ? 'rgba(74, 222, 128, 0.32)' : 'var(--color-border-subtle)',
              backgroundColor: selected ? 'rgba(74, 222, 128, 0.08)' : 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <div
              className="flex items-center justify-between gap-2 text-sm font-medium"
              style={{ color: 'var(--color-text)' }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex size-3.5 shrink-0 items-center justify-center rounded-full border"
                  style={{
                    borderColor: selected
                      ? 'rgba(74, 222, 128, 0.6)'
                      : 'var(--color-border-subtle)',
                  }}
                >
                  {selected ? (
                    <span
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: 'rgba(74, 222, 128, 0.9)' }}
                    />
                  ) : null}
                </span>
                <span className="truncate">{option.title}</span>
              </span>
              {connectionSaving && pendingConnectionAction === option.id ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    color: 'var(--color-text-secondary)',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <Loader2 className="size-3 animate-spin" />
                  {t('providerRuntime.connection.switching')}
                </span>
              ) : selected && !selectedIsDraft ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    color: 'var(--color-positive-subtle-text)',
                    backgroundColor: 'rgba(74, 222, 128, 0.14)',
                  }}
                >
                  {t('providerRuntime.connection.selected')}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {option.description}
            </div>
          </button>
        );
      })}
    </div>
  );
};
