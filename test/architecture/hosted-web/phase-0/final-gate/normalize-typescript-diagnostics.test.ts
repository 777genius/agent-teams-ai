import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyProcessDisposition,
  evaluateCapturedGate,
  evaluateCompilerResult,
  normalizeDiagnostics,
  parseTypeScriptDiagnostics,
  type TypeScriptDiagnostic,
} from '../../../../../scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../'
);
const baseline = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      'docs/research/hosted-web/phase-0/final-gate/inherited-typescript-diagnostics.json'
    ),
    'utf8'
  )
) as {
  baseSha: string;
  sourceClassification: { classification: string; observedAtBaseSha: string };
  diagnostics: TypeScriptDiagnostic[];
};

function render(diagnostic: TypeScriptDiagnostic): string {
  const location = diagnostic.file
    ? `${path.join(repositoryRoot, diagnostic.file)}(${diagnostic.line},${diagnostic.column}): `
    : '';
  return `${location}error TS${diagnostic.code}: ${diagnostic.message.replaceAll('<repo>', repositoryRoot)}`;
}

describe('Phase 0 final-gate TypeScript diagnostic normalization', () => {
  it('classifies the baseline as source-observed at the updated canonical base', () => {
    expect(baseline.baseSha).toBe('3bc0dfa7c00261785c0c752270cb302a9294e751');
    expect(baseline.sourceClassification).toMatchObject({
      classification: 'inherited_source_observed',
      observedAtBaseSha: baseline.baseSha,
    });
  });

  it('records reproducible compiler process and output evidence', () => {
    expect(
      evaluateCapturedGate({ mode: 'targeted', exitCode: 0, output: '', durationMs: 123 })
    ).toMatchObject({
      durationMs: 123,
      processDisposition: 'exited',
      compilerOutputBytes: 0,
      compilerOutputSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      passed: true,
    });
  });

  it('distinguishes an ordinary compiler exit from timeout and signal termination', () => {
    expect(classifyProcessDisposition({ status: 2, signal: null, errorCode: undefined })).toEqual({
      processDisposition: 'exited',
      rawExitCode: 2,
      signal: null,
    });
    expect(
      classifyProcessDisposition({ status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' })
    ).toEqual({ processDisposition: 'timeout', rawExitCode: null, signal: 'SIGTERM' });
    expect(
      classifyProcessDisposition({ status: null, signal: 'SIGKILL', errorCode: undefined })
    ).toEqual({ processDisposition: 'signal', rawExitCode: null, signal: 'SIGKILL' });
    expect(classifyProcessDisposition({ status: null, signal: null, errorCode: 'ENOENT' })).toEqual(
      {
        processDisposition: 'runner-error',
        rawExitCode: null,
        signal: null,
      }
    );
  });

  it.each([
    ['timeout', 'SIGTERM'],
    ['signal', 'SIGKILL'],
    ['runner-error', null],
  ] as const)('fails closed and preserves a %s disposition', (processDisposition, signal) => {
    expect(
      evaluateCapturedGate({
        mode: 'targeted',
        exitCode: null,
        output: '',
        durationMs: 50,
        processDisposition,
        signal,
        timeoutMs: 50,
      })
    ).toMatchObject({
      passed: false,
      processDisposition,
      rawExitCode: null,
      signal,
      timeoutMs: 50,
    });
  });

  it('parses and normalizes the exact seven inherited diagnostics', () => {
    const output = baseline.diagnostics.map(render).join('\n');
    const parsed = parseTypeScriptDiagnostics(output, repositoryRoot);
    expect(parsed).toEqual({ diagnostics: baseline.diagnostics, unparsed: [] });
    expect(
      evaluateCompilerResult({
        exitCode: 2,
        output,
        expected: baseline.diagnostics,
        repositoryRoot,
      })
    ).toMatchObject({
      passed: true,
      observedDiagnosticCount: 7,
      normalizedInheritedCount: 7,
      resolvedInheritedCount: 0,
      effectiveDiagnosticCount: 0,
    });
  });

  it('accepts semantically identical quoted union members rendered in a different order', () => {
    const expected = baseline.diagnostics.find((diagnostic) => diagnostic.code === 2352)!;
    const observed = {
      ...expected,
      message: expected.message.replace('"auto" | "api" | "cli-sdk"', '"cli-sdk" | "auto" | "api"'),
    };

    expect(
      evaluateCompilerResult({
        exitCode: 2,
        output: render(observed),
        expected: [expected],
        repositoryRoot,
      })
    ).toMatchObject({
      passed: true,
      normalizedInheritedCount: 1,
      resolvedInheritedCount: 0,
      effectiveDiagnosticCount: 0,
      inheritedDiagnostics: [observed],
    });
  });

  it.each([
    ['added', '"auto" | "api" | "cli-sdk" | "added-member"'],
    ['removed', '"auto" | "api"'],
    ['changed', '"changed-member" | "auto" | "api"'],
  ])('rejects a quoted union with %s members', (_change, observedUnion) => {
    const expected = baseline.diagnostics.find((diagnostic) => diagnostic.code === 2352)!;
    const observed = {
      ...expected,
      message: expected.message.replace('"auto" | "api" | "cli-sdk"', observedUnion),
    };
    const report = evaluateCompilerResult({
      exitCode: 2,
      output: render(observed),
      expected: [expected],
      repositoryRoot,
    });

    expect(report.passed).toBe(false);
    expect(report.resolvedDiagnostics).toEqual([expected]);
    expect(report.unexpectedDiagnostics).toEqual([observed]);
    expect(report.effectiveDiagnosticCount).toBe(1);
  });

  it('accepts removal of inherited diagnostics without hiding it', () => {
    const output = baseline.diagnostics.slice(0, 2).map(render).join('\n');
    expect(
      evaluateCompilerResult({
        exitCode: 2,
        output,
        expected: baseline.diagnostics,
        repositoryRoot,
      })
    ).toMatchObject({
      passed: true,
      normalizedInheritedCount: 2,
      resolvedInheritedCount: 5,
      effectiveDiagnosticCount: 0,
    });
  });

  it.each([
    ['changed code', { ...baseline.diagnostics[0], code: 9999 }],
    ['changed location', { ...baseline.diagnostics[0], line: 26 }],
    ['changed message', { ...baseline.diagnostics[0], message: 'different failure' }],
    [
      'new file',
      {
        file: 'src/new-failure.ts',
        line: 1,
        column: 1,
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  ])('rejects a %s diagnostic', (_name, diagnostic: TypeScriptDiagnostic) => {
    const report = evaluateCompilerResult({
      exitCode: 2,
      output: render(diagnostic),
      expected: baseline.diagnostics,
      repositoryRoot,
    });
    expect(report.passed).toBe(false);
    expect(report.unexpectedDiagnostics).toEqual([diagnostic]);
    expect(report.effectiveDiagnosticCount).toBe(1);
  });

  it('rejects duplicate occurrences after the one allowlisted occurrence is consumed', () => {
    const diagnostic = baseline.diagnostics[0];
    const normalized = normalizeDiagnostics([diagnostic, diagnostic], [diagnostic]);
    expect(normalized.inherited).toEqual([diagnostic]);
    expect(normalized.unexpected).toEqual([diagnostic]);
  });

  it('rejects global diagnostics and unparsed compiler output', () => {
    const global = evaluateCompilerResult({
      exitCode: 2,
      output: "error TS2688: Cannot find type definition file for 'node'.",
      expected: baseline.diagnostics,
      repositoryRoot,
    });
    expect(global.passed).toBe(false);
    expect(global.unexpectedDiagnostics[0]).toMatchObject({ file: null, code: 2688 });

    const crash = evaluateCompilerResult({
      exitCode: 2,
      output: 'compiler crashed before producing diagnostics',
      expected: baseline.diagnostics,
      repositoryRoot,
    });
    expect(crash).toMatchObject({
      passed: false,
      unparsedOutput: ['compiler crashed before producing diagnostics'],
    });
  });

  it('accepts a clean compiler exit as all seven inherited diagnostics resolved', () => {
    expect(
      evaluateCompilerResult({
        exitCode: 0,
        output: '',
        expected: baseline.diagnostics,
        repositoryRoot,
      })
    ).toMatchObject({
      passed: true,
      normalizedInheritedCount: 0,
      resolvedInheritedCount: 7,
      effectiveDiagnosticCount: 0,
    });
  });

  it('rejects inconsistent and unsupported compiler exits', () => {
    expect(
      evaluateCompilerResult({
        exitCode: 0,
        output: render(baseline.diagnostics[0]),
        expected: baseline.diagnostics,
        repositoryRoot,
      }).passed
    ).toBe(false);
    expect(
      evaluateCompilerResult({
        exitCode: 1,
        output: '',
        expected: baseline.diagnostics,
        repositoryRoot,
      }).passed
    ).toBe(false);
  });
});
