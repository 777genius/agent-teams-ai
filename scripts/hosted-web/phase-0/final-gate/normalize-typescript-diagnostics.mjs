import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../../../../');
const BASELINE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/research/hosted-web/phase-0/final-gate/inherited-typescript-diagnostics.json'
);
const QUOTED_TYPE_MEMBER_SOURCE = String.raw`"(?:\\.|[^"\\])*"`;
const QUOTED_UNION_PATTERN = new RegExp(
  String.raw`${QUOTED_TYPE_MEMBER_SOURCE}(?: \| ${QUOTED_TYPE_MEMBER_SOURCE})+`,
  'g'
);
const QUOTED_TYPE_MEMBER_PATTERN = new RegExp(QUOTED_TYPE_MEMBER_SOURCE, 'g');

function normalizeFilePath(file, repositoryRoot) {
  const portable = file.replaceAll('\\', '/');
  const root = repositoryRoot.replaceAll('\\', '/').replace(/\/$/, '');
  if (portable === root) return '.';
  if (portable.startsWith(`${root}/`)) return portable.slice(root.length + 1);
  return portable.replace(/^\.\//, '');
}

function normalizeMessage(message, repositoryRoot) {
  const portable = message.replaceAll('\\', '/');
  const root = repositoryRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return portable.replaceAll(root, '<repo>');
}

function canonicalizeQuotedUnionMemberOrder(message) {
  return message.replace(QUOTED_UNION_PATTERN, (union) =>
    (union.match(QUOTED_TYPE_MEMBER_PATTERN) ?? []).sort().join(' | ')
  );
}

export function parseTypeScriptDiagnostics(output, repositoryRoot = REPOSITORY_ROOT) {
  const diagnostics = [];
  const unparsed = [];
  let current = null;

  const finishCurrent = () => {
    if (!current) return;
    current.message = normalizeMessage(current.messageLines.join('\n').trimEnd(), repositoryRoot);
    delete current.messageLines;
    diagnostics.push(current);
    current = null;
  };

  for (const rawLine of output.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const located = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    const global = /^error TS(\d+): (.*)$/.exec(line);
    if (located) {
      finishCurrent();
      current = {
        file: normalizeFilePath(located[1], repositoryRoot),
        line: Number(located[2]),
        column: Number(located[3]),
        code: Number(located[4]),
        messageLines: [located[5]],
      };
    } else if (global) {
      finishCurrent();
      current = {
        file: null,
        line: null,
        column: null,
        code: Number(global[1]),
        messageLines: [global[2]],
      };
    } else if (current && /^\s+/.test(rawLine)) {
      current.messageLines.push(line);
    } else if (line.length > 0) {
      finishCurrent();
      unparsed.push(line);
    }
  }
  finishCurrent();
  return { diagnostics, unparsed };
}

function diagnosticKey(diagnostic) {
  return JSON.stringify([
    diagnostic.file,
    diagnostic.line,
    diagnostic.column,
    diagnostic.code,
    canonicalizeQuotedUnionMemberOrder(diagnostic.message),
  ]);
}

export function normalizeDiagnostics(observed, expected) {
  const remaining = new Map();
  for (const diagnostic of expected) {
    const key = diagnosticKey(diagnostic);
    const entries = remaining.get(key) ?? [];
    entries.push(diagnostic);
    remaining.set(key, entries);
  }

  const inherited = [];
  const unexpected = [];
  for (const diagnostic of observed) {
    const key = diagnosticKey(diagnostic);
    const entries = remaining.get(key);
    if (!entries?.length) {
      unexpected.push(diagnostic);
      continue;
    }
    inherited.push(diagnostic);
    entries.pop();
    if (entries.length === 0) remaining.delete(key);
  }

  return {
    inherited,
    resolved: [...remaining.values()].flat(),
    unexpected,
  };
}

export function evaluateCompilerResult({ exitCode, output, expected, repositoryRoot }) {
  const parsed = parseTypeScriptDiagnostics(output, repositoryRoot);
  const normalized = normalizeDiagnostics(parsed.diagnostics, expected);
  const supportedExitCode = exitCode === 0 || exitCode === 2;
  const exitMatchesDiagnostics =
    (exitCode === 0 && parsed.diagnostics.length === 0) ||
    (exitCode === 2 && parsed.diagnostics.length > 0);
  const passed =
    supportedExitCode &&
    exitMatchesDiagnostics &&
    parsed.unparsed.length === 0 &&
    normalized.unexpected.length === 0;

  return {
    passed,
    rawExitCode: exitCode,
    observedDiagnosticCount: parsed.diagnostics.length,
    normalizedInheritedCount: normalized.inherited.length,
    resolvedInheritedCount: normalized.resolved.length,
    effectiveDiagnosticCount: normalized.unexpected.length,
    inheritedDiagnostics: normalized.inherited,
    resolvedDiagnostics: normalized.resolved,
    unexpectedDiagnostics: normalized.unexpected,
    unparsedOutput: parsed.unparsed,
  };
}

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

export function classifyProcessDisposition({ status, signal, errorCode }) {
  if (errorCode === 'ETIMEDOUT') {
    return { processDisposition: 'timeout', rawExitCode: null, signal: signal ?? null };
  }
  if (signal) {
    return { processDisposition: 'signal', rawExitCode: null, signal };
  }
  if (errorCode) {
    return { processDisposition: 'runner-error', rawExitCode: status, signal: null };
  }
  return { processDisposition: 'exited', rawExitCode: status, signal: null };
}

export function evaluateCapturedGate({
  mode,
  exitCode,
  output,
  durationMs,
  processDisposition = 'exited',
  signal = null,
  timeoutMs = null,
  compilerCommand = null,
}) {
  const baseline = loadBaseline();
  const evaluation = evaluateCompilerResult({
    exitCode,
    output,
    expected: baseline.diagnostics,
    repositoryRoot: REPOSITORY_ROOT,
  });
  if (processDisposition !== 'exited') evaluation.passed = false;
  return {
    schemaVersion: 1,
    gate: `phase-0-final-gate-typescript-${mode}`,
    mode,
    baseSha: baseline.baseSha,
    durationMs,
    compilerCommand:
      compilerCommand ??
      (mode === 'milestone'
        ? 'pnpm --silent typecheck'
        : 'node node_modules/typescript/bin/tsc --noEmit --pretty false --project scripts/hosted-web/phase-0/final-gate/tsconfig.targeted.json'),
    processDisposition,
    signal,
    timeoutMs,
    compilerOutputBytes: Buffer.byteLength(output),
    compilerOutputSha256: createHash('sha256').update(output).digest('hex'),
    ...evaluation,
  };
}

function compilerArguments(mode) {
  if (mode === 'targeted') {
    return [
      '--noEmit',
      '--pretty',
      'false',
      '--project',
      path.join(SCRIPT_DIRECTORY, 'tsconfig.targeted.json'),
    ];
  }
  if (mode === 'milestone') {
    return [
      '--noEmit',
      '--pretty',
      'false',
      '--project',
      path.join(REPOSITORY_ROOT, 'tsconfig.json'),
    ];
  }
  throw new Error(`unsupported mode ${mode}`);
}

export function runGate(mode) {
  const baseline = loadBaseline();
  const compilerPath = path.join(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc');
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [compilerPath, ...compilerArguments(mode)], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const evaluation = evaluateCompilerResult({
    exitCode: result.status,
    output,
    expected: baseline.diagnostics,
    repositoryRoot: REPOSITORY_ROOT,
  });
  if (result.error) {
    evaluation.passed = false;
    evaluation.runnerError = result.error.message;
  }
  if (result.signal) {
    evaluation.passed = false;
    evaluation.runnerSignal = result.signal;
  }
  return {
    schemaVersion: 1,
    gate: `phase-0-final-gate-typescript-${mode}`,
    mode,
    baseSha: baseline.baseSha,
    durationMs: Math.round(durationMs * 100) / 100,
    ...evaluation,
  };
}

export function evaluateCapturedCleanStage({
  id,
  exitCode,
  output,
  durationMs,
  processDisposition,
  signal,
  timeoutMs,
  compilerCommand,
  rawCapturePath,
}) {
  return {
    id,
    command: compilerCommand,
    rawCapturePath,
    durationMs,
    processDisposition,
    rawExitCode: exitCode,
    signal,
    timeoutMs,
    compilerOutputBytes: Buffer.byteLength(output),
    compilerOutputSha256: createHash('sha256').update(output).digest('hex'),
    passed: processDisposition === 'exited' && exitCode === 0,
  };
}

export function assembleWorkspaceMilestone(stages) {
  const expectedIds = ['root', 'mcp-source', 'mcp-tests'];
  if (
    stages.length !== expectedIds.length ||
    stages.some((stage, index) => stage.id !== expectedIds[index])
  ) {
    throw new Error(`workspace milestone requires ordered stages: ${expectedIds.join(', ')}`);
  }
  return {
    schemaVersion: 1,
    gate: 'phase-0-final-gate-typescript-workspace-milestone',
    mode: 'milestone',
    baseSha: loadBaseline().baseSha,
    workspaceScript: 'pnpm typecheck:workspace',
    executionPolicy:
      'run the three canonical workspace stages in order; normalize only the inherited root diagnostics and require clean MCP exits',
    timeoutMsPerStage: stages[0].timeoutMs,
    durationMs:
      Math.round(stages.reduce((total, stage) => total + stage.durationMs, 0) * 100) / 100,
    passed: stages.every((stage) => stage.passed),
    stages,
  };
}

function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? 'targeted' : process.argv[modeIndex + 1];
  const inputIndex = process.argv.indexOf('--input');
  const assembleIndex = process.argv.indexOf('--assemble-workspace');
  let report;
  if (assembleIndex !== -1) {
    const reportPaths = process.argv.slice(assembleIndex + 1, assembleIndex + 4);
    if (reportPaths.length !== 3) throw new Error('--assemble-workspace requires three reports');
    report = assembleWorkspaceMilestone(
      reportPaths.map((reportPath) => JSON.parse(readFileSync(reportPath, 'utf8')))
    );
  } else if (inputIndex !== -1) {
    const exitCodeIndex = process.argv.indexOf('--exit-code');
    const durationIndex = process.argv.indexOf('--duration-ms');
    const dispositionIndex = process.argv.indexOf('--process-disposition');
    const signalIndex = process.argv.indexOf('--signal');
    const timeoutIndex = process.argv.indexOf('--timeout-ms');
    const commandIndex = process.argv.indexOf('--compiler-command');
    const stageIndex = process.argv.indexOf('--stage-id');
    const rawCaptureIndex = process.argv.indexOf('--raw-capture-path');
    if (
      [exitCodeIndex, durationIndex, dispositionIndex, timeoutIndex, commandIndex, stageIndex].some(
        (index) => index === -1
      )
    ) {
      throw new Error('--input requires complete process and stage evidence');
    }
    const rawExitCode = process.argv[exitCodeIndex + 1];
    const stageId = process.argv[stageIndex + 1];
    const input = {
      id: stageId,
      mode,
      exitCode: rawExitCode === 'null' ? null : Number(rawExitCode),
      output: readFileSync(process.argv[inputIndex + 1], 'utf8'),
      durationMs: Number(process.argv[durationIndex + 1]),
      processDisposition: process.argv[dispositionIndex + 1],
      signal:
        signalIndex === -1 || process.argv[signalIndex + 1] === 'null'
          ? null
          : process.argv[signalIndex + 1],
      timeoutMs: Number(process.argv[timeoutIndex + 1]),
      compilerCommand: process.argv[commandIndex + 1],
      rawCapturePath: rawCaptureIndex === -1 ? null : process.argv[rawCaptureIndex + 1],
    };
    if (stageId === 'root') {
      report = {
        id: stageId,
        rawCapturePath: input.rawCapturePath,
        ...evaluateCapturedGate(input),
      };
    } else {
      report = evaluateCapturedCleanStage(input);
    }
  } else {
    report = runGate(mode);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
