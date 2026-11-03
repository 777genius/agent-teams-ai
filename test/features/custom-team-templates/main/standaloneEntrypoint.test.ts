import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  throw new Error('Electron is unavailable in the standalone server');
});

describe('custom team templates standalone entrypoint', () => {
  it('composes the server feature without loading Electron', async () => {
    const { createCustomTeamTemplatesFeature, registerCustomTeamTemplatesHttp } =
      await import('@features/custom-team-templates/main');
    const feature = createCustomTeamTemplatesFeature({ backend: null });

    expect(registerCustomTeamTemplatesHttp).toBeTypeOf('function');
    await expect(feature.listTemplates.execute()).resolves.toEqual({
      status: 'storageUnavailable',
    });
    feature.dispose();
  });
});
