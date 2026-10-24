const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function prepareCpuFeaturesRebuild() {
  const requireFromSsh2 = createRequire(require.resolve('ssh2/package.json'));
  let cpuFeaturesPackagePath;
  try {
    cpuFeaturesPackagePath = requireFromSsh2.resolve('cpu-features/package.json');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return false;
    throw error;
  }

  const packageDir = path.dirname(cpuFeaturesPackagePath);
  const buildConfig = execFileSync(process.execPath, [path.join(packageDir, 'buildcheck.js')], {
    cwd: packageDir,
  });
  writeFileSync(path.join(packageDir, 'buildcheck.gypi'), buildConfig);
  return true;
}

if (require.main === module) {
  prepareCpuFeaturesRebuild();
}

module.exports = { prepareCpuFeaturesRebuild };
