// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const getPath = vi.fn(() => '/tmp/app-profile');
  const probeBackend = vi.fn(() => Promise.resolve({ status: 'ok' }));
  const feature = { probeBackend, customTeamTemplatesBackend: null };
  return {
    getPath,
    probeBackend,
    feature,
    createInternalStorageFeature: vi.fn(() => feature),
  };
});

vi.mock('electron', () => ({ app: { getPath: hoisted.getPath } }));

vi.mock('@features/internal-storage/main', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/internal-storage/main')>()),
  createInternalStorageFeature: hoisted.createInternalStorageFeature,
}));

const { startInternalStorage } = await import('@main/startInternalStorage');

const originalSmoke = process.env.AGENT_TEAMS_PACKAGED_SMOKE;

beforeEach(() => {
  hoisted.getPath.mockClear();
  hoisted.probeBackend.mockClear();
  hoisted.createInternalStorageFeature.mockClear();
  delete process.env.AGENT_TEAMS_PACKAGED_SMOKE;
});

afterEach(() => {
  if (originalSmoke === undefined) delete process.env.AGENT_TEAMS_PACKAGED_SMOKE;
  else process.env.AGENT_TEAMS_PACKAGED_SMOKE = originalSmoke;
});

describe('startInternalStorage', () => {
  it('creates the storage feature under the Electron user-data path', () => {
    const feature = startInternalStorage();

    expect(hoisted.getPath).toHaveBeenCalledWith('userData');
    expect(hoisted.createInternalStorageFeature).toHaveBeenCalledExactlyOnceWith({
      userDataPath: '/tmp/app-profile',
    });
    expect(feature).toBe(hoisted.feature);
  });

  it('probes the backend only for a packaged smoke run', () => {
    startInternalStorage();
    expect(hoisted.probeBackend).not.toHaveBeenCalled();

    process.env.AGENT_TEAMS_PACKAGED_SMOKE = '0';
    startInternalStorage();
    process.env.AGENT_TEAMS_PACKAGED_SMOKE = ' ';
    startInternalStorage();
    expect(hoisted.probeBackend).not.toHaveBeenCalled();

    process.env.AGENT_TEAMS_PACKAGED_SMOKE = '1';
    startInternalStorage();
    expect(hoisted.probeBackend).toHaveBeenCalledTimes(1);
  });
});
