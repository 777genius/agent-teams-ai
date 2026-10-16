import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileFunction, constants, runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { safeIpcFailureDetail } from '../../scripts/e2e/opencode-native-desktop-host';
import { serializedFunction } from '../../scripts/e2e/release-updater/serialized-function.mts';
import { redactLaunchFailureArtifactText } from '../../src/main/services/team/TeamLaunchFailureArtifactPack';

const project = (value: string): string =>
  runInNewContext(
    `${serializedFunction(safeIpcFailureDetail)}(${JSON.stringify(value)}, ${serializedFunction(redactLaunchFailureArtifactText)})`
  ) as string;

describe('serialized native IPC failure details', () => {
  it('preserves complete validated acquisition timing from the actual serialized preflight snapshot', async () => {
    const source = await readFile(
      path.resolve('scripts/e2e/opencode-native-windows-preflight.ts'),
      'utf8'
    );
    const ast = ts.createSourceFile('preflight.ts', source, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements
      .filter(ts.isFunctionDeclaration)
      .map((node) => node.getText(ast))
      .join('\n');
    const compiled = ts.transpileModule(declarations, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const snapshot = compileFunction(`${compiled}\nreturn snapshotStartupFailure;`, ['process'], {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })(process) as (
      value: unknown,
      session: string,
      plan: unknown,
      sdkRoot: string,
      launches: unknown[]
    ) => Promise<{
      diagnostics: {
          category: string;
        acquisitionElapsedMs: number | null;
        acquisitionHistory: { phase: string; elapsedMs: number }[];
        acquisitionLastPhase: string | null;
      }[];
    }>;
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-acquisition-timing-')));
    const previousRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME;
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root;
    try {
      const directory = path.join(root, 'opencode/v2/runs', 'a'.repeat(32));
      const diagnostics = path.join(root, 'opencode/v2/provider-diagnostics');
      await mkdir(directory, { recursive: true });
      await mkdir(diagnostics);
      const binding = {
        teamId: 'TEST-acquisition',
        runId: randomUUID(),
        controllerInstanceId: randomUUID(),
        ownerId: randomUUID(),
      };
      await writeFile(
        path.join(directory, 'state.json'),
        JSON.stringify({ binding, state: 'starting', members: [] })
      );
      const diagnostic = path.join(diagnostics, `${randomUUID()}.json`);
      const project = async (acquisition: unknown, category = 'execution_timeout') => {
        await writeFile(
          diagnostic,
          JSON.stringify({
            schemaVersion: 1,
            phase: 'execution-host-startup',
            category,
            acquisition,
          })
        );
        return (await snapshot({ directory, binding }, 'TEST-session', {}, '/TEST-sdk', []))
          .diagnostics[0]!;
      };
      const phases = [
        'preparing',
        'delivery-resolved',
        'profile-validated',
        'native-validated',
        'graph-validated',
        'resolution-prepared',
        'controller-prepared',
        'prepared',
        'mapping',
        'child-bound',
        'start-sent',
        'ready',
        'catalog-ready',
        'auth-ready',
        'selection-ready',
      ];
      const timing = {
        elapsedMs: 180_004,
        history: [
          { phase: 'preparing', elapsedMs: 0 },
          { phase: 'prepared', elapsedMs: 9400 },
          { phase: 'start-sent', elapsedMs: 140_100 },
        ],
      };
      expect(await project(timing)).toMatchObject({
        acquisitionElapsedMs: timing.elapsedMs,
        acquisitionHistory: timing.history,
        acquisitionLastPhase: 'start-sent',
      });
      for (const category of ['run_acquisition_timeout', 'run_initialization_timeout', 'run_stopped', 'cancelled'])
        expect((await project(timing, category)).category).toBe(category);
      expect((await project(timing, 'PRIVATE-TEST-unknown')).category).toBe('unclassified');
      expect(await project({ elapsedMs: 0, history: [timing.history[0]] })).toMatchObject({
        acquisitionElapsedMs: 0,
        acquisitionHistory: [timing.history[0]],
      });
      const all = phases.map((phase, elapsedMs) => ({ phase, elapsedMs }));
      expect(await project({ elapsedMs: 86_400_000, history: all })).toMatchObject({
        acquisitionElapsedMs: 86_400_000,
        acquisitionHistory: all,
        acquisitionLastPhase: 'selection-ready',
      });
      for (const acquisition of [
        null,
        [],
        { ...timing, rawPath: 'PRIVATE-TEST-secret' },
        { ...timing, elapsedMs: -1 },
        { ...timing, elapsedMs: 86_400_001 },
        { ...timing, elapsedMs: 1.5 },
        { ...timing, elapsedMs: '180004' },
        { ...timing, history: [] },
        { ...timing, history: [...all, all[0]] },
        { ...timing, history: [{ phase: 'start-sent', elapsedMs: 0 }] },
        { ...timing, history: [{ phase: 'preparing', elapsedMs: 1 }] },
        { ...timing, history: [timing.history[0], timing.history[0]] },
        { ...timing, history: [timing.history[0], { phase: 'start-sent', elapsedMs: 180_005 }] },
        { ...timing, history: [timing.history[0], { phase: 'unlisted-secret', elapsedMs: 1 }] },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: { toString: 'PRIVATE-TEST-secret' }, elapsedMs: 1 },
          ],
        },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: 'prepared', elapsedMs: 5 },
            { phase: 'start-sent', elapsedMs: 4 },
          ],
        },
        {
          ...timing,
          history: [
            timing.history[0],
            { phase: 'start-sent', elapsedMs: 1, token: 'PRIVATE-TEST-secret' },
          ],
        },
      ]) {
        const actual = await project(acquisition);
        expect(actual).toMatchObject({
          acquisitionElapsedMs: null,
          acquisitionHistory: [],
          acquisitionLastPhase: null,
        });
        expect(JSON.stringify(actual)).not.toMatch(/PRIVATE-TEST|unlisted-secret/);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME;
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['data_root', 'opencode', 'v2', 'runs', 'leaf'])(
    'preserves only the closed native owner role %s',
    (role) => {
      const detail = project(
        `execution_owner_not_private:private_acl_owner_run_${role}:0 /PRIVATE-TEST/path`
      );
      expect(detail).toContain(`[owner role: ${role === 'data_root' ? 'data' : role}]`);
      expect(detail).not.toContain('PRIVATE-TEST');
      expect(project(detail)).toBe(detail);
      expect(project('execution_owner_not_private:private_acl_owner_run_secret:0')).not.toContain(
        '[owner role:'
      );
    }
  );
  it.each(['"', "'", '`'])('redacts truncated and escaped %s arguments', (quote) => {
    for (const tail of [
      ' '.repeat(17_000) + quote,
      ' '.repeat(16_300) + '\\',
      '\\' + quote + ' '.repeat(17_000),
    ]) {
      const detail = project(`Rejected argument: ${quote}confidential-value${tail}`);
      expect(detail).toBe('Rejected argument: [argument]');
      expect(project(detail)).toBe(detail);
    }
  });

  it.each(['"', "'", '`'])('redacts word-prefixed %s arguments', (quote) => {
    expect(project(`Rejected argument: b${quote}confidential-value${quote}`)).toBe(
      'Rejected argument: b[argument]'
    );
    expect(project(`Rejected argument: b${quote}confidential-value${' '.repeat(17_000)}`)).toBe(
      'Rejected argument: b[argument]'
    );
  });

  it('bounds the output', () => {
    expect(project('failure '.repeat(3_000)).length).toBeLessThanOrEqual(500);
  });

  it('does not expose quoted arguments after contractions', () => {
    const detail = project("couldn't resolve module 'confidential-value'");
    expect(detail).not.toContain('confidential-value');
    expect(project(detail)).toBe(detail);
  });

  it('redacts provider keys and absolute paths before transport', () => {
    const detail = project(
      `ENOENT: open "C:\\PRIVATE-TEST\\private.txt" OPENROUTER_API_KEY=sk-or-v1-${'a'.repeat(64)}`
    );
    expect(detail).toContain('ENOENT');
    expect(detail).not.toContain('PRIVATE-TEST');
    expect(detail).not.toContain('sk-or-v1-');
    expect(project('EACCES: mkdir \\\\PRIVATE-SERVER\\PRIVATE-SHARE')).not.toContain('PRIVATE');
    expect(project('EPERM: open /PRIVATE-USER/secret')).not.toContain('PRIVATE');
  });
});
