import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('catalog fixture subprocess returns four sources, failures, partial models and recovery; refuses mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-catalog-test-'));
  try {
    const fixture = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), fixture);
    const run = (args) =>
      spawnSync(process.execPath, [fixture, 'orchestrator', ...args], {
        encoding: 'utf8',
        timeout: 5000,
      });
    for (const scenario of [
      'directory-error',
      'models-four-errors',
      'partial-success',
      'catalog-retry',
    ]) {
      await writeFile(path.join(root, 'scenario'), scenario);
      const directory = run([
        'runtime',
        'providers',
        'directory',
        '--runtime',
        'opencode',
        '--json',
        '--summary',
        '--filter',
        'all',
        '--limit',
        '100',
        '--refresh',
      ]);
      assert.equal(directory.status, 0, directory.stderr);
      const result = JSON.parse(directory.stdout);
      assert.equal(Boolean(result.error), scenario === 'directory-error');
      if (result.directory) assert.equal(result.directory.entries.length, 4);
      for (const source of ['opencode', 'anthropic', 'google', 'openrouter']) {
        const models = run([
          'runtime',
          'providers',
          'models',
          '--runtime',
          'opencode',
          '--provider',
          source,
          '--json',
        ]);
        assert.equal(models.status, 0, models.stderr);
        const value = JSON.parse(models.stdout);
        assert.equal(
          Boolean(value.error),
          scenario === 'models-four-errors' ||
            (scenario === 'partial-success' && source !== 'opencode')
        );
        if (value.models) assert.equal(value.models.models[0].providerId, source);
      }
    }
    for (const args of [
      ['runtime', 'status', '--json', '--summary', '--provider', 'opencode'],
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ]) {
      const status = run(args);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).providers.opencode.authenticated, true);
    }
    for (const args of [
      [
        'runtime',
        'providers',
        'models',
        '--runtime',
        'opencode',
        '--provider',
        'opencode',
        '--json',
        '--execute',
      ],
      [
        'runtime',
        'providers',
        'directory',
        '--runtime',
        'opencode',
        '--json',
        '--project-path',
        '/real-project',
      ],
      ['team', 'launch'],
    ])
      assert.equal(run(args).status, 64);
    const events = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    for (const event of events.filter((e) => e.event === 'response')) {
      const start = events.find((e) => e.event === 'start' && e.pid === event.pid);
      assert(start && start.at <= event.at && start.scenario === event.scenario);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delayed summary exercises runtime status budget, not directory latency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-summary-test-'));
  try {
    const fixture = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), fixture);
    await writeFile(path.join(root, 'scenario'), 'delayed8s');
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        fixture,
        'orchestrator',
        'runtime',
        'status',
        '--json',
        '--summary',
        '--provider',
        'opencode',
      ],
      { encoding: 'utf8', timeout: 12000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert(Date.now() - started >= 7900);
    assert.equal(JSON.parse(result.stdout).providers.opencode.authenticated, true);
    const events = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events[1].operation, 'status');
    assert(events[1].at - events[0].at >= 7900);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
