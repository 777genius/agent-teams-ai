'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(packageRoot, 'build', 'Release');
const output = path.join(outputDirectory, 'desktop_file_lock_native.node');

if (process.argv.includes('--clean')) {
  fs.rmSync(path.join(packageRoot, 'build'), { recursive: true, force: true });
  process.exit(0);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const sources = [
  path.join(packageRoot, 'src', 'addon.cc'),
  path.join(packageRoot, 'src', 'platform_posix.cc'),
  path.join(packageRoot, 'src', 'platform_windows.cc'),
];
const nodeInclude = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
if (!fs.existsSync(path.join(nodeInclude, 'node_api.h'))) {
  throw new Error(`Offline Node headers were not found at ${nodeInclude}`);
}

if (process.platform === 'win32') {
  const compilerArgs = [
    '/nologo',
    '/LD',
    '/EHsc',
    '/std:c++17',
    '/DNAPI_VERSION=8',
    '/DNODE_GYP_MODULE_NAME=desktop_file_lock_native',
    `/I${nodeInclude}`,
    ...sources,
    `/Fe:${output}`,
  ];
  execFileSync(process.env.CXX || 'cl.exe', compilerArgs, { cwd: packageRoot, stdio: 'inherit' });
} else {
  const compilerArgs = [
    '-std=c++17',
    '-O2',
    '-fPIC',
    '-fexceptions',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-DNAPI_VERSION=8',
    '-DNODE_GYP_MODULE_NAME=desktop_file_lock_native',
    `-I${nodeInclude}`,
    process.platform === 'darwin' ? '-bundle' : '-shared',
    ...sources,
    '-o',
    output,
  ];
  if (process.platform === 'darwin') compilerArgs.splice(compilerArgs.indexOf('-bundle') + 1, 0, '-undefined', 'dynamic_lookup');
  execFileSync(process.env.CXX || 'c++', compilerArgs, { cwd: packageRoot, stdio: 'inherit' });
}
