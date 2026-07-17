import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeLaunchTimeoutMs,
  resolveOpenCodeReadinessTimeoutMs,
} from './OpenCodeReadinessBridge';

describe('resolveOpenCodeLaunchTimeoutMs', () => {
  it('keeps the standard launch timeout for regular OpenCode providers', () => {
    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'openai/gpt-5.4', members: [] })).toBe(
      120_000
    );
  });

  it('scales the timeout for serial native subscription CLI members', () => {
    const members = [
      { name: 'one', role: 'developer', prompt: 'one' },
      { name: 'two', role: 'developer', prompt: 'two' },
    ];

    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'cursor-acp/auto', members })).toBe(
      270_000
    );
    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'kiro/auto', members })).toBe(270_000);
  });

  it('honors an explicit launch timeout override', () => {
    expect(
      resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'cursor-acp/auto', members: [] }, 42_000)
    ).toBe(42_000);
  });

  it('uses one provider-independent readiness budget', () => {
    expect(resolveOpenCodeReadinessTimeoutMs('cursor-acp/auto')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('kiro/auto')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('ollama/gemma4:12b')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('openai/gpt-5.4')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('cursor-acp/auto', 42_000)).toBe(42_000);
  });
});
