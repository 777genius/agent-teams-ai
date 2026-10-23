import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileFunction } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type PumpFailure = {
  category: string;
  controlPhase: string;
  controlCode: string;
  nativeCode: number;
};

const harness = path.resolve('scripts/e2e/opencode-native-windows-full.ts');
const projection = async (): Promise<(value: unknown) => PumpFailure | null> => {
  const source = await readFile(harness, 'utf8');
  const ast = ts.createSourceFile('windows-full.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === 'projectRunControlPumpFailure')!;
  const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileFunction(`${compiled}\nreturn projectRunControlPumpFailure;`)() as (
    value: unknown
  ) => PumpFailure | null;
};

const record = {
  schemaVersion: 1,
  event: 'opencode_v2_run_control_failure',
  binding: { teamId: 'test-opencode-PRIVATE', runId: 'PRIVATE-run' },
  category: 'run_control_pump_failed',
  controlPhase: 'read_frame',
  controlCode: 'run_control_disconnected',
  nativeCode: 109,
  timestamp: '2026-10-19T00:00:00.000Z',
};

describe('closed run-control pump failure projection', () => {
  it('projects exactly the closed pump facts and drops the timestamp and binding', async () => {
    const project = await projection();
    const projected = project(record);
    expect(projected).toEqual({
      category: 'run_control_pump_failed',
      controlPhase: 'read_frame',
      controlCode: 'run_control_disconnected',
      nativeCode: 109,
    });
    expect(Object.keys(projected!)).toEqual([
      'category',
      'controlPhase',
      'controlCode',
      'nativeCode',
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/timestamp|binding|PRIVATE|2026/);
  });

  it('refuses every non-closed value instead of leaking a raw string', async () => {
    const project = await projection();
    for (const patch of [
      { category: 'run_control_pump_failed_private' },
      { category: undefined },
      { category: 'run_operation_unknown' },
      { controlPhase: 'read_frame PRIVATE_PATH' },
      { controlPhase: 'exfiltrate' },
      { controlPhase: undefined },
      { controlCode: 'run_control_foreign:connect:2' },
      { controlCode: 'C:\\PRIVATE_PATH' },
      { controlCode: undefined },
      { nativeCode: -1 },
      { nativeCode: 4294967296 },
      { nativeCode: 1.5 },
      { nativeCode: '109' },
      { nativeCode: null },
    ])
      expect(project({ ...record, ...patch })).toBeNull();
    expect(project(null)).toBeNull();
    expect(project('run_control_pump_failed')).toBeNull();
    expect(project([{ ...record }])).toBeNull();
  });

  it('publishes the closed projection in the failure capture proof', async () => {
    const source = await readFile(harness, 'utf8');
    expect(source).toContain('pumpFailure: null as null |');
    // Read for every failed V2 run, not only when a native transcript session exists.
    expect(source).toMatch(
      /if \(version\.startsWith\('2\.'\) && proof\.runIds\.length\) \{[^}]*proof\.pumpFailure = await Promise\.race\(\[\s*readRunControlPumpFailure\(/
    );
    expect(source).toContain("path.join(dataRoot, 'opencode', 'v2', 'runs')");
  });
});
