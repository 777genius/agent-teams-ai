const { prepareCpuFeaturesRebuild } = require('./prepare-cpu-features-rebuild.cjs');
const { ensureElectronInstall } = require('./ensure-electron-install.cjs');

async function rebuildNativeModules() {
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: process.cwd(),
    electronVersion: require('electron/package.json').version,
    force: true,
    onlyModules: ['node-pty', 'ssh2', 'cpu-features', 'better-sqlite3'],
  });
}

async function postinstallElectron(input = {}) {
  const prepare = input.prepare ?? prepareCpuFeaturesRebuild;
  const rebuild = input.rebuild ?? rebuildNativeModules;
  const ensure = input.ensure ?? ensureElectronInstall;
  const logger = input.logger ?? console;

  try {
    prepare();
    await rebuild();
  } catch (error) {
    logger.warn(
      `Native Electron rebuild failed: ${error instanceof Error ? error.message : error}`
    );
  }

  ensure({ strict: true });
}

if (require.main === module) {
  postinstallElectron().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { postinstallElectron };
