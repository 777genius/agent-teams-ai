import { afterEach, describe, expect, it, vi } from 'vitest';

const originalNodeEnv = process.env.NODE_ENV;
const originalResourcesPath = processWithResourcesPath().resourcesPath;

function processWithResourcesPath(): NodeJS.Process & { resourcesPath?: string } {
  return process as NodeJS.Process & { resourcesPath?: string };
}

async function importAppIcon(): Promise<typeof import('@main/utils/appIcon')> {
  vi.resetModules();
  return import('@main/utils/appIcon');
}

function setResourcesPath(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(processWithResourcesPath(), 'resourcesPath');
    return;
  }
  Object.defineProperty(processWithResourcesPath(), 'resourcesPath', {
    configurable: true,
    value,
  });
}

describe('getAppIconPath', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    setResourcesPath(originalResourcesPath);
    vi.resetModules();
  });

  it('does not require Electron resourcesPath outside packaged Electron', async () => {
    process.env.NODE_ENV = 'test';
    setResourcesPath(undefined);

    const { getAppIconPath } = await importAppIcon();

    expect(() => getAppIconPath()).not.toThrow();
  });
});
