import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

import type { CliProviderStatus } from '@shared/types';

interface Props {
  provider: CliProviderStatus;
  disabled?: boolean;
  onSelect: (providerId: CliProviderStatus['providerId'], backendId: string) => void;
}

export function getOptionDisplayLabel(
  option: NonNullable<CliProviderStatus['availableBackends']>[number],
  resolvedOption: NonNullable<CliProviderStatus['availableBackends']>[number] | null
): string {
  if (option.id !== 'auto') {
    return option.label;
  }

  if (resolvedOption?.label) {
    return `Auto (currently: ${resolvedOption.label})`;
  }

  return 'Auto';
}

export function getProviderRuntimeBackendSummary(provider: CliProviderStatus): string | null {
  const options = provider.availableBackends ?? [];
  if (options.length === 0) {
    return null;
  }

  const selectedBackendId = provider.selectedBackendId ?? options[0]?.id ?? '';
  const selectedOption = options.find((option) => option.id === selectedBackendId) ?? options[0];
  const resolvedOption = options.find((option) => option.id === provider.resolvedBackendId) ?? null;

  return getOptionDisplayLabel(selectedOption, resolvedOption);
}

export const ProviderRuntimeBackendSelector = ({
  provider,
  disabled = false,
  onSelect,
}: Props): React.JSX.Element | null => {
  const options = provider.availableBackends ?? [];
  if (options.length === 0) {
    return null;
  }

  const selectedBackendId = provider.selectedBackendId ?? options[0]?.id ?? '';
  const selectedOption = options.find((option) => option.id === selectedBackendId) ?? options[0];
  const resolvedOption = options.find((option) => option.id === provider.resolvedBackendId) ?? null;
  const selectedLabel = getOptionDisplayLabel(selectedOption, resolvedOption);

  return (
    <div className="mt-2 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Runtime backend
        </span>
        {provider.resolvedBackendId &&
          provider.resolvedBackendId !== provider.selectedBackendId && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px]"
              style={{
                color: 'var(--color-text-secondary)',
                backgroundColor: 'rgba(255, 255, 255, 0.04)',
              }}
            >
              Resolved: {resolvedOption?.label ?? provider.resolvedBackendId}
            </span>
          )}
      </div>
      <Select
        value={selectedBackendId}
        disabled={disabled}
        onValueChange={(backendId) => onSelect(provider.providerId, backendId)}
      >
        <SelectTrigger className="h-10 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              Current
            </span>
            <span className="truncate">{selectedLabel}</span>
          </div>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={!option.available && option.id !== selectedBackendId}
              className="py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{getOptionDisplayLabel(option, resolvedOption)}</span>
                  {option.recommended ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: '#86efac',
                        backgroundColor: 'rgba(74, 222, 128, 0.14)',
                      }}
                    >
                      Recommended
                    </span>
                  ) : null}
                  {!option.available ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: '#fca5a5',
                        backgroundColor: 'rgba(248, 113, 113, 0.14)',
                      }}
                    >
                      Unavailable
                    </span>
                  ) : null}
                </div>
                <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  {option.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedOption && (
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'rgba(255, 255, 255, 0.025)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {selectedLabel}
            </span>
            {selectedOption.recommended ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px]"
                style={{
                  color: '#86efac',
                  backgroundColor: 'rgba(74, 222, 128, 0.14)',
                }}
              >
                Recommended
              </span>
            ) : null}
            {!selectedOption.available ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: '#fca5a5',
                        backgroundColor: 'rgba(248, 113, 113, 0.14)',
                      }}
                    >
                      Unavailable
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {selectedOption.detailMessage ?? selectedOption.statusMessage ?? 'Unavailable'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
          <div className="mt-2 space-y-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            <div>{selectedOption.description}</div>
            {selectedOption.statusMessage ? <div>{selectedOption.statusMessage}</div> : null}
            {selectedOption.detailMessage && selectedOption.available ? (
              <div className="break-words opacity-80">{selectedOption.detailMessage}</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
