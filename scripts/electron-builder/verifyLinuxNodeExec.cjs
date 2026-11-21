const path = require('node:path');
const { realpathSync } = require('node:fs');

/** Check the actual copied Linux resource before packaging/signing the bundle. */
async function verifyPackagedLinuxNodeExec(context) {
  if (context.electronPlatformName !== 'linux') return;
  if (context.arch !== 1) throw new Error('The Linux Node launcher is qualified only for x64');
  const { captureLinuxNodeExecArtifact } = await import('../../src/main/utils/linuxNodeExecArtifact.ts');
  const source = captureLinuxNodeExecArtifact(
    realpathSync(path.join(__dirname, '../../resources/process-launch/linux-x64'))
  );
  const packaged = captureLinuxNodeExecArtifact(
    realpathSync(path.join(context.appOutDir, 'resources/process-launch/linux-x64'))
  );
  if (source.manifestSha256 !== packaged.manifestSha256 ||
      source.binarySha256 !== packaged.binarySha256)
    throw new Error('The packaged Linux Node launcher differs from the selected build artifact');
}
module.exports = { verifyPackagedLinuxNodeExec };
