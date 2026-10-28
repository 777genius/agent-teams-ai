import type { RuntimeProviderManagementApi } from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementPort = Omit<
  RuntimeProviderManagementApi,
  | 'getCompanionStatus'
  | 'installAndConnectCompanion'
  | 'connectCompanion'
  | 'runCompanionAction'
  | 'onCompanionProgress'
  | 'listLocalProviders'
  | 'scanLocalProviders'
  | 'probeLocalProvider'
  | 'configureLocalProvider'
> & {
  shutdown?(): Promise<void>;
};

export type RuntimeLocalProviderConnectorPort = Pick<
  RuntimeProviderManagementApi,
  'listLocalProviders' | 'scanLocalProviders' | 'probeLocalProvider' | 'configureLocalProvider'
>;
