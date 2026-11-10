#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fail(message, error) {
  console.error(`[better-sqlite3-node] ${message}`);
  if (error) {
    console.error(error);
  }
  process.exit(1);
}

let packageRoot;
try {
  packageRoot = path.dirname(require.resolve('better-sqlite3-node/package.json'));
} catch (error) {
  fail('failed to resolve package root', error);
}

fs.rmSync(path.join(packageRoot, 'build'), { recursive: true, force: true });

const env = { ...process.env };
delete env.npm_config_runtime;
delete env.npm_config_target;
delete env.npm_config_disturl;
delete env.npm_config_arch;
delete env.npm_config_target_arch;
delete env.npm_config_target_platform;
delete env.npm_config_build_from_source;

const rebuild = spawnSync('npm', ['rebuild'], {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (rebuild.status !== 0) {
  fail(`npm rebuild failed with status ${rebuild.status ?? 'unknown'}`);
}

try {
  const Database = require('better-sqlite3-node');
  const db = new Database(':memory:');
  const row = db.prepare('select 1 as ok').get();
  db.close();
  if (row?.ok !== 1) {
    fail('sqlite smoke query returned unexpected result');
  }
} catch (error) {
  fail('sqlite smoke query failed after rebuild', error);
}

console.log('[better-sqlite3-node] Node ABI rebuild verified');
