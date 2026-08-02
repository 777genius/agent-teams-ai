#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  runWithNativeDependencyRestore,
} = require('./dist-invocations.cjs');

export {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  runWithNativeDependencyRestore,
};

async function rebuildNativeDependencies(plan, action = 'rebuilding') {
  const { rebuild } = await import('@electron/rebuild');
  const electronVersion = require('electron/package.json').version;

  console.log(
    `[electron-builder] ${action} ${plan.modules.join(', ')} for ${plan.platform}-${plan.arch}`
  );
  await rebuild({
    buildPath: process.cwd(),
    electronVersion,
    platform: plan.platform,
    arch: plan.arch,
    onlyModules: plan.modules,
    force: true,
  });
}

async function runElectronBuilderInvocation(invocation) {
  const targetPlan = buildNativeRebuildPlan(invocation.args);
  if (!targetPlan) {
    await runElectronBuilder(invocation.args);
    return;
  }

  const restorePlan = buildNativeRestorePlan(targetPlan, process.platform, process.arch);
  await runWithNativeDependencyRestore({
    targetPlan,
    restorePlan,
    rebuild: (plan, phase) =>
      rebuildNativeDependencies(plan, phase === 'restore' ? 'restoring' : 'rebuilding'),
    packageTarget: () => runElectronBuilder(invocation.args),
  });
}

async function runRendererBundleGuard() {
  const guardPath = fileURLToPath(
    new URL('../ci/verify-radix-renderer-bundle.mjs', import.meta.url)
  );
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardPath], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`renderer bundle guard failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

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

  await runRendererBundleGuard();

  for (const invocation of invocations) {
    await runElectronBuilderInvocation(invocation);
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPointUrl === import.meta.url) {
  await main(process.argv.slice(2));
}
