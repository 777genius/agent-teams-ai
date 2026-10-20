import { useMemo } from 'react';

import { useGatewayMemberBindings } from '@features/gateway-provider/renderer';

import { useOpenCodeLocalModelScope } from './useOpenCodeLocalModelScope';

export function useDialogMemberModelScope(
  input: Parameters<typeof useOpenCodeLocalModelScope>[0] & { teamName?: string }
) {
  const gatewayBindings = useGatewayMemberBindings(input.enabled ? input.teamName : undefined);
  const openCodeScope = useOpenCodeLocalModelScope(input);
  const scope = useMemo(
    () => ({
      ...openCodeScope,
      gatewayBoundMemberNames: gatewayBindings.boundMemberNames,
      gatewayBindingsPending: gatewayBindings.pending,
    }),
    [openCodeScope, gatewayBindings]
  );
  return { scope, gatewayBindings };
}
