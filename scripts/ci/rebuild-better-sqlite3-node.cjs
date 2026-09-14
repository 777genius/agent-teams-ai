#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global console, process, require */

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

const packages = ['better-sqlite3', 'better-sqlite3-node'].map((packageName) => {
  try {
    return {
      packageName,
      packageRoot: path.dirname(require.resolve(`${packageName}/package.json`)),
    };
  } catch (error) {
    fail(`failed to resolve ${packageName} package root`, error);
  }
});

const env = { ...process.env };
delete env.npm_config_runtime;
delete env.npm_config_target;
delete env.npm_config_disturl;
delete env.npm_config_arch;
delete env.npm_config_target_arch;
delete env.npm_config_target_platform;
delete env.npm_config_build_from_source;

for (const { packageName, packageRoot } of packages) {
  fs.rmSync(path.join(packageRoot, 'build'), { recursive: true, force: true });

  const rebuild = spawnSync('npm', ['rebuild'], {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (rebuild.status !== 0) {
    fail(`${packageName} npm rebuild failed with status ${rebuild.status ?? 'unknown'}`);
  }

  try {
    const Database = require(packageName);
    const db = new Database(':memory:');
    const row = db.prepare('select 1 as ok').get();
    db.close();
    if (row?.ok !== 1) {
      fail(`${packageName} sqlite smoke query returned unexpected result`);
    }
  } catch (error) {
    fail(`${packageName} sqlite smoke query failed after rebuild`, error);
  }

  console.log(`[better-sqlite3-node] ${packageName} Node ABI rebuild verified`);
}
