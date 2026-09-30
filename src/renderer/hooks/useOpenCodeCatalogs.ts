import {
  useOpenCodeConnectedModelCatalog as useFeatureOpenCodeConnectedModelCatalog,
  useOpenCodeProviderModelCatalog as useFeatureOpenCodeProviderModelCatalog,
} from '@features/runtime-provider-management/renderer';
import { api, isElectronMode } from '@renderer/api';

import type {
  OpenCodeCatalogDependencies,
  OpenCodeCatalogTransportPort,
  OpenCodeConnectedCatalogDependencies,
  OpenCodeConnectedCatalogTransportPort,
} from '@features/runtime-provider-management/renderer';

const transport: OpenCodeConnectedCatalogTransportPort = {
  loadModels: (input) => api.runtimeProviderManagement.loadModels(input),
  loadProviderDirectory: (input) => api.runtimeProviderManagement.loadProviderDirectory(input),
  get cancelModelLoad(): OpenCodeCatalogTransportPort['cancelModelLoad'] {
    const runtimeProviderManagement = api.runtimeProviderManagement;
    return typeof runtimeProviderManagement.cancelModelLoad === 'function'
      ? (input) => runtimeProviderManagement.cancelModelLoad(input)
      : undefined;
  },
};

const catalogDependencies: OpenCodeCatalogDependencies = {
  transport,
  isElectronCapable: isElectronMode,
};

const connectedCatalogDependencies: OpenCodeConnectedCatalogDependencies = {
  transport,
  isElectronCapable: isElectronMode,
};

export function useOpenCodeProviderModelCatalog(
  input: Parameters<typeof useFeatureOpenCodeProviderModelCatalog>[0]
): ReturnType<typeof useFeatureOpenCodeProviderModelCatalog> {
  return useFeatureOpenCodeProviderModelCatalog(input, catalogDependencies);
}

export function useOpenCodeConnectedModelCatalog(
  input: Parameters<typeof useFeatureOpenCodeConnectedModelCatalog>[0]
): ReturnType<typeof useFeatureOpenCodeConnectedModelCatalog> {
  return useFeatureOpenCodeConnectedModelCatalog(input, connectedCatalogDependencies);
}
