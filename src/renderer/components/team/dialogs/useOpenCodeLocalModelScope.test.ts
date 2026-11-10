import { describe, expect, it } from 'vitest';

import { shouldEnableOpenCodeLocalModelScopeLookup } from './useOpenCodeLocalModelScope';

describe('shouldEnableOpenCodeLocalModelScopeLookup', () => {
  it('keeps lookup disabled until the project path is resolved', () => {
    expect(
      shouldEnableOpenCodeLocalModelScopeLookup({
        enabled: true,
        projectPath: '',
        requiresLookup: true,
      })
    ).toBe(false);
  });

  it('enables project-scoped lookup once a project path is available', () => {
    expect(
      shouldEnableOpenCodeLocalModelScopeLookup({
        enabled: true,
        projectPath: '/workspace/project',
        requiresLookup: true,
      })
    ).toBe(true);
  });

  it('does not run a lookup when no OpenCode selection needs it', () => {
    expect(
      shouldEnableOpenCodeLocalModelScopeLookup({
        enabled: true,
        projectPath: '/workspace/project',
        requiresLookup: false,
      })
    ).toBe(false);
  });
});
