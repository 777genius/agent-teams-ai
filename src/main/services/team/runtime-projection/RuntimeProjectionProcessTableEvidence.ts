import { sanitizeRuntimeProjectionProcessCommand } from './RuntimeProjectionLiveness';

import type { RuntimeProjectionLivenessEvidence } from './RuntimeProjectionEvidence';
import type { TeamAgentRuntimePidSource } from '@shared/types';

export interface RuntimeProjectionProcessTableRow {
  pid: number;
  command: string;
}

export interface RuntimeProjectionVerifiedProcessEvidence {
  evidence: RuntimeProjectionLivenessEvidence;
  diagnostics: string[];
}

const SHELL_COMMAND_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'login', 'tmux']);
const CLI_ARG_VALUES_CACHE_MAX_COMMANDS = 1_000;
const CLI_ARG_EQUALS_CACHE_MAX_KEYS_PER_COMMAND = 100;
const cliArgValuesCache = new Map<string, Map<string, string[]>>();
const cliArgEqualsCache = new Map<string, Map<string, boolean>>();

function basenameCommand(command: string | undefined): string {
  const firstToken = command?.trim().split(/\s+/, 1)[0] ?? '';
  const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
  return base.replace(/^-/, '').toLowerCase();
}

export function isShellLikeCommand(command: string | undefined): boolean {
  return SHELL_COMMAND_NAMES.has(basenameCommand(command));
}

export function sanitizeProcessCommandForDiagnostics(
  command: string | undefined
): string | undefined {
  return sanitizeRuntimeProjectionProcessCommand(command);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCachedCliArgValues(command: string, argName: string): readonly string[] {
  if (!command.includes(argName)) {
    return [];
  }

  const cachedByArg = cliArgValuesCache.get(command);
  const cachedValues = cachedByArg?.get(argName);
  if (cachedValues) {
    if (cachedByArg) {
      cliArgValuesCache.delete(command);
      cliArgValuesCache.set(command, cachedByArg);
    }
    return cachedValues;
  }

  const escapedArg = escapeRegexLiteral(argName);
  const pattern = new RegExp(
    `(?:^|\\s)${escapedArg}(?:=|\\s+)("([^"]*)"|'([^']*)'|([^\\s]+))`,
    'g'
  );

  const values: string[] = [];
  for (const match of command.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (value) values.push(value);
  }
  const nextByArg = cachedByArg ?? new Map<string, string[]>();
  nextByArg.set(argName, values);
  cliArgValuesCache.delete(command);
  cliArgValuesCache.set(command, nextByArg);
  while (cliArgValuesCache.size > CLI_ARG_VALUES_CACHE_MAX_COMMANDS) {
    const oldestKey = cliArgValuesCache.keys().next().value;
    if (oldestKey === undefined) break;
    cliArgValuesCache.delete(oldestKey);
  }
  return values;
}

function getCachedCliArgEquals(
  command: string,
  argName: string,
  normalizedExpected: string
): boolean | undefined {
  const cachedByKey = cliArgEqualsCache.get(command);
  if (!cachedByKey) {
    return undefined;
  }
  const cacheKey = `${argName}\0${normalizedExpected}`;
  const cached = cachedByKey.get(cacheKey);
  if (cached !== undefined) {
    cliArgEqualsCache.delete(command);
    cliArgEqualsCache.set(command, cachedByKey);
  }
  return cached;
}

function setCachedCliArgEquals(
  command: string,
  argName: string,
  normalizedExpected: string,
  value: boolean
): void {
  let cachedByKey = cliArgEqualsCache.get(command);
  if (!cachedByKey) {
    cachedByKey = new Map<string, boolean>();
  }
  const cacheKey = `${argName}\0${normalizedExpected}`;
  if (!cachedByKey.has(cacheKey) && cachedByKey.size >= CLI_ARG_EQUALS_CACHE_MAX_KEYS_PER_COMMAND) {
    const oldestKey = cachedByKey.keys().next().value;
    if (oldestKey !== undefined) {
      cachedByKey.delete(oldestKey);
    }
  }
  cachedByKey.set(cacheKey, value);
  cliArgEqualsCache.delete(command);
  cliArgEqualsCache.set(command, cachedByKey);
  while (cliArgEqualsCache.size > CLI_ARG_VALUES_CACHE_MAX_COMMANDS) {
    const oldestCommand = cliArgEqualsCache.keys().next().value;
    if (oldestCommand === undefined) break;
    cliArgEqualsCache.delete(oldestCommand);
  }
}

export function extractCliArgValues(command: string, argName: string): string[] {
  const values = getCachedCliArgValues(command, argName);
  return [...values];
}

export function commandArgEquals(
  command: string,
  argName: string,
  expected: string | undefined
): boolean {
  const normalizedExpected = expected?.trim();
  if (!normalizedExpected) return false;
  if (!command.includes(argName)) return false;
  if (!command.includes(normalizedExpected)) return false;
  const cached = getCachedCliArgEquals(command, argName, normalizedExpected);
  if (cached !== undefined) {
    return cached;
  }
  const value = getCachedCliArgValues(command, argName).some(
    (argValue) => argValue === normalizedExpected
  );
  setCachedCliArgEquals(command, argName, normalizedExpected, value);
  return value;
}

function isVerifiedRuntimeProcess(params: {
  row: RuntimeProjectionProcessTableRow;
  teamName: string;
  agentId?: string;
}): boolean {
  return (
    !isShellLikeCommand(params.row.command) &&
    commandArgEquals(params.row.command, '--team-name', params.teamName) &&
    commandArgEquals(params.row.command, '--agent-id', params.agentId)
  );
}

export function findNewestVerifiedRuntimeProcessRow(params: {
  rows: readonly RuntimeProjectionProcessTableRow[];
  teamName: string;
  agentId?: string;
}): RuntimeProjectionProcessTableRow | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return undefined;
  }

  let newest: RuntimeProjectionProcessTableRow | undefined;
  for (const row of params.rows) {
    if (!isVerifiedRuntimeProcess({ row, teamName: params.teamName, agentId })) {
      continue;
    }
    if (!newest || row.pid > newest.pid) {
      newest = row;
    }
  }
  return newest;
}

export function readVerifiedRuntimeProcessLivenessEvidence(params: {
  rows: readonly RuntimeProjectionProcessTableRow[];
  teamName: string;
  agentId?: string;
  runtimeSessionId?: string;
  pidSource: TeamAgentRuntimePidSource;
  diagnostic?: string;
}): RuntimeProjectionVerifiedProcessEvidence | null {
  const row = findNewestVerifiedRuntimeProcessRow({
    rows: params.rows,
    teamName: params.teamName,
    agentId: params.agentId,
  });
  if (!row) {
    return null;
  }

  return {
    evidence: {
      registration: { runtimeSessionId: params.runtimeSessionId },
      process: {
        pid: row.pid,
        command: row.command,
        running: true,
        identityVerified: true,
        pidSource: params.pidSource,
      },
    },
    diagnostics: [params.diagnostic ?? 'matched process table by team-name and agent-id'],
  };
}
