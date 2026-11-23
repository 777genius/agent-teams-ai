import { describe, expect, it, vi } from 'vitest';

import { assertTrashableOverHttp } from '../../src/main/startTeamPromptManagement';

function fixture(options: {
  mode?: 'shared' | 'per_project';
  unreadable?: boolean;
  index?: boolean;
}) {
  const meta = {
    getMeta: vi.fn(async () =>
      options.mode ? { projectContextMode: options.mode } : null
    ),
    metadataFileExists: vi.fn(async () => options.unreadable === true),
  };
  const registry = { hasRetainedIndex: vi.fn(async () => options.index === true) };
  return { meta, registry };
}

describe('HTTP trash of a team', () => {
  it('lets an ordinary team through, and a shared team without a contexts index', async () => {
    for (const options of [{}, { mode: 'shared' as const }]) {
      const f = fixture(options);
      await expect(assertTrashableOverHttp('legacy', f.meta, f.registry)).resolves.toBeUndefined();
    }
  });

  it('refuses a per-project team and a shared team that kept project history', async () => {
    for (const options of [{ mode: 'per_project' as const }, { mode: 'shared' as const, index: true }]) {
      const f = fixture(options);
      await expect(assertTrashableOverHttp('builders', f.meta, f.registry)).rejects.toThrow(
        'Project-scoped teams must be trashed from the desktop'
      );
    }
  });

  it('asks the index only for a team that is not per-project', async () => {
    const f = fixture({ mode: 'per_project' });
    await expect(assertTrashableOverHttp('builders', f.meta, f.registry)).rejects.toThrow();
    expect(f.registry.hasRetainedIndex).not.toHaveBeenCalled();
  });

  it('refuses when the metadata cannot be read, with its own text', async () => {
    const f = fixture({ unreadable: true });
    await expect(assertTrashableOverHttp('builders', f.meta, f.registry)).rejects.toThrow(
      'HTTP trash requires readable team metadata'
    );
  });
});
