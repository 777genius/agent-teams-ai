import { describe, expect, it } from 'vitest';

import { mergeJsonSettingsArgs, parseCodexCliSettingsArgs } from './cliSettingsArgs';
import {
  buildCodexCustomProviderConfigOverrides,
  buildCodexLaunchArgs,
  CODEX_CUSTOM_PROVIDER_ID,
  CODEX_CUSTOM_PROVIDER_SETTINGS_KEY,
  CODEX_LAUNCH_CONFIG_SETTINGS_KEY,
  CODEX_NATIVE_API_KEY_ENV_VAR,
} from './ProviderConnectionService';

const BASE_URL = 'https://gw.example.com';

function gatewayOverrides(): string[] {
  return buildCodexCustomProviderConfigOverrides({ enabled: true, baseUrl: BASE_URL, model: 'gpt-5' });
}

describe('buildCodexCustomProviderConfigOverrides', () => {
  it('pins the custom provider id, responses wire api, and per-process env key', () => {
    const overrides = gatewayOverrides();
    expect(overrides).toContain(`model_provider="${CODEX_CUSTOM_PROVIDER_ID}"`);
    expect(overrides).toContain(
      `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.base_url="${BASE_URL}"`
    );
    expect(overrides).toContain(
      `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.wire_api="responses"`
    );
    expect(overrides).toContain(
      `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.env_key="${CODEX_NATIVE_API_KEY_ENV_VAR}"`
    );
  });
});

describe('parseCodexCliSettingsArgs', () => {
  it('round-trips the native -c CLI form back to configOverrides and login method', () => {
    const custom = gatewayOverrides();
    const args = buildCodexLaunchArgs(null, 'api', {
      dialect: 'native',
      customProviderConfigOverrides: custom,
      cliConfigOverrides: ['model="gpt-5"'],
    });

    expect(args[0]).toBe('-c');
    expect(args).toContain('forced_login_method="api"');

    const parsed = parseCodexCliSettingsArgs(args);
    expect(parsed.forcedLoginMethod).toBe('api');
    expect(parsed.configOverrides).toEqual([...custom, 'model="gpt-5"']);
  });

  it('round-trips the inline --settings JSON form back to configOverrides and login method', () => {
    const custom = gatewayOverrides();
    const args = buildCodexLaunchArgs(null, 'api', {
      customProviderConfigOverrides: custom,
      cliConfigOverrides: ['model="gpt-5"'],
    });

    expect(args[0]).toBe('--settings');
    const settings = JSON.parse(args[1]) as {
      codex: Record<string, unknown>;
    };
    expect(settings.codex.forced_login_method).toBe('api');
    expect(settings.codex[CODEX_CUSTOM_PROVIDER_SETTINGS_KEY]).toEqual({
      config_overrides: custom,
    });
    expect(settings.codex[CODEX_LAUNCH_CONFIG_SETTINGS_KEY]).toEqual({
      config_overrides: ['model="gpt-5"'],
    });

    const parsed = parseCodexCliSettingsArgs(args);
    expect(parsed.forcedLoginMethod).toBe('api');
    expect(parsed.configOverrides).toEqual([...custom, 'model="gpt-5"']);
  });

  it('round-trips the --settings=<json> inline prefix form', () => {
    const custom = gatewayOverrides();
    const args = buildCodexLaunchArgs(null, 'api', { customProviderConfigOverrides: custom });
    const inline = [`--settings=${args[1]}`];

    const parsed = parseCodexCliSettingsArgs(inline);
    expect(parsed.forcedLoginMethod).toBe('api');
    expect(parsed.configOverrides).toEqual(custom);
  });

  it('keeps both forms equal after the shared settings-args merge', () => {
    const custom = gatewayOverrides();
    const nativeArgs = buildCodexLaunchArgs(null, 'api', {
      dialect: 'native',
      customProviderConfigOverrides: custom,
    });
    const settingsArgs = buildCodexLaunchArgs(null, 'api', {
      customProviderConfigOverrides: custom,
    });

    // mergeJsonSettingsArgs collapses only the JSON form; the parsed content
    // must stay identical across both CLI shapes either way.
    const merged = mergeJsonSettingsArgs([...settingsArgs, '--verbose']);
    expect(parseCodexCliSettingsArgs(merged)).toEqual(parseCodexCliSettingsArgs(nativeArgs));
  });
});
