import { selectOpenCodeV2ProviderConfiguration } from '../../composition/openCodeSelectedProviderConfiguration.js';
import {
  captureOpenCodeConfigurationSource,
  OpenCodeConfigurationError,
} from './OpenCodeConfigurationSource.js';
import { bindOpenCodeV2ConfigurationKey, OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';
import { managementDigest } from '../../management/identity.js';
import { DeferredOpenCodeV2FileKey } from './OpenCodeV2SelectedFileKey.js';

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
  purpose: 'model' | 'catalog' = 'model',
  existing?: { source: ReturnType<typeof captureOpenCodeConfigurationSource>; config: Record<string, unknown> }
) {
  const profile = structuredClone(raw),
    embedded = profile.embedded;
  const originalProvider =
    'profileId' in profile ? profile.nativeModel?.providerId : profile.nativeOptions.providerId;
  const baseline =
    selection.providerId === originalProvider ? embedded?.providerConfiguration : undefined;
  if (existing && (!embedded?.configurationSource ||
      managementDigest(embedded.configurationSource) !== existing.source.digest ||
      !existing.source.matchesConfiguration(existing.config))) invalid();
  if (existing && !existing.source.isCurrent()) throw new OpenCodeConfigurationError('configuration-changed');
  const source = existing?.source ?? (embedded?.configurationSource
    ? captureOpenCodeConfigurationSource(profile, embedded.configurationSource, ownerCurrent)
    : undefined);
  const config = existing ? structuredClone(existing.config) : source?.read();
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
  let selectedFile: DeferredOpenCodeV2FileKey | undefined;
  if (prepared.apiKey !== undefined || prepared.apiKeyFile !== undefined) {
    if (!source) return invalid();
    const scope = new OpenCodeV2CredentialScope(profile, selection.providerId, ownerCurrent);
    selectedFile = scope.captureDeferredConfiguration(source, selection.modelId, profile.cwd);
    if (!selectedFile) key = scope.captureConfiguration(source);
    // The original explicit config key wins; only the existing native credential owner receives it.
    const settings = jsonRecord(configuration?.settings);
    if (configuration && Object.hasOwn(settings, 'apiKey')) {
      const next = { ...settings }; delete next.apiKey; configuration.settings = next;
    }
  }
  let bound = false;
  const isCurrent = () => {
    if (key && !key.isCurrent()) return false;
    if (selectedFile && !selectedFile.isCurrent()) return false;
    if (!bound && source) return source.isCurrent();
    return key !== undefined || selectedFile !== undefined || ownerCurrent();
  };
  const check = () => {
    if (!isCurrent()) throw new OpenCodeConfigurationError('configuration-changed');
  };
  check();
  return Object.freeze({
    configuration,
    isCurrent,
    ...(key ? { key: bindOpenCodeV2ConfigurationKey(key, isCurrent) } : {}),
    ...(selectedFile ? { selectedFile: DeferredOpenCodeV2FileKey.bind(selectedFile, isCurrent) } : {}),
    /** A running native child owns its private immutable config; a new file publication affects the next capture. */
    bindRunningSession() {
      check();
      bound = true;
    },
  });
}
