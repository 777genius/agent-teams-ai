import type { RuntimeProviderManagementApi } from '@features/runtime-provider-management/contracts';

type BaseRuntimeProviderManagementPort = Omit<
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

/** Main-only authority captured from the original IPC sender before selecting an account. */
export interface RuntimeProviderManagementRequestScope {
  isCurrent(): boolean;
}

export type ScopedRuntimeProviderManagementMethod =
  | 'loadView'
  | 'loadProviderDirectory'
  | 'loadSetupForm'
  | 'connectProvider'
  | 'forgetCredential';

export type RuntimeProviderManagementPort = Omit<
  BaseRuntimeProviderManagementPort,
  ScopedRuntimeProviderManagementMethod
> & {
  [K in ScopedRuntimeProviderManagementMethod]: (
    input: Parameters<BaseRuntimeProviderManagementPort[K]>[0],
    scope?: RuntimeProviderManagementRequestScope
  ) => ReturnType<BaseRuntimeProviderManagementPort[K]>;
};
