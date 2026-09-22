// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename -- Test fixture paths are generated inside mkdtemp. */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface EnsureElectronInstallModule {
  ensureElectronInstall(input?: {
    electronPackagePath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    quiet?: boolean;
    runInstaller?: (installPath: string) => void;
    strict?: boolean;
  }): {
    executablePath: string;
    installed: boolean;
    pathFile: string;
    platformPath: string;
  };
}

const requireScript = createRequire(import.meta.url);
const { ensureElectronInstall } = requireScript(
  path.join(process.cwd(), 'scripts/ensure-electron-install.cjs')
) as EnsureElectronInstallModule;

describe('ensure electron install script', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('repairs a missing Electron binary by running the package installer', async () => {
    const electronDir = await createFakeElectronPackage();
    const executablePath = path.join(
      electronDir,
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    );
    const runInstaller = vi.fn((installPath: string) => {
      expect(installPath).toBe(path.join(electronDir, 'install.js'));
      mkdirSync(path.dirname(executablePath), { recursive: true });
      writeFileSync(executablePath, '');
    });

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: {},
      platform: 'darwin',
      quiet: true,
      runInstaller,
      strict: true,
    });

    expect(runInstaller).toHaveBeenCalledOnce();
    expect(result.installed).toBe(true);
    expect(result.executablePath).toBe(executablePath);
    await expect(fs.readFile(path.join(electronDir, 'path.txt'), 'utf8')).resolves.toBe(
      'Electron.app/Contents/MacOS/Electron'
    );
  });

  it('does not run the installer when the Electron binary already exists', async () => {
    const electronDir = await createFakeElectronPackage();
    const executablePath = path.join(electronDir, 'dist', 'electron');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '');
    const runInstaller = vi.fn();

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: {},
      platform: 'linux',
      quiet: true,
      runInstaller,
      strict: true,
    });

    expect(runInstaller).not.toHaveBeenCalled();
    expect(result.installed).toBe(true);
    expect(existsSync(path.join(electronDir, 'path.txt'))).toBe(true);
  });

  it('fails early in strict mode when the installer does not restore the binary', async () => {
    const electronDir = await createFakeElectronPackage();

    expect(() =>
      ensureElectronInstall({
        electronPackagePath: path.join(electronDir, 'package.json'),
        env: {},
        platform: 'linux',
        quiet: true,
        runInstaller: vi.fn(),
        strict: true,
      })
    ).toThrow(/Electron binary is missing after install/);
  });

  async function createFakeElectronPackage(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-install-test-'));
    const electronDir = path.join(tempDir, 'electron');
    await fs.mkdir(electronDir, { recursive: true });
    await fs.writeFile(path.join(electronDir, 'package.json'), '{"name":"electron"}', 'utf8');
    await fs.writeFile(path.join(electronDir, 'install.js'), '', 'utf8');
    return electronDir;
  }
});
