type CliLogStream = 'stdout' | 'stderr' | 'unknown';

interface CliLogLine {
  stream: CliLogStream;
  text: string;
}

export interface CliExitFailurePresentation {
  message?: string;
  error: string;
}

export interface CliExitPresentationRun {
  stdoutBuffer: string;
  stderrBuffer: string;
  claudeLogLines?: string[];
  deterministicBootstrap: boolean;
  lastDeterministicBootstrapEvent?: string;
  lastDeterministicBootstrapPhase?: string;
  deterministicBootstrapMemberSpawnSeen: boolean;
  expectedMembers: string[];
  memberSpawnStatuses: ReadonlyMap<string, { bootstrapConfirmed?: boolean } | undefined>;
}

const USER_FACING_CLI_NOISE_TEXT_PATTERN =
  /additionalContext|skill_flow|EXTREMELY_IMPORTANT|superpowers:using-superpowers|TodoWrite|Skill tool|Invoke Skill tool|Might any skill apply|relevant or requested skills BEFORE|hook_response|hook_started|hook_progress/i;

const USER_FACING_STDOUT_ERROR_PATTERN =
  /\b(error|failed|failure|fatal|exception|traceback|uncaught|unauthorized|forbidden|quota|rate limit|not authenticated|invalid api key|token refresh failed|warning)\b|please run \/login/i;

export function buildCombinedLogs(
  stdoutBuffer: string | undefined,
  stderrBuffer: string | undefined
): string {
  const stdoutTrimmed = (stdoutBuffer ?? '').trim();
  const stderrTrimmed = (stderrBuffer ?? '').trim();

  if (stdoutTrimmed.length === 0 && stderrTrimmed.length === 0) {
    return '';
  }
  if (stdoutTrimmed.length > 0 && stderrTrimmed.length === 0) {
    return stdoutTrimmed;
  }
  if (stdoutTrimmed.length === 0 && stderrTrimmed.length > 0) {
    return stderrTrimmed;
  }
  return [`[stdout]`, stdoutTrimmed, '', `[stderr]`, stderrTrimmed].join('\n');
}

export function parseCliLogLinesFromText(text: string): CliLogLine[] {
  const lines: CliLogLine[] = [];
  let currentStream: CliLogStream = 'unknown';
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === '[stdout]') {
      currentStream = 'stdout';
      continue;
    }
    if (trimmed === '[stderr]') {
      currentStream = 'stderr';
      continue;
    }
    lines.push({ stream: currentStream, text: trimmed });
  }
  return lines;
}

function getCliLogLinesForUserFacingError(run: CliExitPresentationRun): CliLogLine[] {
  const lineHistory = Array.isArray(run.claudeLogLines) ? run.claudeLogLines : [];
  const lines = lineHistory.length > 0 ? parseCliLogLinesFromText(lineHistory.join('\n')) : [];
  const combinedBufferLines = parseCliLogLinesFromText(
    buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer)
  );

  if (lines.length === 0) {
    return combinedBufferLines;
  }

  // claudeLogLines stores complete newline-delimited lines. Add raw ring-buffer
  // lines as a fallback only when they contain user-facing material that may be
  // sitting in a final partial stderr/stdout line at process close.
  const seen = new Set(lines.map((line) => `${line.stream}:${line.text}`));
  for (const line of combinedBufferLines) {
    const key = `${line.stream}:${line.text}`;
    if (!seen.has(key) && isPotentiallyUserFacingCliLine(line)) {
      lines.push(line);
      seen.add(key);
    }
  }
  return lines;
}

function isNoiseCliLine(text: string): boolean {
  return USER_FACING_CLI_NOISE_TEXT_PATTERN.test(text);
}

function isPotentiallyUserFacingCliLine(line: CliLogLine): boolean {
  if (isNoiseCliLine(line.text)) {
    return false;
  }
  if (line.stream === 'stderr') {
    return true;
  }
  return USER_FACING_STDOUT_ERROR_PATTERN.test(line.text);
}

function extractStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function extractStructuredCliError(parsed: Record<string, unknown>): string | undefined {
  const type = typeof parsed.type === 'string' ? parsed.type : undefined;
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined;

  if (type === 'system') {
    if (subtype === 'team_bootstrap' && parsed.event === 'failed') {
      return extractStringField(parsed, 'reason');
    }
    if (subtype === 'init' || subtype?.startsWith('hook_')) {
      return undefined;
    }
    return undefined;
  }

  if (type === 'result') {
    const result = parsed.result;
    const resultSubtype = subtype ?? extractStringField(result, 'subtype');
    if (resultSubtype === 'success' || parsed.outcome === 'success') {
      return undefined;
    }
    if (resultSubtype === 'error' || resultSubtype?.startsWith('error_')) {
      return (
        extractStringField(parsed, 'error') ??
        extractStringField(result, 'error') ??
        extractStringField(parsed, 'result')
      );
    }
    return undefined;
  }

  if (type === 'error') {
    return extractStringField(parsed, 'error') ?? extractStringField(parsed, 'message');
  }

  return undefined;
}

export function buildSanitizedCliExitError(run: CliExitPresentationRun): string | undefined {
  const errorLines: string[] = [];
  for (const line of getCliLogLinesForUserFacingError(run)) {
    if (!line.text || isNoiseCliLine(line.text)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line.text) as Record<string, unknown>;
      const structuredError = extractStructuredCliError(parsed);
      if (structuredError && !isNoiseCliLine(structuredError)) {
        errorLines.push(structuredError);
      }
      continue;
    } catch {
      // Non-JSON stderr/plain CLI errors are handled below.
    }

    if (isPotentiallyUserFacingCliLine(line)) {
      errorLines.push(line.text);
    }
  }

  const deduped = [...new Set(errorLines.map((line) => line.trim()).filter(Boolean))];
  if (deduped.length === 0) {
    return undefined;
  }
  return deduped.join('\n').slice(-4000);
}

export function formatPendingBootstrapMemberNames(run: CliExitPresentationRun): string {
  const pending = run.expectedMembers.filter((name) => {
    const status = run.memberSpawnStatuses.get(name);
    return status?.bootstrapConfirmed !== true;
  });
  const names = pending.length > 0 ? pending : run.expectedMembers;
  if (names.length === 0) {
    return 'unknown';
  }
  const visible = names.slice(0, 6);
  const suffix = names.length > visible.length ? ` and ${names.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

export function buildDeterministicBootstrapExitFailure(
  run: CliExitPresentationRun
): CliExitFailurePresentation {
  if (!run.lastDeterministicBootstrapEvent) {
    return {
      message: 'Launch bootstrap was not confirmed',
      error:
        'Codex runtime exited before deterministic team bootstrap started. No team_bootstrap event was received.',
    };
  }

  if (!run.deterministicBootstrapMemberSpawnSeen) {
    const lastStage = run.lastDeterministicBootstrapPhase
      ? `${run.lastDeterministicBootstrapEvent}/${run.lastDeterministicBootstrapPhase}`
      : run.lastDeterministicBootstrapEvent;
    return {
      message: 'Launch bootstrap was not confirmed',
      error: `Codex runtime exited during deterministic team bootstrap before teammate spawning started. Last bootstrap event: ${lastStage}.`,
    };
  }

  return {
    message: 'Launch bootstrap was not confirmed',
    error: `Bootstrap was not confirmed before the Codex runtime exited. Pending teammates: ${formatPendingBootstrapMemberNames(run)}.`,
  };
}

export function buildCliExitFailurePresentation(
  run: CliExitPresentationRun,
  code: number | null,
  options: { cliCommandLabel: string }
): CliExitFailurePresentation {
  const trimmed = buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer).trim();
  if (trimmed.length > 0) {
    if (trimmed.toLowerCase().includes('please run /login')) {
      return {
        error:
          `${options.cliCommandLabel} reports it is not authenticated ("Please run /login"). ` +
          'Run the CLI in a normal terminal and complete login, then retry. ' +
          'For automation/headless use, set `ANTHROPIC_API_KEY` for `-p` mode.',
      };
    }
    const sanitized = buildSanitizedCliExitError(run);
    if (sanitized) {
      return { error: sanitized };
    }
  }

  if (run.deterministicBootstrap) {
    return buildDeterministicBootstrapExitFailure(run);
  }

  if (code === 1) {
    return {
      error: `${options.cliCommandLabel} exited with code 1 without user-facing stdout/stderr. Typical causes: missing auth/onboarding, interactive TTY requirements, or an early bootstrap/runtime crash. Check \`~/.claude/debug/latest\` for the real stack and retry.`,
    };
  }

  return { error: `${options.cliCommandLabel} exited with code ${code ?? 'unknown'}` };
}
