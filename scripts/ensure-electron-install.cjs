const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getPlatformPath() {
  const platform = process.env.npm_config_platform || os.platform();

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

function ensurePathFile(electronDir, platformPath) {
  const pathFile = path.join(electronDir, 'path.txt');
  const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');
  const executablePath = path.join(distPath, platformPath);

  if (!fs.existsSync(executablePath)) {
    return false;
  }

  const currentPath = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8') : '';
  if (currentPath !== platformPath) {
    fs.writeFileSync(pathFile, platformPath);
  }
  return true;
}

function runElectronInstaller(installPath) {
  const result = childProcess.spawnSync(process.execPath, [installPath], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`Electron installer failed with exit code ${result.status ?? 'unknown'}`);
  }
}

const electronPackagePath = require.resolve('electron/package.json');
const electronDir = path.dirname(electronPackagePath);
const installPath = path.join(electronDir, 'install.js');
const platformPath = getPlatformPath();

if (!ensurePathFile(electronDir, platformPath)) {
  runElectronInstaller(installPath);
}

if (!ensurePathFile(electronDir, platformPath)) {
  throw new Error(`Electron binary is missing after install: ${platformPath}`);
}
