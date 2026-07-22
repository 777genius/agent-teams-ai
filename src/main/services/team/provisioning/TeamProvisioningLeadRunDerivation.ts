export interface TrackedRunIdentityLike {
  teamName: string;
  runId: string;
}

export interface RunTrackedCwdLike {
  request?: {
    cwd?: string;
  };
  spawnContext?: {
    cwd?: string;
  } | null;
}

export interface PreCompleteCliErrorRunLike {
  stderrBuffer: string;
  stdoutParserCarry: string;
  stdoutParserCarryIsCompleteJson: boolean;
  stdoutParserCarryLooksLikeClaudeJson: boolean;
}

export function isCurrentTrackedRunById(
  run: TrackedRunIdentityLike,
  trackedRunId: string | null | undefined
): boolean {
  return trackedRunId === run.runId;
}

export function getRunTrackedCwdFromRun(
  run: RunTrackedCwdLike | null | undefined,
  resolvePath: (cwd: string) => string
): string | null {
  const requestCwd = typeof run?.request?.cwd === 'string' ? run.request.cwd.trim() : '';
  if (requestCwd) return resolvePath(requestCwd);

  const spawnCwd = typeof run?.spawnContext?.cwd === 'string' ? run.spawnContext.cwd.trim() : '';
  if (spawnCwd) return resolvePath(spawnCwd);

  return null;
}

export function getPreCompleteCliErrorTextFromRun(run: PreCompleteCliErrorRunLike): string {
  const parts: string[] = [];
  const stderrText = run.stderrBuffer.trim();
  if (stderrText) {
    parts.push(stderrText);
  }

  const trailingStdout = run.stdoutParserCarry.trim();
  if (
    trailingStdout &&
    !run.stdoutParserCarryIsCompleteJson &&
    !run.stdoutParserCarryLooksLikeClaudeJson
  ) {
    parts.push(trailingStdout);
  }

  return parts.join('\n').trim();
}
