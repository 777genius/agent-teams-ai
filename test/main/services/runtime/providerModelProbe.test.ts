import {
  buildCodexExecModelProbeArgs,
  buildProviderPreflightPingArgs,
  getProviderModelProbePrompt,
  getProviderPreflightModel,
  isProviderModelProbeSuccessOutput,
  parseProviderModelProbeResponse,
  validateProviderModelProbeExecutionMetadata,
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
    expect(getProviderPreflightModel('codex')).toBe('gpt-5.6-sol');
    expect(buildProviderPreflightPingArgs('codex')).toContain('gpt-5.6-sol');
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
      getProviderModelProbePrompt(),
    ]);
  });

  it('parses only a structured response bound to the caller expected nonce', () => {
    const response = JSON.stringify({
      schema: 'agent-teams-provider-probe-response-v1',
      nonce: 'fresh-nonce',
    });

    expect(parseProviderModelProbeResponse(response, 'fresh-nonce')).toEqual({
      schema: 'agent-teams-provider-probe-response-v1',
      nonce: 'fresh-nonce',
    });
    expect(parseProviderModelProbeResponse(response, 'stale-nonce')).toBeNull();
    expect(parseProviderModelProbeResponse(`prompt echo\n${response}`, 'fresh-nonce')).toBeNull();
  });

  it('never accepts a response-owned nonce as its own expectation', () => {
    const response = JSON.stringify({
      schema: 'agent-teams-provider-probe-response-v1',
      nonce: 'response-selected-nonce',
    });

    expect(isProviderModelProbeSuccessOutput(response, 'caller-selected-nonce')).toBe(false);
  });

  it('validates exact execution metadata only against the caller nonce', () => {
    const metadata = {
      schema: 'agent-teams-provider-execution-v1',
      nonce: 'fresh-nonce',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'xhigh',
    };

    expect(validateProviderModelProbeExecutionMetadata(metadata, 'fresh-nonce')).toMatchObject({
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'xhigh',
    });
    expect(validateProviderModelProbeExecutionMetadata(metadata, 'wrong-nonce')).toBeNull();
  });
});
