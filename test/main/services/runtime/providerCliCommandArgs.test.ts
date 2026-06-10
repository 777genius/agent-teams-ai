import {
  buildProviderControlPlaneCliCommandArgs,
  buildProviderLaunchCliCommandArgs,
  stripProviderControlPlaneUnsupportedArgs,
} from '@main/services/runtime/providerCliCommandArgs';
import { describe, expect, it } from 'vitest';

describe('providerCliCommandArgs', () => {
  it('preserves launch-only config overrides for provider launch commands', () => {
    expect(
      buildProviderLaunchCliCommandArgs(
        ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}', '-c', 'service_tier="fast"'],
        ['-p', 'Output only PONG']
      )
    ).toEqual([
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
      '-c',
      'service_tier="fast"',
      '-p',
      'Output only PONG',
    ]);
  });

  it('strips config overrides from provider control-plane commands while preserving settings', () => {
    expect(
      buildProviderControlPlaneCliCommandArgs(
        [
          '--settings',
          '{"codex":{"forced_login_method":"chatgpt"}}',
          '-c',
          'service_tier="fast"',
          '--config',
          'features.fast_mode=true',
          '-c=model_reasoning_effort="high"',
          '--config=model_reasoning_summary="auto"',
        ],
        ['runtime', 'status', '--json', '--summary', '--provider', 'codex']
      )
    ).toEqual([
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
      'runtime',
      'status',
      '--json',
      '--summary',
      '--provider',
      'codex',
    ]);
  });

  it('drops dangling config flags instead of leaking them into control-plane argv', () => {
    expect(stripProviderControlPlaneUnsupportedArgs(['--settings', '{"codex":{}}', '-c'])).toEqual([
      '--settings',
      '{"codex":{}}',
    ]);
  });
});
