const path = require('node:path');

const afterPackModule = require('./afterPack.cjs');

const { validateNativeBinaries } = afterPackModule._internal;

function isAllowedPostPackMismatch(mismatch, platform, arch) {
  const relativePath = mismatch.path.split(path.sep).join('/');
  return (
    platform === 'win32' &&
    arch === 'x64' &&
    relativePath === 'resources/elevate.exe' &&
    mismatch.format === 'pe' &&
    mismatch.archs.length === 1 &&
    mismatch.archs[0] === 'ia32'
  );
}

async function main() {
  const [bundlePathArg, platform, arch] = process.argv.slice(2);

  if (!bundlePathArg || !platform || !arch) {
    console.error('Usage: node ./scripts/electron-builder/verifyBundle.cjs <bundlePath> <platform> <arch>');
    process.exit(1);
  }

  const bundlePath = path.resolve(bundlePathArg);
  const mismatches = await validateNativeBinaries(bundlePath, platform, arch);
  const blockingMismatches = mismatches.filter(
    (mismatch) => !isAllowedPostPackMismatch(mismatch, platform, arch)
  );

  if (blockingMismatches.length === 0) {
    const allowedCount = mismatches.length - blockingMismatches.length;
    const suffix =
      allowedCount > 0 ? ` (${allowedCount} allowed post-pack helper mismatch ignored)` : '';
    console.log(`[verifyBundle] OK ${platform}-${arch}: ${bundlePath}${suffix}`);
    return;
  }

  console.error(
    `[verifyBundle] Found ${blockingMismatches.length} incompatible native binaries in ${platform}-${arch}: ${bundlePath}`
  );
  for (const mismatch of blockingMismatches.slice(0, 50)) {
    console.error(`- ${mismatch.path} [${mismatch.format}] -> ${mismatch.archs.join(', ')}`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
