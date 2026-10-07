import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { macMigrationState } from './mac-migration-state.mts';

import type { Cdp } from './cdp.mts';

// Protocol peer executes the transported function against asynchronous public APIs.
// This catches unsafe interpolation, a missing await, lost project/team data and leaked CDP objects.
function peer(fail = false) {
  const projectPath = "/TEST/project-'\\quoted";
  const teamName = "TEST-team');throw Error('injected";
  let theme = 'system';
  const projects: string[] = [];
  let released = 0;
  const api = {
    config: {
      async update(section: string, value: { theme: string }) {
        assert.equal(section, 'general');
        await Promise.resolve();
        theme = value.theme;
      },
      async addCustomProjectPath(value: string) {
        await Promise.resolve();
        projects.push(value);
      },
      async get() {
        if (fail) throw new Error('public config failure');
        return { general: { theme, customProjectPaths: projects } };
      },
    },
    teams: {
      async list() {
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
      const call = runInNewContext('(' + String(params.functionDeclaration) + ')') as (
        ...args: unknown[]
      ) => Promise<unknown>;
      try {
        const args = (params.arguments as { value: unknown }[]).map((item) => item.value);
        return { result: { value: JSON.parse(JSON.stringify(await call.apply(api, args))) } } as T;
      } catch (error) {
        return { exceptionDetails: String(error), result: {} } as T;
      }
    },
  };
  return { client, projectPath, teamName, released: () => released };
}
test('seeds and reads passive migration state through value-only CDP arguments', async () => {
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
test('public API errors fail migration proof and still release the remote object', async () => {
  const p = peer(true);
  await assert.rejects(macMigrationState(p.client, p.teamName), /public config failure/);
  assert.equal(p.released(), 1);
});
