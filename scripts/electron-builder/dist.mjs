#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { buildElectronBuilderInvocations } = require('./dist-invocations.cjs');

export { buildElectronBuilderInvocations };

async function runElectronBuilder(args) {
  const cliPath = require.resolve('electron-builder/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`electron-builder failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

async function main(argv) {
  const invocations = buildElectronBuilderInvocations(argv);

  if (process.env.ELECTRON_BUILDER_DIST_DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        invocations.map((invocation) => invocation.args),
        null,
        2
      )
    );
    return;
  }

  for (const invocation of invocations) {
    await runElectronBuilder(invocation.args);
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPointUrl === import.meta.url) {
  await main(process.argv.slice(2));
}
