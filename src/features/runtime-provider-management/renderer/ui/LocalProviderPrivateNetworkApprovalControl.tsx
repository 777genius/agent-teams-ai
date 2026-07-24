import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';

import type { JSX } from 'react';

interface LocalProviderPrivateNetworkApprovalControlProps {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}

export const LocalProviderPrivateNetworkApprovalControl = ({
  checked,
  disabled,
  onChange,
}: LocalProviderPrivateNetworkApprovalControlProps): JSX.Element => {
  return (
    <div className="flex items-start gap-2 rounded-md bg-amber-300/[0.05] px-3 py-2.5 text-xs text-amber-100">
      <Checkbox
        id="runtime-local-provider-private-network"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor="runtime-local-provider-private-network" className="font-normal">
        <span className="block">Allow this local network address</span>
        <span className="mt-0.5 block text-[11px] text-amber-100/70">
          This server runs on another machine on your network. Traffic is sent over your local
          network, unencrypted when using HTTP.
        </span>
      </Label>
    </div>
  );
};
