import { describe, expect, it, vi } from 'vitest';

import {
  materializeOpenCodeRuntimeAdapterDefaults,
  type OpenCodeRuntimeDefaultsPorts,
} from '../TeamProvisioningOpenCodeRuntimeDefaults';

import type { TeamCreateRequest } from '@shared/types';

const testProjectPath = '/safe-test/project';

function createRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'alpha',
    cwd: testProjectPath,
    members: [],
    leadPrompt: 'lead',
    tasks: [],
    providerId: 'opencode',
    ...overrides,
  } as TeamCreateRequest;
}

function createPorts(
  overrides: Partial<OpenCodeRuntimeDefaultsPorts> = {}
): OpenCodeRuntimeDefaultsPorts {
  return {
    resolveClaudePath: vi.fn().mockResolvedValue('/usr/bin/claude'),
    buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { A: 'B' }, providerArgs: ['--x'] }),
    resolveProviderDefaultModel: vi.fn().mockResolvedValue(' opencode/default '),
    ...overrides,
  };
}

describe('OpenCode runtime defaults', () => {
  it('applies an explicit root model to OpenCode members missing model values', async () => {
    const ports = createPorts();

    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest({ model: ' opencode/gpt-5 ' }),
        members: [
          { name: 'lead', role: 'lead', providerId: 'opencode' },
          { name: 'dev', role: 'developer', providerId: 'opencode' },
          { name: 'claude', role: 'reviewer', providerId: 'anthropic' },
        ],
      },
      ports
    );

    expect(result.request.model).toBe('opencode/gpt-5');
    expect(result.members).toEqual([
      expect.objectContaining({ name: 'lead', model: 'opencode/gpt-5' }),
      expect.objectContaining({ name: 'dev', model: 'opencode/gpt-5' }),
      expect.objectContaining({ name: 'claude' }),
    ]);
    expect(ports.resolveProviderDefaultModel).not.toHaveBeenCalled();
  });

  it('uses one inherited member model as the root model when no root model is selected', async () => {
    const ports = createPorts();

    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest(),
        members: [{ name: 'dev', role: 'developer', providerId: 'opencode', model: 'gpt-5' }],
      },
      ports
    );

    expect(result.request.model).toBe('gpt-5');
    expect(result.members[0]?.model).toBe('gpt-5');
    expect(ports.resolveClaudePath).not.toHaveBeenCalled();
  });

  it('rejects ambiguous member model selections', async () => {
    await expect(
      materializeOpenCodeRuntimeAdapterDefaults(
        {
          request: createRequest(),
          members: [
            { name: 'dev', role: 'developer', providerId: 'opencode', model: 'gpt-5' },
            { name: 'qa', role: 'tester', providerId: 'opencode', model: 'gpt-4.1' },
          ],
        },
        createPorts()
      )
    ).rejects.toThrow(
      'OpenCode runtime adapter launch supports one selected model per lane. Select one team model or align OpenCode teammate models.'
    );
  });

  it('resolves and applies the runtime default model when no model is selected', async () => {
    const ports = createPorts();

    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest({ limitContext: true }),
        members: [{ name: 'dev', role: 'developer', providerId: 'opencode' }],
      },
      ports
    );

    expect(ports.buildProvisioningEnv).toHaveBeenCalledWith('opencode', undefined);
    expect(ports.resolveProviderDefaultModel).toHaveBeenCalledWith(
      '/usr/bin/claude',
      testProjectPath,
      'opencode',
      { A: 'B' },
      ['--x'],
      true
    );
    expect(result.request.model).toBe('opencode/default');
    expect(result.members[0]?.model).toBe('opencode/default');
  });

  it('fails when runtime default model resolution returns an empty value', async () => {
    await expect(
      materializeOpenCodeRuntimeAdapterDefaults(
        {
          request: createRequest(),
          members: [{ name: 'dev', role: 'developer', providerId: 'opencode' }],
        },
        createPorts({ resolveProviderDefaultModel: vi.fn().mockResolvedValue('   ') })
      )
    ).rejects.toThrow(
      'Could not resolve the runtime default model for OpenCode teammates. Select an explicit model and retry.'
    );
  });
});
