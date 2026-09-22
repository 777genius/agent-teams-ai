import type { ScreenLine, ScreenLineSemanticMark } from '@terminal-platform/runtime-types';

export const TERMINAL_COMMAND_HISTORY_LIMIT = 80;
const TERMINAL_COMMAND_RUNS_STORAGE_LIMIT = TERMINAL_COMMAND_HISTORY_LIMIT * 4;
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  'gu'
);

export type TerminalCommandRunStatus = 'failed' | 'running' | 'succeeded' | 'unknown';

export interface TerminalCommandRunPresentation {
  clientEventId: string;
  command: string;
  durationMs?: number | null;
  exitCode?: number | null;
  paneId: string;
  sessionId: string;
  startedAtMs: number;
  status: TerminalCommandRunStatus;
}

export type TerminalCommandScreenLine =
  | string
  | (Pick<ScreenLine, 'semantic_marks' | 'text'> & {
      isActiveCursorLine?: boolean;
      historyCapturedAtMs?: bigint;
      isHistoryTailLine?: boolean;
      source?: 'history' | 'live';
    });

export function upsertTerminalCommandRun(
  runs: TerminalCommandRunPresentation[],
  nextRun: TerminalCommandRunPresentation,
  status: TerminalCommandRunPresentation['status']
): TerminalCommandRunPresentation[] {
  const existingIndex = runs.findIndex((run) => run.clientEventId === nextRun.clientEventId);
  const existingRun = existingIndex >= 0 ? runs[existingIndex] : undefined;
  if (status === 'running' && existingRun && existingRun.status !== 'running') {
    return runs;
  }

  const next = {
    ...nextRun,
    status,
  };
  const merged =
    existingIndex >= 0
      ? runs.map((run, index) => (index === existingIndex ? { ...run, ...next } : run))
      : [...runs, next];

  return capTerminalCommandRuns(merged);
}

export function capTerminalCommandRuns(
  runs: readonly TerminalCommandRunPresentation[]
): TerminalCommandRunPresentation[] {
  const countsByPane = new Map<string, number>();
  const keptReversed: TerminalCommandRunPresentation[] = [];

  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;

    const scopeKey = `${run.sessionId}\u001f${run.paneId}`;
    const count = countsByPane.get(scopeKey) ?? 0;
    if (count >= TERMINAL_COMMAND_HISTORY_LIMIT) {
      continue;
    }

    countsByPane.set(scopeKey, count + 1);
    keptReversed.push(run);
  }

  return keptReversed.reverse().slice(-TERMINAL_COMMAND_RUNS_STORAGE_LIMIT);
}

export function settleTerminalCommandRuns(
  runs: TerminalCommandRunPresentation[],
  screenLines: readonly TerminalCommandScreenLine[],
  nowMs: number,
  allowEmptyCompletion: boolean
): TerminalCommandRunPresentation[] {
  let changed = false;
  const next = runs.map((run) => {
    const applicableScreenLines = getTerminalCommandScreenLinesForRun(screenLines, run.startedAtMs);
    const completion = inferTerminalCommandCompletion(applicableScreenLines, run.command);
    const failureWithoutPrompt = completion.completed
      ? null
      : inferTerminalCommandFailureWithoutPrompt(applicableScreenLines, run.command);
    if (failureWithoutPrompt) {
      if (run.status === 'failed') {
        return run;
      }

      changed = true;
      return {
        ...run,
        durationMs: run.durationMs ?? Math.max(0, nowMs - run.startedAtMs),
        status: 'failed' as const,
      };
    }

    if (!completion.completed) {
      return run;
    }

    const inferredStatus = inferTerminalCommandCompletionStatus(completion);
    const hasAuthoritativeExitCode = typeof completion.exitCode === 'number';
    if (run.status !== 'running') {
      const shouldApplyAuthoritativeStatus =
        hasAuthoritativeExitCode && run.status !== inferredStatus;
      const shouldSettleRecoveredUnknown =
        run.status === 'unknown' && completion.outputLines.length > 0;
      const shouldPromoteInferredFailure = run.status !== 'failed' && inferredStatus === 'failed';
      if (
        shouldApplyAuthoritativeStatus ||
        shouldSettleRecoveredUnknown ||
        shouldPromoteInferredFailure
      ) {
        changed = true;
        return {
          ...run,
          ...(hasAuthoritativeExitCode ? { exitCode: completion.exitCode } : {}),
          status: inferredStatus,
        };
      }

      return run;
    }

    if (completion.outputLines.length === 0 && !hasAuthoritativeExitCode && !allowEmptyCompletion) {
      return run;
    }

    changed = true;
    return {
      ...run,
      durationMs: Math.max(0, nowMs - run.startedAtMs),
      ...(hasAuthoritativeExitCode ? { exitCode: completion.exitCode } : {}),
      status:
        completion.outputLines.length > 0 || hasAuthoritativeExitCode ? inferredStatus : 'unknown',
    };
  });

  return changed ? next : runs;
}

