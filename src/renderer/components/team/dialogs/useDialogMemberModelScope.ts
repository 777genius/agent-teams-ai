import { useMemo } from 'react';

import { useGatewayMemberBindings } from '@features/gateway-provider/renderer';

import { useOpenCodeLocalModelScope } from './useOpenCodeLocalModelScope';

export function useDialogMemberModelScope(
  input: Omit<Parameters<typeof useOpenCodeLocalModelScope>[0], 'members'> & {
    teamName?: string;
    members: readonly (Parameters<typeof useOpenCodeLocalModelScope>[0]['members'][number] & {
      name: string;
    })[];
  }
) {
  const gatewayBindings = useGatewayMemberBindings(input.enabled ? input.teamName : undefined, {
    memberNames: input.members.filter((member) => !member.removedAt).map((member) => member.name),
    mode: 'roster',
  });
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
