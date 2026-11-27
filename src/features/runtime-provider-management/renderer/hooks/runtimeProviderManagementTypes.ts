import type { RuntimeProviderManagementRuntimeId } from '../../contracts';
import type { RuntimeProviderConnectionIntent } from '../../core/domain';

export interface UseRuntimeProviderManagementOptions {
  runtimeId: RuntimeProviderManagementRuntimeId;
  enabled: boolean;
  directoryPageSize?: number;
  directorySummaryOnEnable?: boolean;
  reuseCachedFullDirectory?: boolean;
  runtimeRevision?: string | null;
  loadViewOnEnable?: boolean;
  preserveViewRequestOnDisable?: boolean;
  searchDirectoryOnQueryChange?: boolean;
  projectPath?: string | null;
  connectionContextToken?: string;
  initialProviderId?: string | null;
  initialProviderAction?: RuntimeProviderConnectionIntent | 'select' | null;
  bundledRuntimeVersion?: string;
  onProviderChanged?: (
    changeKind: RuntimeProviderChangeKind
  ) => Promise<boolean | void> | boolean | void;
}
export type RuntimeProviderModelPickerMode = 'use' | 'runtime-default';
export type RuntimeProviderChangeKind =
  | 'connection'
  | 'credential_removed'
  | 'configuration'
  | 'model_tested'
  | 'oauth_cancelled';
