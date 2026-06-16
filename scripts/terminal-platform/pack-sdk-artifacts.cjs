#!/usr/bin/env node

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', '..');
const terminalPlatformRoot = path.resolve(
  process.env.CLAUDE_TERMINAL_PLATFORM_ROOT ||
    process.env.TERMINAL_PLATFORM_ROOT ||
    path.join(appRoot, '..', 'terminal-platform')
);
const sdkRoot = path.join(terminalPlatformRoot, 'sdk');
const vendorRoot = path.join(appRoot, 'vendor', 'terminal-platform');
const vendorSdkRoot = path.join(vendorRoot, 'sdk');

const packages = [
  { name: '@terminal-platform/design-tokens', dir: 'design-tokens' },
  { name: '@terminal-platform/foundation', dir: 'foundation' },
  { name: '@terminal-platform/runtime-types', dir: 'runtime-types' },
  { name: '@terminal-platform/workspace-adapter-websocket', dir: 'workspace-adapter-websocket' },
  { name: '@terminal-platform/workspace-contracts', dir: 'workspace-contracts' },
  { name: '@terminal-platform/workspace-core', dir: 'workspace-core' },
  { name: '@terminal-platform/workspace-elements', dir: 'workspace-elements' },
  { name: '@terminal-platform/workspace-gateway-node', dir: 'workspace-gateway-node' },
  { name: '@terminal-platform/workspace-react', dir: 'workspace-react' },
];

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return childProcess.execFileSync(command, args, {
    cwd: options.cwd || appRoot,
    encoding: options.encoding || 'utf8',
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function runBin(command, args, options = {}) {
  return run(process.platform === 'win32' ? `${command}.cmd` : command, args, options);
}

function assertTerminalPlatformCheckout() {
  if (!fs.existsSync(path.join(sdkRoot, 'package.json'))) {
    throw new Error(`terminal-platform SDK was not found at ${sdkRoot}`);
  }
}

function cleanVendorSdkRoot() {
  fs.rmSync(vendorSdkRoot, { recursive: true, force: true });
  fs.mkdirSync(vendorSdkRoot, { recursive: true });
}

function packSdkPackages() {
  for (const pkg of packages) {
    const cwd = path.join(sdkRoot, 'packages', pkg.dir);
    const output = runBin('npm', ['pack', '--json', '--pack-destination', vendorSdkRoot], {
      cwd,
      capture: true,
    });
    const [entry] = JSON.parse(output);
    console.log(`packed ${pkg.name} -> ${entry.filename}`);
  }
}

function getSourceRef() {
  return run('git', ['-C', terminalPlatformRoot, 'rev-parse', 'HEAD'], {
    capture: true,
  }).trim();
}

function writeManifest(sourceRef) {
  const manifest = {
    sourceRepository: 'https://github.com/777genius/terminal-platform',
    sourceRef,
    packages: packages.map((pkg) => pkg.name),
    nativePackage: {
      name: 'terminal-platform-node',
      kind: 'install-time stub',
      note: 'Set CLAUDE_TERMINAL_PLATFORM_ROOT to a built terminal-platform checkout to use the native runtime locally.',
    },
  };
  fs.writeFileSync(
    path.join(vendorRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

assertTerminalPlatformCheckout();
runBin('npm', ['ci'], { cwd: sdkRoot });
runBin('npm', ['run', 'build'], { cwd: sdkRoot });
cleanVendorSdkRoot();
packSdkPackages();
writeManifest(getSourceRef());
