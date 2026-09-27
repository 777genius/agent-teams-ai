const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findExecutable, resolveBundlePath } = require('./smokePackagedApp.cjs')._internal;

function main() {
  const [bundleArg, platform] = process.argv.slice(2);
  if (!bundleArg || !['darwin', 'win32', 'linux'].includes(platform)) {
    throw new Error('Usage: smokePackagedNative.cjs <bundle> <darwin|win32|linux>');
  }

  const bundle = resolveBundlePath(path.resolve(bundleArg), platform);
  const executable = findExecutable(bundle, platform);
  const resources = path.join(
    bundle,
    ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources'])
  );
  const appAsar = path.join(resources, 'app.asar');
  if (!fs.existsSync(appAsar)) throw new Error(`Packaged app.asar is missing: ${appAsar}`);

  const testProject = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-native-test-'));
  fs.writeFileSync(path.join(testProject, '.test-only'), 'electron-native-test-v1');
  const script = `
    const path = require('node:path');
    const [appAsar, project] = process.argv.slice(1);
    const pty = require(path.join(appAsar, 'node_modules', 'node-pty'));
    const Database = require(path.join(appAsar, 'node_modules', 'better-sqlite3'));
    require(path.join(appAsar, 'node_modules', 'ssh2'));
    const db = new Database(':memory:');
    if (db.prepare('select 1 as value').get().value !== 1) process.exit(3);
    db.close();
    const windows = process.platform === 'win32';
    const command = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = windows ? ['/d', '/s', '/c', 'echo pty-ok'] : ['-c', 'printf pty-ok'];
    const child = pty.spawn(command, args, {
      cwd: project,
      env: { ...process.env, HOME: project, USERPROFILE: project },
      cols: 80,
      rows: 24,
    });
    let output = '';
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !output.includes('pty-ok')) process.exit(4);
      console.log('PACKAGED_NATIVE_OK ' + JSON.stringify({ electron: process.versions.electron, node: process.versions.node }));
    });
    setTimeout(() => process.exit(5), 10000).unref();
  `;

  try {
    const result = spawnSync(executable, ['-e', script, appAsar, testProject], {
      cwd: testProject,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOME: testProject,
        USERPROFILE: testProject,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !result.stdout.includes('PACKAGED_NATIVE_OK')) {
      throw new Error(
        `Packaged native module smoke failed (${result.status}): ${result.stderr}\n${result.stdout}`
      );
    }
    console.log(`[smokePackagedNative] OK ${platform}: ${result.stdout.trim()}`);
  } finally {
    fs.rmSync(testProject, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