export function settleScopedTerminalCommandRuns(
  runs: TerminalCommandRunPresentation[],
  sessionId: string | null,
  paneId: string | null,
  screenLines: readonly TerminalCommandScreenLine[],
  nowMs: number,
  allowEmptyCompletion: boolean
): TerminalCommandRunPresentation[] {
  if (!sessionId || !paneId) {
    return runs;
  }

  const scopedRuns = runs.filter((run) => run.sessionId === sessionId && run.paneId === paneId);
  if (scopedRuns.length === 0) {
    return runs;
  }

  const settledScopedRuns = settleTerminalCommandRuns(
    scopedRuns,
    screenLines,
    nowMs,
    allowEmptyCompletion
  );
  if (settledScopedRuns === scopedRuns) {
    return runs;
  }

  let scopedIndex = 0;
  return runs.map((run) => {
    if (run.sessionId !== sessionId || run.paneId !== paneId) {
      return run;
    }

    const settledRun = settledScopedRuns[scopedIndex];
    scopedIndex += 1;
    return settledRun ?? run;
  });
}

export function closeSupersededTerminalCommandRuns(
  runs: TerminalCommandRunPresentation[],
  nextRun: TerminalCommandRunPresentation,
  screenLines: readonly TerminalCommandScreenLine[],
  nowMs: number
): TerminalCommandRunPresentation[] {
  const settledRuns = settleTerminalCommandRuns(runs, screenLines, nowMs, true);
  let changed = settledRuns !== runs;

  const next = settledRuns.map((run) => {
    if (
      run.clientEventId === nextRun.clientEventId ||
      run.sessionId !== nextRun.sessionId ||
      run.paneId !== nextRun.paneId ||
      run.startedAtMs >= nextRun.startedAtMs ||
      run.status !== 'running'
    ) {
      return run;
    }

    changed = true;
    const applicableScreenLines = getTerminalCommandScreenLinesForRun(screenLines, run.startedAtMs);
    const completion = inferTerminalCommandCompletion(applicableScreenLines, run.command);
    const failureWithoutPrompt = completion.completed
      ? null
      : inferTerminalCommandFailureWithoutPrompt(applicableScreenLines, run.command);
    const inferredStatus = failureWithoutPrompt
      ? 'failed'
      : completion.completed &&
          (completion.outputLines.length > 0 || typeof completion.exitCode === 'number')
        ? inferTerminalCommandCompletionStatus(completion)
        : 'unknown';

    return {
      ...run,
      durationMs: run.durationMs ?? Math.max(0, nextRun.startedAtMs - run.startedAtMs),
      ...(typeof completion.exitCode === 'number' ? { exitCode: completion.exitCode } : {}),
      status: inferredStatus,
    };
  });

  return changed ? next : runs;
}

export function inferTerminalCommandCompletion(
  lines: readonly TerminalCommandScreenLine[],
  command: string
): { completed: boolean; exitCode?: number | null; outputLines: string[] } {
  const commandLineIndex = findLatestTerminalCommandLineIndex(lines, command);
  if (commandLineIndex === -1) {
    return { completed: false, outputLines: [] };
  }

  for (let index = commandLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const commandFinishedMark = getTerminalCommandFinishedMark(line);
    if (commandFinishedMark) {
      const exitCode = commandFinishedMark.exit_code;
      return {
        completed: true,
        ...(typeof exitCode === 'number' && Number.isFinite(exitCode)
          ? { exitCode: Math.trunc(exitCode) }
          : { exitCode: null }),
        outputLines: collectTerminalCommandOutputLines(lines, commandLineIndex + 1, index),
      };
    }

    if (isTerminalPromptBoundaryLine(line)) {
      return {
        completed: true,
        outputLines: collectTerminalCommandOutputLines(lines, commandLineIndex + 1, index),
      };
    }
  }

  return { completed: false, outputLines: [] };
}

