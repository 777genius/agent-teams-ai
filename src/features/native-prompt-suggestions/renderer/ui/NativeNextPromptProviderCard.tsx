import { SettingsToggle } from '@renderer/components/settings/components/SettingsToggle';

import type { JSX } from 'react';

/** Passive switch card for one provider's next-message suggestions; state and saving live in the adapter. */
export function NativeNextPromptProviderCard({
  providerId,
  title,
  description,
  enabled,
  saving,
  disabled = false,
  error,
  onChange,
}: {
  readonly providerId: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly disabled?: boolean;
  readonly error: string | null;
  readonly onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div
      className="space-y-2 rounded-md border p-3"
      style={{ borderColor: 'var(--color-border-subtle)' }}
      data-testid={`native-next-prompt-setting-${providerId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {title}
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {description}
          </div>
        </div>
        <SettingsToggle enabled={enabled} ariaLabel={title} disabled={saving || disabled} onChange={onChange} />
      </div>
      {error ? (
        <div
          className="text-xs"
          style={{ color: 'var(--color-text-danger, #f87171)' }}
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
