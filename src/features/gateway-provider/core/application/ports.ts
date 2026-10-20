import type { GatewayProviderState } from '../domain';

export interface GatewayProviderStorePort {
  read(): Promise<GatewayProviderState>;
  /** Serialized read-modify-write. The mutator may mutate the draft in place. */
  mutate<T>(mutator: (draft: GatewayProviderState) => T | Promise<T>): Promise<T>;
}

export interface GatewayClockPort {
  now(): Date;
}
