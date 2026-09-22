const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getPlatformPath(input = {}) {
  const env = input.env ?? process.env;
  const platform = env.npm_config_platform || input.platform || os.platform();

  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

function getElectronPaths(electronDir, platformPath, env = process.env) {
  const pathFile = path.join(electronDir, 'path.txt');
  const distPath = env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');
  const executablePath = path.join(distPath, platformPath);

  return { executablePath, pathFile };
}

function ensurePathFile(electronDir, platformPath, input = {}) {
  const fsAdapter = input.fs ?? fs;
  const env = input.env ?? process.env;
  const { pathFile } = getElectronPaths(electronDir, platformPath, env);

  const currentPath = fsAdapter.existsSync(pathFile) ? fsAdapter.readFileSync(pathFile, 'utf8') : '';
  if (currentPath !== platformPath) {
    fsAdapter.writeFileSync(pathFile, platformPath);
  }
}

function runElectronInstaller(installPath, input = {}) {
  const spawnSync = input.spawnSync ?? childProcess.spawnSync;
  const execPath = input.execPath ?? process.execPath;
  const env = input.env ?? process.env;
  const result = spawnSync(execPath, [installPath], {
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Electron installer failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function resolveElectronPackagePath(input = {}) {
  if (input.electronPackagePath) {
    return input.electronPackagePath;
  }

  return require.resolve('electron/package.json');
}

function ensureElectronInstall(input = {}) {
  const fsAdapter = input.fs ?? fs;
  const logger = input.logger ?? console;
  const env = input.env ?? process.env;
  const strict = Boolean(input.strict);
  const electronPackagePath = resolveElectronPackagePath(input);
  const electronDir = path.dirname(electronPackagePath);
  const installPath = path.join(electronDir, 'install.js');
  const platformPath = getPlatformPath({ env, platform: input.platform });
  const { executablePath, pathFile } = getElectronPaths(electronDir, platformPath, env);

  if (!fsAdapter.existsSync(executablePath)) {
    if (!input.quiet) {
      logger.warn(`Electron binary is missing, running installer: ${executablePath}`);
    }
    const runInstaller = input.runInstaller ?? runElectronInstaller;
    runInstaller(installPath, {
      env,
      execPath: input.execPath,
      spawnSync: input.spawnSync,
    });
  }

  ensurePathFile(electronDir, platformPath, { env, fs: fsAdapter });

  const installed = fsAdapter.existsSync(executablePath);
  if (!installed) {
    const message = `Electron binary is missing after install: ${executablePath}`;
    if (strict) {
      throw new Error(`${message}\nWrote Electron import marker: ${pathFile}`);
    }
    logger.warn(message);
    logger.warn(`Wrote Electron import marker: ${pathFile}`);
  }

  return {
    electronDir,
    executablePath,
    installed,
    pathFile,
    platformPath,
  };
}

function main() {
  const strict = process.argv.includes('--strict');

  try {
    ensureElectronInstall({ strict });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ensureElectronInstall,
  ensurePathFile,
  getElectronPaths,
  getPlatformPath,
  runElectronInstaller,
};
