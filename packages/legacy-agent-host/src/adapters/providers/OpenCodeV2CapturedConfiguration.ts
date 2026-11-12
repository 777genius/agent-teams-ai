import { selectOpenCodeV2ProviderConfiguration } from '../../composition/openCodeSelectedProviderConfiguration.js';
import {
  captureOpenCodeConfigurationSource,
  OpenCodeConfigurationError,
} from './OpenCodeConfigurationSource.js';
import { OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';

import type { OpenCodeV2EmbeddedProfile } from '../../composition/openCodeV2EmbeddedProfile.js';
import type { OpenCodeMemberProfile } from '../../composition/runtimeProfile.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { CapturedOpenCodeV2Key } from './OpenCodeV2CredentialScope.js';

type Configuration = NonNullable<OpenCodeV2EmbeddedProfile['providerConfiguration']>;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonRecord = (value: Configuration[string] | undefined): Configuration =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const invalid = (): never => {
  throw new OpenCodeConfigurationError('configuration-invalid');
};

/** One private native input. Only references belong to the profile and durable source receipt. */
export function captureOpenCodeV2Configuration(
  raw: OpenCodeManagementProfile | OpenCodeMemberProfile,
  selection: { providerId: string; modelId: string },
  ownerCurrent: () => boolean,
  purpose: 'model' | 'catalog' = 'model'
) {
  const profile = structuredClone(raw),
    embedded = profile.embedded;
  const originalProvider =
    'profileId' in profile ? profile.nativeModel?.providerId : profile.nativeOptions.providerId;
  const baseline =
    selection.providerId === originalProvider ? embedded?.providerConfiguration : undefined;
  const source = embedded?.configurationSource
    ? captureOpenCodeConfigurationSource(profile, embedded.configurationSource, ownerCurrent)
    : undefined;
  const config = source?.read();
  let prepared: ReturnType<typeof selectOpenCodeV2ProviderConfiguration> = config
    ? selectOpenCodeV2ProviderConfiguration(config, selection, profile.environment)
    : {};
  if (purpose === 'catalog' && config && record(config.provider)) {
    const provider = config.provider[selection.providerId];
    if (record(provider) && record(provider.models)) {
      const ids = Object.keys(provider.models);
      if (ids.length > 2048) invalid();
      const models: Configuration = {};
      for (const modelId of ids) {
        const selected = selectOpenCodeV2ProviderConfiguration(
          config,
          { providerId: selection.providerId, modelId },
          profile.environment
        );
        Object.assign(models, jsonRecord(selected.configuration?.models));
      }
      if (ids.length)
        prepared = { ...prepared, configuration: { ...prepared.configuration, models } };
    }
  }
  const overlay = prepared.configuration;
  const configuration: Configuration | undefined =
    baseline || overlay
      ? {
          ...baseline,
          ...overlay,
          ...(baseline?.settings || overlay?.settings
            ? {
                settings: { ...jsonRecord(baseline?.settings), ...jsonRecord(overlay?.settings) },
              }
            : {}),
          ...(baseline?.models || overlay?.models
            ? {
                models: { ...jsonRecord(baseline?.models), ...jsonRecord(overlay?.models) },
              }
            : {}),
        }
      : undefined;
  if (Buffer.byteLength(JSON.stringify(configuration ?? {})) > 256 * 1024) invalid();
  let key: CapturedOpenCodeV2Key | undefined;
  if (prepared.apiKey !== undefined) {
    key = new OpenCodeV2CredentialScope(profile, selection.providerId, ownerCurrent).capture();
    // Donor launch resolves auth separately. A conflicting config key cannot silently replace it.
    if (!key.present || key.readKey() !== prepared.apiKey) invalid();
    const settings = jsonRecord(configuration?.settings);
    if (settings.apiKey !== undefined && settings.apiKey !== prepared.apiKey) invalid();
  }
  let bound = false;
  const isCurrent = () =>
    ownerCurrent() && (key?.isCurrent() ?? true) && (bound || (source?.isCurrent() ?? true));
  const check = () => {
    if (!isCurrent()) throw new OpenCodeConfigurationError('configuration-changed');
  };
  check();
  return Object.freeze({
    configuration,
    isCurrent,
    /** A running native child owns its private immutable config; a new file publication affects the next capture. */
    bindRunningSession() {
      check();
      bound = true;
    },
  });
}
