import type {
  CliInstallationStatus,
  CliInstallerGetStatusOptions,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusRequestOptions,
} from '@shared/types';

/** Existing Desktop status conversation; native metadata never extends the Session SPI. */
export interface RuntimeProviderStatusPort {
  getStatus(options?: CliInstallerGetStatusOptions): Promise<CliInstallationStatus>;
  getProviderStatus(
    providerId: CliProviderId,
    options?: CliProviderStatusRequestOptions
  ): Promise<CliProviderStatus>;
  verifyProviderModels(providerId: CliProviderId): Promise<CliProviderStatus>;
}
