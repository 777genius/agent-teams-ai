import type {
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
} from './OpenCodeBridgeCommandContract';

/** Single-use opaque authority that fences an irreversible bridge process invocation. */
export interface OpenCodeBridgeInvocationAuthority {
  invoke<T>(invocation: () => T): T;
}

export interface OpenCodeBridgeInvocationOptions {
  invocationAuthority?: OpenCodeBridgeInvocationAuthority;
  /** Reports durable evidence that this exact invocation produced side effects before restart. */
  onInvocationDisposition?: (disposition: 'previous_side_effects_recovered') => void;
  onInvocationDispatched?: () => void;
}

export type OpenCodeLaunchTeamBridge = (
  input: OpenCodeLaunchTeamCommandBody,
  invocation?: OpenCodeBridgeInvocationOptions
) => Promise<OpenCodeLaunchTeamCommandData>;
