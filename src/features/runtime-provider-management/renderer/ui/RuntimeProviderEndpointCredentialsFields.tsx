import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';

import type { JSX } from 'react';

interface RuntimeProviderEndpointCredentialsFieldsProps {
  readonly providerId: string;
  readonly apiKey: string;
  readonly hasConfiguredApiKey: boolean;
  readonly disabled: boolean;
  readonly providerIdDisabled: boolean;
  readonly onProviderIdChange: (value: string) => void;
  readonly onApiKeyChange: (value: string) => void;
  readonly onChanged: () => void;
}

export const RuntimeProviderEndpointCredentialsFields = ({
  providerId,
  apiKey,
  hasConfiguredApiKey,
  disabled,
  providerIdDisabled,
  onProviderIdChange,
  onApiKeyChange,
  onChanged,
}: RuntimeProviderEndpointCredentialsFieldsProps): JSX.Element => (
  <div className="grid gap-3 md:grid-cols-2">
    <div className="space-y-1.5">
      <Label htmlFor="runtime-local-provider-id">Provider ID (advanced)</Label>
      <Input
        id="runtime-local-provider-id"
        value={providerId}
        disabled={disabled || providerIdDisabled}
        placeholder="omniroute"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          onProviderIdChange(event.currentTarget.value);
          onChanged();
        }}
      />
    </div>
    <div className="space-y-1.5">
      <Label htmlFor="runtime-local-provider-api-key">API key (optional)</Label>
      <Input
        id="runtime-local-provider-api-key"
        type="password"
        value={apiKey}
        disabled={disabled}
        placeholder="Enter one if your endpoint requires it"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          onApiKeyChange(event.currentTarget.value);
          onChanged();
        }}
      />
      <p className="text-[11px] text-[var(--color-text-muted)]">
        {hasConfiguredApiKey
          ? 'This endpoint has a stored key. Re-enter it to verify and save changes.'
          : 'Stored in a private key file referenced by opencode.json.'}
      </p>
    </div>
  </div>
);
