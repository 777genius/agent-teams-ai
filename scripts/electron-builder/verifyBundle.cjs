const path = require('node:path');

const afterPackModule = require('./afterPack.cjs');

const { validateNativeBinaries } = afterPackModule._internal;

function isMacBundle(candidatePath) {
  return (
    candidatePath.endsWith('.app') &&
    require('node:fs').existsSync(path.join(candidatePath, 'Contents', 'MacOS')) &&
    require('node:fs').statSync(path.join(candidatePath, 'Contents', 'MacOS')).isDirectory()
  );
}

function findMacBundles(searchRoot, maxDepth = 3) {
  const fs = require('node:fs');
  if (!fs.existsSync(searchRoot) || maxDepth < 0) {
    return [];
  }

  const stat = fs.statSync(searchRoot);
  if (stat.isDirectory() && isMacBundle(searchRoot)) {
    return [searchRoot];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const bundles = [];
  for (const entry of fs.readdirSync(searchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(searchRoot, entry.name);
    if (isMacBundle(fullPath)) {
      bundles.push(fullPath);
      continue;
    }
    bundles.push(...findMacBundles(fullPath, maxDepth - 1));
  }
  return bundles;
}

function resolveBundlePath(bundlePath, platform) {
  if (platform !== 'darwin' || isMacBundle(bundlePath)) {
    return bundlePath;
  }

  const searchRoots = [
    path.dirname(bundlePath),
    path.dirname(path.dirname(bundlePath)),
    path.resolve(process.cwd(), 'release'),
  ];
  const bundles = [...new Set(searchRoots.flatMap((searchRoot) => findMacBundles(searchRoot)))];
  if (bundles.length === 1) {
    return bundles[0];
  }
  if (bundles.length > 1) {
    const expectedName = path.basename(bundlePath);
    const nameMatch = bundles.find((candidate) => path.basename(candidate) === expectedName);
    if (nameMatch) {
      return nameMatch;
    }
  }

  return bundlePath;
}

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

  const bundlePath = resolveBundlePath(path.resolve(bundlePathArg), platform);
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
