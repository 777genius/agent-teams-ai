import type { RuntimeProviderManagementApi } from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementPort = Omit<
  RuntimeProviderManagementApi,
  | 'getCompanionStatus'
  | 'installAndConnectCompanion'
  | 'connectCompanion'
  | 'onCompanionProgress'
  | 'scanLocalProviders'
  | 'probeLocalProvider'
  | 'configureLocalProvider'
>;

export type RuntimeLocalProviderConnectorPort = Pick<
  RuntimeProviderManagementApi,
  'scanLocalProviders' | 'probeLocalProvider' | 'configureLocalProvider'
>;
