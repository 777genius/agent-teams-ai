// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename -- Test fixture paths are generated inside mkdtemp. */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface EnsureElectronInstallModule {
  ensureElectronInstall(input?: {
    electronPackagePath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    quiet?: boolean;
    logger?: { warn: (message: string) => void };
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
      writeFileSync(path.join(electronDir, 'dist', 'version'), '44.4.5');
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
    await fs.writeFile(path.join(electronDir, 'dist', 'version'), '44.4.5');
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

  it('preserves the Electron installer target when it differs from the host platform', async () => {
    const electronDir = await createFakeElectronPackage();
    const executablePath = path.join(electronDir, 'dist', 'electron.exe');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '');
    await fs.writeFile(path.join(electronDir, 'dist', 'version'), '44.4.5');

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: { ELECTRON_INSTALL_PLATFORM: 'win32', npm_config_platform: 'darwin' },
      platform: 'linux',
      quiet: true,
      runInstaller: vi.fn(),
      strict: true,
    });

    expect(result.executablePath).toBe(executablePath);
    await expect(fs.readFile(result.pathFile, 'utf8')).resolves.toBe('electron.exe');
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

  it('repairs a partial extraction with a binary but no version marker', async () => {
    const electronDir = await createFakeElectronPackage();
    const executablePath = path.join(electronDir, 'dist', 'electron');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '');
    const runInstaller = vi.fn(() => {
      writeFileSync(path.join(electronDir, 'dist', 'version'), '44.4.5');
    });

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: {},
      platform: 'linux',
      quiet: true,
      runInstaller,
      strict: true,
    });

    expect(runInstaller).toHaveBeenCalledOnce();
    expect(result.installed).toBe(true);
  });

  it('replaces an installation whose version differs from the package version', async () => {
    const electronDir = await createFakeElectronPackage();
    await createLinuxBinary(electronDir, '43.0.0');
    const runInstaller = vi.fn(() => {
      writeFileSync(path.join(electronDir, 'dist', 'version'), '44.4.5');
    });

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: {},
      platform: 'linux',
      quiet: true,
      runInstaller,
      strict: true,
    });

    expect(runInstaller).toHaveBeenCalledOnce();
    expect(result.installed).toBe(true);
    await expect(fs.readFile(path.join(electronDir, 'dist', 'version'), 'utf8')).resolves.toBe(
      '44.4.5'
    );
  });

  it.each(['missing', 'mismatched', 'unreadable'])(
    'rejects a repair that leaves the version %s',
    async (versionState) => {
      const electronDir = await createFakeElectronPackage();
      await createLinuxBinary(electronDir);
      const versionPath = path.join(electronDir, 'dist', 'version');
      if (versionState === 'mismatched') {
        await fs.writeFile(versionPath, '43.0.0');
      } else if (versionState === 'unreadable') {
        await fs.mkdir(versionPath);
      }
      const runInstaller = vi.fn();

      expect(() =>
        ensureElectronInstall({
          electronPackagePath: path.join(electronDir, 'package.json'),
          env: {},
          platform: 'linux',
          quiet: true,
          runInstaller,
          strict: true,
        })
      ).toThrow(/Electron version is missing or does not match 44\.4\.5 after install/);
      expect(runInstaller).toHaveBeenCalledOnce();
    }
  );

  it('warns and reports an invalid version as uninstalled outside strict mode', async () => {
    const electronDir = await createFakeElectronPackage();
    await createLinuxBinary(electronDir, '43.0.0');
    const warn = vi.fn();

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: {},
      platform: 'linux',
      quiet: true,
      runInstaller: vi.fn(),
      logger: { warn },
    });

    expect(result.installed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Electron version is missing or does not match/)
    );
  });

  it.each([undefined, 'electron.exe'])(
    'repairs marker %s for a healthy leading-v version without downloading',
    async (marker) => {
      const electronDir = await createFakeElectronPackage();
      await createLinuxBinary(electronDir, 'v44.4.5');
      if (marker) {
        await fs.writeFile(path.join(electronDir, 'path.txt'), marker);
      }
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
      await expect(fs.readFile(result.pathFile, 'utf8')).resolves.toBe('electron');
    }
  );

  it('accepts a custom override executable without a version or import marker', async () => {
    const electronDir = await createFakeElectronPackage();
    const overrideDir = path.join(tempDir, 'custom-dist');
    await fs.mkdir(overrideDir);
    await fs.writeFile(path.join(overrideDir, 'electron'), '');
    const runInstaller = vi.fn();

    const result = ensureElectronInstall({
      electronPackagePath: path.join(electronDir, 'package.json'),
      env: { ELECTRON_OVERRIDE_DIST_PATH: overrideDir },
      platform: 'linux',
      quiet: true,
      runInstaller,
      strict: true,
    });

    expect(runInstaller).not.toHaveBeenCalled();
    expect(result.installed).toBe(true);
    expect(result.executablePath).toBe(path.join(overrideDir, 'electron'));
    await expect(fs.readFile(result.pathFile, 'utf8')).resolves.toBe('electron');
  });

  async function createLinuxBinary(electronDir: string, version?: string): Promise<void> {
    const distDir = path.join(electronDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, 'electron'), '');
    if (version) {
      await fs.writeFile(path.join(distDir, 'version'), version);
    }
  }

  async function createFakeElectronPackage(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-install-test-'));
    const electronDir = path.join(tempDir, 'electron');
    await fs.mkdir(electronDir, { recursive: true });
    await fs.writeFile(
      path.join(electronDir, 'package.json'),
      '{"name":"electron","version":"44.4.5"}',
      'utf8'
    );
    await fs.writeFile(path.join(electronDir, 'install.js'), '', 'utf8');
    return electronDir;
  }
});
