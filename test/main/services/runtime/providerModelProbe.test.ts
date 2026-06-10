import {
  buildCodexExecModelProbeArgs,
  buildProviderPreflightPingArgs,
  getProviderPreflightModel,
} from '@main/services/runtime/providerModelProbe';
import { describe, expect, it } from 'vitest';

describe('providerModelProbe', () => {
  it('uses the configured model override for Codex preflight probes', () => {
    expect(getProviderPreflightModel('codex', { modelOverride: 'gateway-codex-model' })).toBe(
      'gateway-codex-model'
    );

    expect(
      buildProviderPreflightPingArgs('codex', { modelOverride: 'gateway-codex-model' })
    ).toContain('gateway-codex-model');
  });

  it('keeps the default Codex preflight model when no override is configured', () => {
    expect(getProviderPreflightModel('codex')).toBe('gpt-5.4-mini');
    expect(buildProviderPreflightPingArgs('codex')).toContain('gpt-5.4-mini');
  });

  it('builds direct Codex exec probes that ignore user config', () => {
    expect(buildCodexExecModelProbeArgs('gpt-5.4')).toEqual([
      'exec',
      '--ignore-user-config',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--model',
      'gpt-5.4',
      'Output only the single word PONG.',
    ]);
  });
});
