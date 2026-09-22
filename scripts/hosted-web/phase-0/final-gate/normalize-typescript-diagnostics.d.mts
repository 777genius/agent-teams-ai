export interface TypeScriptDiagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  code: number;
  message: string;
}

export interface ParsedTypeScriptDiagnostics {
  diagnostics: TypeScriptDiagnostic[];
  unparsed: string[];
}

export interface NormalizedTypeScriptDiagnostics {
  inherited: TypeScriptDiagnostic[];
  resolved: TypeScriptDiagnostic[];
  unexpected: TypeScriptDiagnostic[];
}

export interface CompilerEvaluation {
  passed: boolean;
  rawExitCode: number | null;
  observedDiagnosticCount: number;
  normalizedInheritedCount: number;
  resolvedInheritedCount: number;
  effectiveDiagnosticCount: number;
  inheritedDiagnostics: TypeScriptDiagnostic[];
  resolvedDiagnostics: TypeScriptDiagnostic[];
  unexpectedDiagnostics: TypeScriptDiagnostic[];
  unparsedOutput: string[];
}

export type ProcessDisposition = 'exited' | 'timeout' | 'signal' | 'runner-error';

export function classifyProcessDisposition(input: {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
}): {
  processDisposition: ProcessDisposition;
  rawExitCode: number | null;
  signal: NodeJS.Signals | null;
};

export const REPOSITORY_ROOT: string;

export function parseTypeScriptDiagnostics(
  output: string,
  repositoryRoot?: string
): ParsedTypeScriptDiagnostics;

export function normalizeDiagnostics(
  observed: TypeScriptDiagnostic[],
  expected: TypeScriptDiagnostic[]
): NormalizedTypeScriptDiagnostics;

export function evaluateCompilerResult(input: {
  exitCode: number | null;
  output: string;
  expected: TypeScriptDiagnostic[];
  repositoryRoot: string;
}): CompilerEvaluation;

export function runGate(mode: 'targeted' | 'milestone'): CompilerEvaluation & {
  schemaVersion: 1;
  gate: string;
  mode: 'targeted' | 'milestone';
  baseSha: string;
  durationMs: number;
  runnerError?: string;
  runnerSignal?: NodeJS.Signals;
};

export function evaluateCapturedGate(input: {
  mode: 'targeted' | 'milestone';
  exitCode: number | null;
  output: string;
  durationMs: number;
  processDisposition?: ProcessDisposition;
  signal?: NodeJS.Signals | null;
  timeoutMs?: number | null;
  compilerCommand?: string | null;
}): CompilerEvaluation & {
  schemaVersion: 1;
  gate: string;
  mode: 'targeted' | 'milestone';
  baseSha: string;
  durationMs: number;
  compilerCommand: string;
  processDisposition: ProcessDisposition;
  signal: NodeJS.Signals | null;
  timeoutMs: number | null;
  compilerOutputBytes: number;
  compilerOutputSha256: string;
};

export function evaluateCapturedCleanStage(input: Record<string, unknown>): Record<string, unknown>;

export function assembleWorkspaceMilestone(
  stages: Array<Record<string, unknown> & { id: string; passed: boolean; durationMs: number }>
): Record<string, unknown> & { passed: boolean };
