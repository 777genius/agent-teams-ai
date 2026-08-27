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
  onInvocationDispatched?: () => void;
}

export type OpenCodeLaunchTeamBridge = (
  input: OpenCodeLaunchTeamCommandBody,
  invocation?: OpenCodeBridgeInvocationOptions
) => Promise<OpenCodeLaunchTeamCommandData>;
