import type { RuntimeProviderManagementApi } from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementPort = Omit<
  RuntimeProviderManagementApi,
  'getCompanionStatus' | 'installAndConnectCompanion' | 'connectCompanion' | 'onCompanionProgress'
>;