function inferTerminalCommandFailureWithoutPrompt(
  lines: readonly TerminalCommandScreenLine[],
  command: string
): { outputLines: string[] } | null {
  const commandLineIndex = findLatestTerminalCommandLineIndex(lines, command);
  if (commandLineIndex === -1 || commandLineIndex >= lines.length - 1) {
    return null;
  }

  const outputLines = lines
    .slice(commandLineIndex + 1)
    .map((line) => getTerminalCommandScreenLineText(line).trimEnd())
    .filter((line) => line.trim().length > 0);
  if (outputLines.length === 0) {
    return null;
  }

  return inferTerminalCommandOutputStatus(outputLines) === 'failed' ? { outputLines } : null;
}

function findLatestTerminalCommandLineIndex(
  lines: readonly TerminalCommandScreenLine[],
  command: string
): number {
  const normalizedCommand = normalizeCommandForPromptMatch(command);
  let rawCommandLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const screenLine = lines[index];
    const line = getTerminalCommandScreenLineText(screenLine);
    const promptCommands = extractCommandCandidatesFromPromptLine(line);
    const normalizedLine = normalizeCommandForPromptMatch(line);

    if (
      promptCommands.some(
        (promptCommand) =>
          isTerminalCommandFragmentMatch(promptCommand, normalizedCommand) ||
          (isTerminalHistoryScreenLine(screenLine) &&
            isDuplicatedLeadingTerminalCommandEcho(promptCommand, normalizedCommand))
      ) ||
      (hasTerminalCommandScreenLineMark(screenLine, 'input_start') &&
        normalizedLine.endsWith(normalizedCommand))
    ) {
      return rawCommandLineIndex === -1 ? index : rawCommandLineIndex;
    }

    if (
      normalizedLine === normalizedCommand ||
      (isTerminalHistoryScreenLine(screenLine) &&
        isDuplicatedLeadingTerminalCommandEcho(normalizedLine, normalizedCommand))
    ) {
      rawCommandLineIndex = index;
      continue;
    }

    if (rawCommandLineIndex !== -1 && isTerminalPromptBoundaryLine(screenLine)) {
      return rawCommandLineIndex;
    }
  }

  return rawCommandLineIndex;
}

export function createTerminalCommandScreenLines(
  lines: readonly Pick<ScreenLine, 'semantic_marks' | 'text'>[],
  cursorRow: number | null
): TerminalCommandScreenLine[] {
  return lines.map((line, index) => ({
    ...line,
    source: 'live',
    ...(index === cursorRow ? { isActiveCursorLine: true } : {}),
  }));
}

function collectTerminalCommandOutputLines(
  lines: readonly TerminalCommandScreenLine[],
  startIndex: number,
  endIndex: number
): string[] {
  return lines
    .slice(startIndex, endIndex)
    .map((line) => getTerminalCommandScreenLineText(line).trimEnd())
    .filter((line) => line.trim().length > 0);
}

function getTerminalCommandScreenLineText(line: TerminalCommandScreenLine | undefined): string {
  return typeof line === 'string' ? line : (line?.text ?? '');
}

function getTerminalCommandFinishedMark(
  line: TerminalCommandScreenLine | undefined
): ScreenLineSemanticMark | null {
  if (typeof line === 'string' || !line) {
    return null;
  }

  return line.semantic_marks?.find((mark) => mark.kind === 'command_finished') ?? null;
}

function hasTerminalCommandScreenLineMark(
  line: TerminalCommandScreenLine | undefined,
  kind: ScreenLineSemanticMark['kind']
): boolean {
  return (
    typeof line !== 'string' && Boolean(line?.semantic_marks?.some((mark) => mark.kind === kind))
  );
}

function isTerminalPromptBoundaryLine(line: TerminalCommandScreenLine | undefined): boolean {
  const text = getTerminalCommandScreenLineText(line);
  if (isTerminalPromptCommandLine(text)) {
    return true;
  }

  if (!isTerminalPromptOnlyLine(text)) {
    return false;
  }

  return (
    typeof line === 'string' ||
    (line?.source === 'history' && line.isHistoryTailLine === true) ||
    line?.isActiveCursorLine === true
  );
}

