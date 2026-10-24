const { prepareCpuFeaturesRebuild } = require('./prepare-cpu-features-rebuild.cjs');
const { ensureElectronInstall } = require('./ensure-electron-install.cjs');

const NATIVE_MODULES = ['node-pty', 'ssh2', 'cpu-features', 'better-sqlite3'];

async function rebuildNativeModules(modules = NATIVE_MODULES) {
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: process.cwd(),
    electronVersion: require('electron/package.json').version,
    force: true,
    onlyModules: modules,
  });
}

async function postinstallElectron(input = {}) {
  const profile = input.profile ?? process.env.AGENT_TEAMS_INSTALL_PROFILE ?? 'desktop';
  if (profile !== 'desktop' && profile !== 'node-ci') {
    throw new Error(`Unknown install profile: ${profile}`);
  }
  // Node-only checks use the dependencies' Node builds, without Electron's ABI.
  if (profile === 'node-ci') return;

  const prepare = input.prepare ?? prepareCpuFeaturesRebuild;
  const rebuild = input.rebuild ?? rebuildNativeModules;
  const ensure = input.ensure ?? ensureElectronInstall;
  const logger = input.logger ?? console;

  let modules = NATIVE_MODULES;
  try {
    prepare();
  } catch (error) {
    modules = NATIVE_MODULES.filter((module) => module !== 'cpu-features');
    logger.warn(
      `Optional cpu-features rebuild preparation failed: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    await rebuild(modules);
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
