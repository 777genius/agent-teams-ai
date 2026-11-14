import type {
  CliInstallationStatus,
  CliInstallerGetStatusOptions,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusRequestOptions,
  OpenCodeRuntimeStatus,
} from '@shared/types';

/** Existing Desktop status conversation; native metadata never extends the Session SPI. */
export interface RuntimeProviderStatusPort {
  /** Missing native evidence is a refusal; it cannot select the separate installer status. */
  readOpenCodeRuntimeStatus?(): Promise<OpenCodeRuntimeStatus | null>;
  getStatus(options?: CliInstallerGetStatusOptions): Promise<CliInstallationStatus>;
  getProviderStatus(
    providerId: CliProviderId,
    options?: CliProviderStatusRequestOptions
  ): Promise<CliProviderStatus>;
  verifyProviderModels(providerId: CliProviderId): Promise<CliProviderStatus>;
}
