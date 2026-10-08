import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFunction, createContext } from 'node:vm';

import { macMigrationState } from './mac-migration-state.mts';

import type { Cdp } from './cdp.mts';

// Protocol peer executes the transported function against asynchronous public APIs.
// This catches unsafe interpolation, a missing await, lost project/team data and leaked CDP objects.
function peer(fail = false, existingProjects: string[] = []) {
  const projectPath = "/TEST/project-'\\quoted";
  const teamName = "TEST-team');throw Error('injected";
  let theme = 'system';
  const projects = [...existingProjects];
  let released = 0;
  const operations: string[] = [];
  const api = {
    config: {
      async update(section: string, value: { theme: string }) {
        assert.equal(section, 'general');
        assert.deepEqual(Object.keys(value), ['theme']);
        operations.push('theme-update');
        await Promise.resolve();
        theme = value.theme;
      },
      async addCustomProjectPath(value: string) {
        operations.push('project-add');
        await Promise.resolve();
        if (!projects.includes(value)) projects.push(value);
      },
      async get() {
        await Promise.resolve();
        if (fail) throw new Error('public config failure');
        return { general: { theme, customProjectPaths: projects } };
      },
    },
    teams: {
      async list() {
        await Promise.resolve();
        return [{ teamName, projectPath, memberCount: 0 }];
      },
    },
  };
  const client: Pick<Cdp, 'send'> = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'Runtime.evaluate') {
        assert.equal(params.expression, 'window.electronAPI');
        return { result: { objectId: 'owned-api' } } as T;
      }
      assert.equal(params.objectId, 'owned-api');
      if (method === 'Runtime.releaseObject') {
        released++;
        return {} as T;
      }
      assert.equal(method, 'Runtime.callFunctionOn');
      assert.equal(params.awaitPromise, true);
      assert.equal(params.returnByValue, true);
      // Only the imported harness supplies source; caller data remains in CDP value arguments.
      const call = compileFunction(
        'return (' + String(params.functionDeclaration) + ').apply(api,args)',
        ['api', 'args'],
        { parsingContext: createContext({}) }
      ) as (publicApi: typeof api, args: unknown[]) => Promise<unknown>;
      try {
        const args = (params.arguments as { value: unknown }[]).map((item) => item.value);
        const value = await call(api, args);
        return { result: value === undefined ? {} : { value: JSON.parse(JSON.stringify(value)) as unknown } } as T;
      } catch (error) {
        return { exceptionDetails: String(error), result: {} } as T;
      }
    },
  };
  return { client, projectPath, teamName, operations, released: () => released };
}
void test('seeds and reads passive migration state through value-only CDP arguments', async () => {
  const p = peer();
  const expected = {
    theme: 'light',
    projectPaths: [p.projectPath],
    team: { teamName: p.teamName, projectPath: p.projectPath, memberCount: 0 },
  };
  assert.deepEqual(
    await macMigrationState(p.client, p.teamName, {
      theme: 'light',
      projectPath: p.projectPath,
    }),
    expected
  );
  assert.deepEqual(await macMigrationState(p.client, p.teamName), expected);
  assert.equal(p.released(), 2);
});
void test('public API errors fail migration proof and still release the remote object', async () => {
  const p = peer(true);
  await assert.rejects(macMigrationState(p.client, p.teamName), /public config failure/);
  assert.equal(p.released(), 1);
});

void test('seed waits for durable theme barrier before issuing the second public config write', async () => {
  const p = peer(false, ['/TEST-existing']);
  let persisted = false;
  const result = await macMigrationState(p.client, p.teamName, { theme: 'light', projectPath: p.projectPath }, async () => {
    assert.deepEqual(p.operations, ['theme-update']);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(p.operations, ['theme-update']);
    persisted = true;
  });
  assert.equal(persisted, true);
  assert.deepEqual(p.operations, ['theme-update', 'project-add']);
  assert.deepEqual(result.projectPaths, ['/TEST-existing', p.projectPath]);
  assert.equal(p.released(), 1);
});
void test('failed theme persistence prevents project write and still releases the remote API', async () => {
  const p = peer();
  await assert.rejects(macMigrationState(p.client, p.teamName, { theme: 'light', projectPath: p.projectPath }, () => Promise.reject(new Error('owned theme persistence failed'))), /owned theme persistence failed/);
  assert.deepEqual(p.operations, ['theme-update']);
  assert.equal(p.released(), 1);
});
