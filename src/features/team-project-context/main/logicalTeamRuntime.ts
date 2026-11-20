import type { ContextGroup } from './resolveTeamTarget';
import type {
  OwnedExecutionAliasLookup,
  PersistedTeamWorkContext,
} from './TeamProjectContextRegistry';
import type { TeamRuntimeState } from '@shared/types';

/**
 * Runtime of a team that owns project contexts. A logical team of the
 * per-project mode never has a process: its state is the state of its project
 * contexts (native project copies), reported here so that headless callers
 * (HTTP, MCP) do not have to know about the copies. A shared team that retained
 * contexts has a process of its own as well; `ownRuntime` folds it in. Everything
 * is additive to the native state shape.
 */
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

type RuntimeCandidate = Pick<TeamRuntimeState, 'isAlive' | 'runId' | 'progress'>;

/** Provisioning that is still going; a settled progress only explains a past run. */
function isProvisioning(candidate: RuntimeCandidate): boolean {
  const progress = candidate.progress;
  if (progress === null) return false;
  return progress.state !== 'ready' && progress.state !== 'disconnected' &&
    progress.state !== 'failed' && progress.state !== 'cancelled';
}

/**
 * The runtime that explains the team's state: a live one, else one that is
 * provisioning, else whichever still reports a settled progress.
 */
function aggregate(
  team: string,
  own: TeamRuntimeState | null,
  contexts: ContextRuntimeSnapshot[]
): LogicalTeamRuntimeState {
  const candidates: RuntimeCandidate[] = own ? [own, ...contexts] : contexts;
  const active =
    candidates.find((candidate) => candidate.isAlive) ??
    candidates.find(isProvisioning) ??
    candidates.find((candidate) => candidate.progress !== null);
  return {
    teamName: team,
    isAlive: candidates.some((candidate) => candidate.isAlive),
    runId: active?.runId ?? null,
    progress: active?.progress ?? null,
    contexts,
  };
}

export async function readLogicalRuntimeState(
  group: ContextGroup,
  runtime: NativeRuntimeReader
): Promise<LogicalTeamRuntimeState> {
  const [own, contexts] = await Promise.all([
    group.ownRuntime ? runtime.getRuntimeState(group.team) : Promise.resolve(null),
    Promise.all(
      group.contexts.map(async (context) =>
        snapshotOf(context, await runtime.getRuntimeState(context.executionTeamName))
      )
    ),
  ]);
  return aggregate(group.team, own, contexts);
}

export interface AliveRuntimeEntry extends TeamRuntimeState {
  /** Only on a team that owns contexts: the live contexts that make the team alive. */
  contexts?: ContextRuntimeSnapshot[];
  /** Only on a physical entry whose project copy could not be tied to its logical team. */
  projectContextUnresolved?: true;
}

export type AliasBatchResolver = (
  teamNames: readonly string[]
) => Promise<Map<string, OwnedExecutionAliasLookup>>;

/**
 * Every live physical team stays in the list (it is an accurate entry), and each
 * team that owns a live context is added once, so a headless caller sees the team
 * the user sees. A shared team that is itself alive absorbs its contexts into its
 * own entry instead of appearing twice. A copy that cannot be resolved is
 * flagged, not hidden.
 */
export async function listAliveRuntimeStates(
  aliveTeams: readonly string[],
  runtime: NativeRuntimeReader,
  resolveAliases: AliasBatchResolver
): Promise<AliveRuntimeEntry[]> {
  const states = await Promise.all(aliveTeams.map((team) => runtime.getRuntimeState(team)));
  const copies = states.filter((state) => state.teamName.startsWith('ptc-'));
  let lookups = new Map<string, OwnedExecutionAliasLookup>();
  let lookupFailed = false;
  if (copies.length > 0) {
    try {
      lookups = await resolveAliases(copies.map((state) => state.teamName));
    } catch {
      lookupFailed = true;
    }
  }

  const entries: AliveRuntimeEntry[] = [];
  const byLogical = new Map<string, ContextRuntimeSnapshot[]>();
  for (const state of states) {
    if (!state.teamName.startsWith('ptc-')) {
      entries.push(state);
      continue;
    }
    const lookup = lookups.get(state.teamName);
    if (lookupFailed || !lookup || 'error' in lookup) {
      entries.push({ ...state, projectContextUnresolved: true });
      continue;
    }
    entries.push(state);
    if (lookup.alias && state.isAlive) {
      const list = byLogical.get(lookup.alias.logicalTeamName) ?? [];
      list.push(snapshotOf(lookup.alias.context, state));
      byLogical.set(lookup.alias.logicalTeamName, list);
    }
  }
  for (const [team, contexts] of byLogical) {
    const ownIndex = entries.findIndex((entry) => entry.teamName === team && !entry.contexts);
    if (ownIndex === -1) {
      entries.push(aggregate(team, null, contexts));
    } else {
      entries[ownIndex] = aggregate(team, entries[ownIndex], contexts);
    }
  }
  return entries;
}

