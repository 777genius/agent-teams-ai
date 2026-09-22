import type {
  RuntimeProviderManagementCancelModelLoadInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestControlResponse,
} from '../../contracts';

/** The narrow renderer transport needed by OpenCode catalog reads. */
export interface OpenCodeCatalogTransportPort {
  loadModels(
    input: RuntimeProviderManagementLoadModelsInput
  ): Promise<RuntimeProviderManagementModelsResponse>;
  cancelModelLoad?(
    input: RuntimeProviderManagementCancelModelLoadInput
  ): Promise<RuntimeProviderManagementModelTestControlResponse>;
}

export interface OpenCodeConnectedCatalogTransportPort extends OpenCodeCatalogTransportPort {
  loadProviderDirectory(
    input: RuntimeProviderManagementLoadDirectoryInput
  ): Promise<RuntimeProviderManagementDirectoryResponse>;
}

/** Shell-owned bindings supplied to host-independent catalog hooks and loaders. */
export interface OpenCodeCatalogDependencies<
  Transport extends OpenCodeCatalogTransportPort = OpenCodeCatalogTransportPort,
> {
  transport: Transport;
  isElectronCapable(): boolean;
}

export type OpenCodeConnectedCatalogDependencies =
  OpenCodeCatalogDependencies<OpenCodeConnectedCatalogTransportPort>;
