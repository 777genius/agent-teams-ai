'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const source = path.join(packageRoot, 'src', 'platform_windows.cc');
const text = fs.readFileSync(source, 'utf8');
for (const required of [
  '#ifdef _WIN32',
  'NtCreateFile',
  'FILE_OPEN_REPARSE_POINT',
  'LockFileEx',
  'UnlockFileEx',
  'FlushFileBuffers',
  'RenameNoReplace',
  'GetDriveTypeW',
]) {
  if (!text.includes(required)) throw new Error(`Windows source is missing ${required}`);
}

const compiler = process.env.CXX || 'c++';
execFileSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', source], {
  cwd: packageRoot,
  stdio: 'inherit',
});

const mingwCompiler = process.env.MINGW_CXX || [
  '/usr/bin/x86_64-w64-mingw32-g++',
  '/usr/local/bin/x86_64-w64-mingw32-g++',
].find((candidate) => fs.existsSync(candidate));
if (mingwCompiler) {
  const nodeInclude = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
  execFileSync(mingwCompiler, [
    '-std=c++17',
    '-D_WIN32',
    `-I${nodeInclude}`,
    '-fsyntax-only',
    source,
  ], { cwd: packageRoot, stdio: 'inherit' });
  console.log('Windows source compiled with MinGW.');
} else {
  console.log('SKIP: MinGW is unavailable; verified inactive guard and required Windows primitives.');
}
