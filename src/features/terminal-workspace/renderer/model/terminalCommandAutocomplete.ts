import { normalizeTerminalPathScope } from './terminalPathPresentation';

import type { TerminalCommandRunPresentation } from './terminalCommandRuns';

const TERMINAL_LOCAL_AUTOCOMPLETE_MIN_DRAFT_LENGTH = 2;
const TERMINAL_LOCAL_AUTOCOMPLETE_MAX_DRAFT_LENGTH = 160;
const TERMINAL_LOCAL_AUTOCOMPLETE_DANGEROUS_MIN_PREFIX_LENGTH = 8;

export interface TerminalLocalAutocompleteCandidate {
  command: string;
  cwd?: string | null;
  paneId?: string | null;
  sessionId?: string | null;
  startedAtMs?: number | null;
  status?: TerminalCommandRunPresentation['status'] | null;
}

export interface TerminalLocalAutocompleteOptions {
  candidates: readonly TerminalLocalAutocompleteCandidate[];
  cwd?: string | null;
  dismissedDraft?: string | null;
  draft: string;
  paneId?: string | null;
  sessionId?: string | null;
}

export function createTerminalLocalAutocompleteCandidates({
  commandHistory,
  commandRuns,
  cwd,
}: {
  commandHistory: readonly string[];
  commandRuns: readonly TerminalCommandRunPresentation[];
  cwd?: string | null;
}): TerminalLocalAutocompleteCandidate[] {
  const historyCandidates = commandHistory.map((command, index) => ({
    command,
    cwd,
    startedAtMs: index,
    status: 'unknown' as const,
  }));
  const runCandidates = commandRuns.map((run) => ({
    command: run.command,
    cwd,
    paneId: run.paneId,
    sessionId: run.sessionId,
    startedAtMs: run.startedAtMs,
    status: run.status,
  }));

  return [...historyCandidates, ...runCandidates];
}

export function resolveTerminalLocalAutocompleteSuggestion(
  options: TerminalLocalAutocompleteOptions
): string | null {
  if (
    !isTerminalLocalAutocompleteDraftEligible(options.draft) ||
    options.dismissedDraft === options.draft
  ) {
    return null;
  }

  const scopedCwd = normalizeTerminalPathScope(options.cwd);
  const statsByCommand = new Map<
    string,
    {
      command: string;
      frequency: number;
      lastUsedAtMs: number;
      sameCwd: boolean;
      samePane: boolean;
      sameSession: boolean;
      statusScore: number;
    }
  >();

  options.candidates.forEach((candidate, index) => {
    const command = normalizeAutocompleteCommand(candidate.command);
    if (
      !command ||
      command === options.draft ||
      !command.startsWith(options.draft) ||
      command.length > 320 ||
      command.includes('\n') ||
      command.includes('\r') ||
      !canSuggestTerminalAutocompleteCommand(options.draft, command)
    ) {
      return;
    }

    const existing = statsByCommand.get(command);
    const startedAtMs =
      typeof candidate.startedAtMs === 'number' && Number.isFinite(candidate.startedAtMs)
        ? candidate.startedAtMs
        : index;
    const sameCwd = Boolean(scopedCwd && normalizeTerminalPathScope(candidate.cwd) === scopedCwd);
    const samePane = Boolean(options.paneId && candidate.paneId === options.paneId);
    const sameSession = Boolean(options.sessionId && candidate.sessionId === options.sessionId);
    const statusScore = scoreTerminalAutocompleteStatus(candidate.status ?? null);

    if (!existing) {
      statsByCommand.set(command, {
        command,
        frequency: 1,
        lastUsedAtMs: startedAtMs,
        sameCwd,
        samePane,
        sameSession,
        statusScore,
      });
      return;
    }

    existing.frequency += 1;
    existing.lastUsedAtMs = Math.max(existing.lastUsedAtMs, startedAtMs);
    existing.sameCwd ||= sameCwd;
    existing.samePane ||= samePane;
    existing.sameSession ||= sameSession;
    existing.statusScore = Math.max(existing.statusScore, statusScore);
  });

  const ranked = Array.from(statsByCommand.values()).sort((left, right) => {
    const scoreDelta =
      scoreTerminalLocalAutocompleteCandidate(right) -
      scoreTerminalLocalAutocompleteCandidate(left);
    if (scoreDelta !== 0) return scoreDelta;

    const recencyDelta = right.lastUsedAtMs - left.lastUsedAtMs;
    if (recencyDelta !== 0) return recencyDelta;

    const lengthDelta = left.command.length - right.command.length;
    if (lengthDelta !== 0) return lengthDelta;

    return left.command.localeCompare(right.command);
  });

  return ranked[0]?.command ?? null;
}

export function isTerminalLocalAutocompleteDraftEligible(draft: string): boolean {
  return (
    draft.length >= TERMINAL_LOCAL_AUTOCOMPLETE_MIN_DRAFT_LENGTH &&
    draft.length <= TERMINAL_LOCAL_AUTOCOMPLETE_MAX_DRAFT_LENGTH &&
    draft.trimStart() === draft &&
    draft.trim().length >= TERMINAL_LOCAL_AUTOCOMPLETE_MIN_DRAFT_LENGTH &&
    !draft.includes('\n') &&
    !draft.includes('\r')
  );
}

function normalizeAutocompleteCommand(command: string): string {
  return command.trim();
}

function canSuggestTerminalAutocompleteCommand(draft: string, command: string): boolean {
  if (!isDangerousTerminalCommand(command)) {
    return true;
  }

  return draft.trim().length >= TERMINAL_LOCAL_AUTOCOMPLETE_DANGEROUS_MIN_PREFIX_LENGTH;
}

function isDangerousTerminalCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    normalized === 'rm' ||
    normalized.startsWith('rm ') ||
    normalized === 'sudo' ||
    normalized.startsWith('sudo ') ||
    normalized.startsWith('chmod -r ') ||
    normalized.startsWith('chmod -r') ||
    normalized.startsWith('git reset --hard')
  );
}

function scoreTerminalAutocompleteStatus(
  status: TerminalCommandRunPresentation['status'] | null
): number {
  switch (status) {
    case 'succeeded':
      return 140;
    case 'running':
      return 30;
    case 'unknown':
      return 20;
    case 'failed':
      return -160;
    default:
      return 0;
  }
}

function scoreTerminalLocalAutocompleteCandidate(candidate: {
  command: string;
  frequency: number;
  lastUsedAtMs: number;
  sameCwd: boolean;
  samePane: boolean;
  sameSession: boolean;
  statusScore: number;
}): number {
  return (
    1000 +
    candidate.statusScore +
    (candidate.samePane ? 220 : 0) +
    (candidate.sameSession ? 90 : 0) +
    (candidate.sameCwd ? 120 : 0) +
    Math.min(160, candidate.frequency * 28) +
    Math.min(220, Math.max(0, candidate.lastUsedAtMs) / 1000)
  );
}