function isTerminalHistoryScreenLine(
  line: TerminalCommandScreenLine | undefined
): line is Exclude<TerminalCommandScreenLine, string> & { source: 'history' } {
  return typeof line !== 'string' && line?.source === 'history';
}

function getTerminalCommandScreenLinesForRun(
  lines: readonly TerminalCommandScreenLine[],
  startedAtMs: number
): TerminalCommandScreenLine[] {
  const startedAt = BigInt(Math.max(0, Math.trunc(startedAtMs)));
  return lines.filter(
    (line) =>
      !isTerminalHistoryScreenLine(line) ||
      line.historyCapturedAtMs === undefined ||
      line.historyCapturedAtMs >= startedAt
  );
}

function inferTerminalCommandCompletionStatus(completion: {
  exitCode?: number | null;
  outputLines: readonly string[];
}): TerminalCommandRunPresentation['status'] {
  if (typeof completion.exitCode === 'number') {
    return completion.exitCode === 0 ? 'succeeded' : 'failed';
  }

  return inferTerminalCommandOutputStatus(completion.outputLines);
}

function isTerminalPromptOnlyLine(line: string): boolean {
  const text = line.trim();
  if (!text) {
    return false;
  }

  if (text === '%' || text === '$' || text === '#') {
    return true;
  }

  return /(?:^|\s)[%$#]\s*$/u.test(text) && !/(?:^|\s)[%$#]\s+\S/u.test(text);
}

function isTerminalPromptCommandLine(line: string): boolean {
  return extractCommandFromPromptLine(line).length > 0;
}

function extractCommandFromPromptLine(line: string): string {
  return extractCommandCandidatesFromPromptLine(line).at(-1) ?? '';
}

function extractCommandCandidatesFromPromptLine(line: string): string[] {
  const trimmed = line.trimEnd();
  const wrappedPromptCommand = /^<\s{2,}(.+)$/u.exec(trimmed);
  if (wrappedPromptCommand?.[1]) {
    return [wrappedPromptCommand[1].trim()];
  }

  const candidates: string[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const marker = trimmed[index] ?? '';
    if (marker !== '%' && marker !== '$' && marker !== '#') {
      continue;
    }

    const command = trimmed.slice(index + 1);
    if (command.startsWith(' ')) {
      candidates.push(command.trim());
    }
  }

  return candidates;
}

function normalizeCommandForPromptMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isTerminalCommandFragmentMatch(fragment: string, normalizedCommand: string): boolean {
  const normalizedFragment = normalizeCommandForPromptMatch(fragment);
  if (!normalizedFragment) {
    return false;
  }

  if (normalizedFragment === normalizedCommand) {
    return true;
  }

  if (normalizedCommand.startsWith(normalizedFragment)) {
    return true;
  }

  return normalizedFragment.length >= 8 && normalizedCommand.includes(normalizedFragment);
}

function isDuplicatedLeadingTerminalCommandEcho(
  candidate: string,
  normalizedCommand: string
): boolean {
  const normalizedCandidate = normalizeCommandForPromptMatch(candidate);
  return (
    normalizedCommand.length > 0 &&
    normalizedCandidate.length === normalizedCommand.length + 1 &&
    normalizedCandidate.startsWith(normalizedCommand.slice(0, 1)) &&
    normalizedCandidate.slice(1) === normalizedCommand
  );
}

export function inferTerminalCommandOutputStatus(
  outputLines: readonly string[]
): TerminalCommandRunPresentation['status'] {
  const output = stripAnsiEscapeSequences(outputLines.join('\n')).toLowerCase();
  if (
    /(?:^|\n)\s*(?:fatal|error):/u.test(output) ||
    /(?:^|\n)\s*(?:npm|pnpm|yarn)\s+err!?/u.test(output) ||
    /(?:^|\n)\s*traceback\s+\(most recent call last\):/u.test(output) ||
    /(?:^|\n)\s*exception:/u.test(output) ||
    /(?:command not found|no such file or directory|permission denied|not a git repository)/u.test(
      output
    ) ||
    /(?:exit(?:ed)?\s+(?:with\s+)?(?:status|code)|exit\s+code)\s+[1-9]\d*/u.test(output)
  ) {
    return 'failed';
  }

  return 'succeeded';
}

function stripAnsiEscapeSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '');
}
