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

export function getProviderRuntimeBackendStateLabel(
  option: NonNullable<CliProviderStatus['availableBackends']>[number]
): string | null {
  switch (option.state) {
    case 'ready':
      return null;
    case 'locked':
      return 'Locked';
    case 'disabled':
      return 'Disabled';
    case 'authentication-required':
      return 'Auth required';
    case 'runtime-missing':
      return 'Runtime missing';
    case 'degraded':
      return 'Degraded';
    default:
      if (!option.available) {
        return 'Unavailable';
      }
      if (option.selectable === false) {
        return 'Locked';
      }
      return null;
  }
}

export function getProviderRuntimeBackendAudienceLabel(
  option: NonNullable<CliProviderStatus['availableBackends']>[number]
): string | null {
  return option.audience === 'internal' ? 'Internal' : null;
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
  const parts = [getOptionDisplayLabel(selectedOption, resolvedOption)];
  const audienceLabel = getProviderRuntimeBackendAudienceLabel(selectedOption);
  const stateLabel = getProviderRuntimeBackendStateLabel(selectedOption);

  if (audienceLabel) {
    parts.push(audienceLabel.toLowerCase());
  }
  if (stateLabel) {
    parts.push(stateLabel.toLowerCase());
  }

  return parts.join(' - ');
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
  const selectedStateLabel = getProviderRuntimeBackendStateLabel(selectedOption);
  const selectedAudienceLabel = getProviderRuntimeBackendAudienceLabel(selectedOption);

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
              disabled={
                (!option.available || option.selectable === false) &&
                option.id !== selectedBackendId
              }
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
                  {getProviderRuntimeBackendAudienceLabel(option) ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color: '#93c5fd',
                        backgroundColor: 'rgba(59, 130, 246, 0.14)',
                      }}
                    >
                      {getProviderRuntimeBackendAudienceLabel(option)}
                    </span>
                  ) : null}
                  {getProviderRuntimeBackendStateLabel(option) ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color:
                          option.state === 'disabled' ||
                          option.state === 'authentication-required' ||
                          option.state === 'runtime-missing' ||
                          option.state === 'degraded' ||
                          (!option.available && option.state !== 'locked')
                            ? '#fca5a5'
                            : 'var(--color-text-secondary)',
                        backgroundColor:
                          option.state === 'disabled' ||
                          option.state === 'authentication-required' ||
                          option.state === 'runtime-missing' ||
                          option.state === 'degraded' ||
                          (!option.available && option.state !== 'locked')
                            ? 'rgba(248, 113, 113, 0.14)'
                            : 'rgba(255, 255, 255, 0.08)',
                      }}
                    >
                      {getProviderRuntimeBackendStateLabel(option)}
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
            {selectedAudienceLabel ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px]"
                style={{
                  color: '#93c5fd',
                  backgroundColor: 'rgba(59, 130, 246, 0.14)',
                }}
              >
                {selectedAudienceLabel}
              </span>
            ) : null}
            {!selectedStateLabel && !selectedOption.available ? (
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
            ) : selectedStateLabel ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        color:
                          selectedOption.state === 'locked'
                            ? 'var(--color-text-secondary)'
                            : '#fca5a5',
                        backgroundColor:
                          selectedOption.state === 'locked'
                            ? 'rgba(255, 255, 255, 0.08)'
                            : 'rgba(248, 113, 113, 0.14)',
                      }}
                    >
                      {selectedStateLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {selectedOption.detailMessage ??
                      selectedOption.statusMessage ??
                      'This backend cannot be selected yet.'}
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