export interface LogicalStopPorts<Result> {
  /** Reserved (pre-ready) contexts may already host a process; only an owner-verified one is stopped. */
  assertReservedStopOwnership(team: string, executionTeamName: string): Promise<void>;
  stopContext(executionTeamName: string): Promise<Result>;
  /** True only when the runtime is confirmed down: not alive, no run, no provisioning in flight. */
  isStopped(executionTeamName: string): Promise<boolean>;
  /** The team's contexts as they are now, to catch one that appeared while stopping. */
  listContexts(team: string): Promise<readonly PersistedTeamWorkContext[]>;
}

export interface LogicalContextStopOutcome<Result> {
  executionTeamName: string;
  /** `null` for the team's own process (a shared team that retained contexts). */
  projectPath: string | null;
  result?: Result;
  error?: string;
  /** Checked after every context was asked to stop: a stop only counts when the context is down. */
  stillAlive: boolean;
  /** A context that was not there when the stop started. It was verified, not stopped. */
  appearedDuringStop?: true;
}

export interface LogicalStopOutcome<Result> {
  team: string;
  contexts: LogicalContextStopOutcome<Result>[];
  complete: boolean;
  /** Set when the post-stop re-read of the contexts failed: the stop cannot be called complete. */
  verificationError?: string;
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
 * Stop every project context of a team (and its own process when it has one) and
 * report each, then verify everything is really down. A logical team has no
 * process, so stopping its own name would "succeed" while the project keeps
 * running.
 */
export async function stopLogicalContexts<Result>(
  group: ContextGroup,
  ports: LogicalStopPorts<Result>
): Promise<LogicalStopOutcome<Result>> {
  for (const context of group.contexts) {
    if (context.state === 'ready') continue;
    try {
      await ports.assertReservedStopOwnership(group.team, context.executionTeamName);
    } catch (error) {
      // Nothing was stopped: an unverifiable context must not be touched.
      throw new LogicalStopIncompleteError(
        `Cannot stop team "${group.team}": project ${context.projectPath} ` +
          `(${context.executionTeamName}) is pending and its owner cannot be verified: ` +
          (error instanceof Error ? error.message : String(error)),
        null
      );
    }
  }
  const targets: { executionTeamName: string; projectPath: string | null }[] = [
    ...group.contexts.map((context) => ({
      executionTeamName: context.executionTeamName,
      projectPath: context.projectPath,
    })),
    ...(group.ownRuntime ? [{ executionTeamName: group.team, projectPath: null }] : []),
  ];
  const contexts: LogicalContextStopOutcome<Result>[] = [];
  for (const target of targets) {
    const outcome: LogicalContextStopOutcome<Result> = { ...target, stillAlive: false };
    try {
      outcome.result = await ports.stopContext(target.executionTeamName);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    contexts.push(outcome);
  }

  let verificationError: string | undefined;
  try {
    const known = new Set(targets.map((target) => target.executionTeamName));
    for (const context of await ports.listContexts(group.team)) {
      if (known.has(context.executionTeamName)) continue;
      contexts.push({
        executionTeamName: context.executionTeamName,
        projectPath: context.projectPath,
        stillAlive: false,
        appearedDuringStop: true,
      });
    }
  } catch (error) {
    verificationError = error instanceof Error ? error.message : String(error);
  }
  for (const outcome of contexts) {
    try {
      outcome.stillAlive = !(await ports.isStopped(outcome.executionTeamName));
    } catch (error) {
      outcome.stillAlive = true;
      outcome.error ??= error instanceof Error ? error.message : String(error);
    }
  }
  return {
    team: group.team,
    contexts,
    complete:
      verificationError === undefined &&
      contexts.every((outcome) => !outcome.error && !outcome.stillAlive),
    ...(verificationError === undefined ? {} : { verificationError }),
  };
}

export function assertLogicalStopComplete(outcome: LogicalStopOutcome<unknown>): void {
  if (outcome.complete) return;
  const failed = outcome.contexts
    .filter((context) => context.error || context.stillAlive)
    .map(
      (context) =>
        `${context.projectPath ?? 'own process'} (${context.executionTeamName}): ` +
        (context.error ??
          (context.appearedDuringStop
            ? 'started while the stop was running'
            : 'still running after the stop'))
    );
  if (outcome.verificationError) {
    failed.push(`could not re-read the project contexts: ${outcome.verificationError}`);
  }
  throw new LogicalStopIncompleteError(
    `Stop of team "${outcome.team}" did not complete: ${failed.join('; ')}`,
    outcome
  );
}
