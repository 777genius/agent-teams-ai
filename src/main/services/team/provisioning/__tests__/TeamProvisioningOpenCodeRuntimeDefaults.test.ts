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

  it('ignores non-OpenCode models when inheriting the OpenCode root model', async () => {
    const resolveClaudePath = vi.fn().mockResolvedValue('/usr/bin/claude');
    const ports = createPorts({ resolveClaudePath });

    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest(),
        members: [
          { name: 'dev', role: 'developer', providerId: 'opencode', model: 'gpt-5' },
          { name: 'reviewer', role: 'reviewer', providerId: 'anthropic', model: 'sonnet' },
          { name: 'qa', role: 'tester', providerId: 'codex', model: 'gpt-5-codex' },
        ],
      },
      ports
    );

    expect(result.request.model).toBe('gpt-5');
    expect(result.members).toEqual([
      expect.objectContaining({ name: 'dev', model: 'gpt-5' }),
      expect.objectContaining({ name: 'reviewer', model: 'sonnet' }),
      expect.objectContaining({ name: 'qa', model: 'gpt-5-codex' }),
    ]);
    expect(resolveClaudePath).not.toHaveBeenCalled();
  });

  it('resolves the OpenCode default instead of inheriting a non-OpenCode member model', async () => {
    const resolveProviderDefaultModel = vi.fn().mockResolvedValue(' opencode/default ');
    const ports = createPorts({ resolveProviderDefaultModel });

    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest(),
        members: [
          { name: 'dev', role: 'developer', providerId: 'opencode' },
          { name: 'reviewer', role: 'reviewer', providerId: 'anthropic', model: 'sonnet' },
        ],
      },
      ports
    );

    expect(result.request.model).toBe('opencode/default');
    expect(result.members).toEqual([
      expect.objectContaining({ name: 'dev', model: 'opencode/default' }),
      expect.objectContaining({ name: 'reviewer', model: 'sonnet' }),
    ]);
    expect(resolveProviderDefaultModel).toHaveBeenCalledOnce();
  });

  it('uses the first OpenCode member model for the root while preserving differing side lanes', async () => {
    const ports = createPorts();
    const result = await materializeOpenCodeRuntimeAdapterDefaults(
      {
        request: createRequest(),
        members: [
          { name: 'dev', role: 'developer', providerId: 'opencode', model: 'gpt-5' },
          { name: 'qa', role: 'tester', providerId: 'opencode', model: 'gpt-4.1' },
        ],
      },
      ports
    );

    expect(result.request.model).toBe('gpt-5');
    expect(result.members).toEqual([
      expect.objectContaining({ name: 'dev', model: 'gpt-5' }),
      expect.objectContaining({ name: 'qa', model: 'gpt-4.1' }),
    ]);
    expect(ports.resolveProviderDefaultModel).not.toHaveBeenCalled();
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
