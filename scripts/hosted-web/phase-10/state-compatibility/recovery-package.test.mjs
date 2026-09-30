import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const recoveryDirectory = 'scripts/hosted-web/phase-10/state-compatibility';
const cli = `${recoveryDirectory}/stopped-stack-recovery.mjs`;
const descriptorIo = `${recoveryDirectory}/recovery-descriptor-io.mjs`;
const packagedCli = `/app/${cli}`;
const probe = `
  await import(${JSON.stringify(packagedCli)});
  const { default: Database } = await import('better-sqlite3');
  const database = new Database(':memory:');
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') process.exitCode = 1;
  } finally {
    database.close();
  }
`;

test('production stage packages the CLI, its relative I/O module, and checks native SQLite', async () => {
  const dockerfile = await readFile(resolve(root, 'docker/Dockerfile'), 'utf8');
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM base\n') + 1);
  assert.ok(finalStage.startsWith('FROM base\n'), 'final production stage must be found');
  assert.ok(
    finalStage.includes(
      `COPY ${cli} ${descriptorIo} ./${recoveryDirectory}/`
    ),
    'both recovery modules must be copied into their import-relative production path'
  );
  assert.ok(finalStage.includes(`node --check ${packagedCli}`));
  assert.ok(finalStage.includes(`node --check /app/${descriptorIo}`));
  assert.ok(finalStage.includes('await import(\'better-sqlite3\')'));
  assert.ok(finalStage.includes('&& rm -r /app/scripts/ci'));
  assert.ok(!finalStage.includes('COPY . .'), 'runtime stage must remain scoped');

  for (const script of [cli, descriptorIo]) {
    const result = spawnSync(process.execPath, ['--check', resolve(root, script)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('the two-file recovery artifact imports without starting the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-recovery-package-'));
  try {
    await Promise.all(
      [cli, descriptorIo].map((script) =>
        copyFile(resolve(root, script), join(directory, script.split('/').at(-1)))
      )
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(directory, 'stopped-stack-recovery.mjs')).href)})`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'built production image loads the packaged CLI and native SQLite driver',
  { skip: !process.env.HOSTED_RECOVERY_TEST_IMAGE },
  () => {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        '/usr/local/bin/node',
        process.env.HOSTED_RECOVERY_TEST_IMAGE,
        '--input-type=module',
        '-e',
        probe,
      ],
      { encoding: 'utf8', timeout: 90_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
);
