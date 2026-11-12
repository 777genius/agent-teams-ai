/** Compatibility entry; the Host package owns the single Windows broker bridge. */
export {
  connectPrivateBroker, createWindowsOwnedLaunchPort, verifyStagedBroker,
} from '@agent-teams/legacy-agent-host/owned-process';
export type { BrokerTransport, BrokerTransportFactory } from '@agent-teams/legacy-agent-host/owned-process';
