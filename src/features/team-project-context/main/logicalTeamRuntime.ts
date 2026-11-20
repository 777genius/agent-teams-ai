import type { ResolvedTeamTarget } from './resolveTeamTarget';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamRuntimeState } from '@shared/types';

/**
 * Runtime of a logical team of the per-project mode. The logical team never has
 * a process: its state is the state of its project contexts (native project
 * copies), reported here so that headless callers (HTTP, MCP) do not have to
 * know about the copies. Everything is additive to the native state shape.
 */
type LogicalTarget = Extract<ResolvedTeamTarget, { kind: 'logical' }>;

export interface ContextRuntimeSnapshot {
  executionTeamName: string;
  projectPath: string;
  state: 'ready' | 'reserved';
  isAlive: boolean;
  runId: string | null;
  progress: TeamRuntimeState['progress'];
}

export interface LogicalTeamRuntimeState extends TeamRuntimeState {
  contexts: ContextRuntimeSnapshot[];
}

export interface NativeRuntimeReader {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
}

function snapshotOf(context: PersistedTeamWorkContext, state: TeamRuntimeState): ContextRuntimeSnapshot {
  return {
    executionTeamName: context.executionTeamName,
    projectPath: context.projectPath,
    state: context.state,
    isAlive: state.isAlive,
    runId: state.runId,
    progress: state.progress,
  };
}

/** The context that explains the team's state: the live one, else one that is provisioning. */
function aggregate(logical: string, contexts: ContextRuntimeSnapshot[]): LogicalTeamRuntimeState {
  const active =
    contexts.find((context) => context.isAlive) ??
    contexts.find((context) => context.progress !== null);
  return {
    teamName: logical,
    isAlive: contexts.some((context) => context.isAlive),
    runId: active?.runId ?? null,
    progress: active?.progress ?? null,
    contexts,
  };
}

export async function readLogicalRuntimeState(
  target: LogicalTarget,
  runtime: NativeRuntimeReader
): Promise<LogicalTeamRuntimeState> {
  const contexts = await Promise.all(
    target.contexts.map(async (context) =>
      snapshotOf(context, await runtime.getRuntimeState(context.executionTeamName))
    )
  );
  return aggregate(target.logical, contexts);
}

export interface AliveRuntimeEntry extends TeamRuntimeState {
  /** Only on a logical entry: the live contexts that make the team alive. */
  contexts?: ContextRuntimeSnapshot[];
  /** Only on a physical entry whose project copy could not be tied to its logical team. */
  projectContextUnresolved?: true;
}

export type AliasResolver = (
  teamName: string
) => Promise<{ logicalTeamName: string; context: PersistedTeamWorkContext } | null>;

/**
 * Every live physical team stays in the list (it is an accurate entry), and each
 * logical team with a live context is added once, so a headless caller sees the
 * team the user sees. A copy that cannot be resolved is flagged, not hidden.
 */
export async function listAliveRuntimeStates(
  aliveTeams: readonly string[],
  runtime: NativeRuntimeReader,
  resolveAlias: AliasResolver
): Promise<AliveRuntimeEntry[]> {
  const states = await Promise.all(aliveTeams.map((team) => runtime.getRuntimeState(team)));
  const entries: AliveRuntimeEntry[] = [];
  const byLogical = new Map<string, ContextRuntimeSnapshot[]>();
  for (const state of states) {
    if (!state.teamName.startsWith('ptc-')) {
      entries.push(state);
      continue;
    }
    try {
      const alias = await resolveAlias(state.teamName);
      entries.push(state);
      if (alias && state.isAlive) {
        const list = byLogical.get(alias.logicalTeamName) ?? [];
        list.push(snapshotOf(alias.context, state));
        byLogical.set(alias.logicalTeamName, list);
      }
    } catch {
      entries.push({ ...state, projectContextUnresolved: true });
    }
  }
  for (const [logical, contexts] of byLogical) entries.push(aggregate(logical, contexts));
  return entries;
}

export interface LogicalStopPorts<Result> {
  /** Reserved (pre-ready) contexts may already host a process; only an owner-verified one is stopped. */
  assertReservedStopOwnership(logicalTeamName: string, executionTeamName: string): Promise<void>;
  stopContext(executionTeamName: string): Promise<Result>;
  isAlive(executionTeamName: string): boolean | Promise<boolean>;
}

export interface LogicalContextStopOutcome<Result> {
  executionTeamName: string;
  projectPath: string;
  result?: Result;
  error?: string;
  /** Checked after every context was asked to stop: a stop only counts when the context is down. */
  stillAlive: boolean;
}

export interface LogicalStopOutcome<Result> {
  logical: string;
  contexts: LogicalContextStopOutcome<Result>[];
  complete: boolean;
}

/** A stop that did not bring every project context down. HTTP maps `statusCode`. */
export class LogicalStopIncompleteError extends Error {
  readonly code = 'LOGICAL_STOP_INCOMPLETE';
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly outcome: LogicalStopOutcome<unknown> | null
  ) {
    super(message);
    this.name = 'LogicalStopIncompleteError';
  }
}

/**
 * Stop every project context of a logical team and report each, then verify the
 * contexts are really down. A logical team has no process, so stopping its own
 * name would "succeed" while the project keeps running.
 */
export async function stopLogicalContexts<Result>(
  target: LogicalTarget,
  ports: LogicalStopPorts<Result>
): Promise<LogicalStopOutcome<Result>> {
  for (const context of target.contexts) {
    if (context.state === 'ready') continue;
    try {
      await ports.assertReservedStopOwnership(target.logical, context.executionTeamName);
    } catch (error) {
      // Nothing was stopped: an unverifiable context must not be touched.
      throw new LogicalStopIncompleteError(
        `Cannot stop team "${target.logical}": project ${context.projectPath} ` +
          `(${context.executionTeamName}) is pending and its owner cannot be verified: ` +
          (error instanceof Error ? error.message : String(error)),
        null
      );
    }
  }
  const contexts: LogicalContextStopOutcome<Result>[] = [];
  for (const context of target.contexts) {
    const outcome: LogicalContextStopOutcome<Result> = {
      executionTeamName: context.executionTeamName,
      projectPath: context.projectPath,
      stillAlive: false,
    };
    try {
      outcome.result = await ports.stopContext(context.executionTeamName);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    contexts.push(outcome);
  }
  for (const outcome of contexts) {
    outcome.stillAlive = await ports.isAlive(outcome.executionTeamName);
  }
  return {
    logical: target.logical,
    contexts,
    complete: contexts.every((outcome) => !outcome.error && !outcome.stillAlive),
  };
}

export function assertLogicalStopComplete(outcome: LogicalStopOutcome<unknown>): void {
  if (outcome.complete) return;
  const failed = outcome.contexts
    .filter((context) => context.error || context.stillAlive)
    .map(
      (context) =>
        `${context.projectPath} (${context.executionTeamName}): ` +
        (context.error ?? 'still running after the stop')
    );
  throw new LogicalStopIncompleteError(
    `Stop of team "${outcome.logical}" did not complete: ${failed.join('; ')}`,
    outcome
  );
}
