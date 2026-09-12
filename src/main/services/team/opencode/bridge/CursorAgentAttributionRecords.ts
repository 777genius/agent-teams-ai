import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getAppDataBasePath, getClaudeBasePath } from '@main/utils/pathDecoder';

import { buildOpenCodeAppProfileScope } from './OpenCodeMcpBridgeEnv';

/**
 * The `cursor-agent` processes the runtime has recorded as its own, read back
 * by the app that designated where to record them.
 *
 * A lead is spawned by `opencode serve`, never by this app, and a process table
 * answers with a JOINED command line that cannot be split back into the argv
 * the spawner used. Nothing the app can observe therefore tells one team's lead
 * from another's, or from a `cursor-agent --print` the user started in the same
 * directory - the gap the sweep header in `CursorAgentProcessCleanup.ts`
 * describes. The process that does know is the spawned one: it records its own
 * pid, its own start time and its own `--workspace` argument, into a directory
 * this app names in the bridge environment (`AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR`).
 *
 * Two files joined by one id, because a serve host is keyed by project and
 * profile scope while the team, run and lane it works for is a lease set that
 * changes while the host lives:
 *
 * - `v1/agents/<attributionId>/<pid>-<startedAtMs>.json` - written by the agent
 *   process itself, so its pid and argv are exact;
 * - `v1/hosts/<attributionId>.json` - written by the runtime that spawned it,
 *   carrying the owners that host currently holds leases for.
 *
 * This module reads, and what it reads is identity - never liveness. A record
 * outlives a SIGKILL, so a caller that acts on one has to re-read the live start
 * time itself and kill in the same turn as that check; that fence belongs where
 * the kill is, and lands with the proof path rather than here. Unreadable or
 * invalid agent records contribute nothing. A readable agent whose host cannot
 * be validated carries an unnamed owner, so missing host evidence cannot be
 * mistaken for an explicitly released lease set.
 */

/** The directory the app designates, and the runtime writes its records into. */
export const AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV = 'AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR';

/**
 * The only layout this app understands. A record of any other version is
 * ignored rather than guessed at, exactly as an unknown runtime store manifest
 * version is: guessing a schema is how a reader invents evidence.
 */
export const CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION = 1;

const ATTRIBUTION_LAYOUT_DIR = 'v1';
const ATTRIBUTION_HOSTS_DIR = 'hosts';
const ATTRIBUTION_AGENTS_DIR = 'agents';
const ATTRIBUTION_RECORD_SUFFIX = '.json';
const BRIDGE_CONTROL_DIR_NAME = 'opencode-bridge';
const PROCESS_ATTRIBUTION_DIR_NAME = 'process-attribution';

export type CursorAgentAttributionKind = 'cursor-agent' | 'readiness-probe';

/** One team/run/lane lease the recorded host held when it last wrote its record. */
export interface CursorAgentAttributionOwner {
  teamId: string | null;
  teamName: string | null;
  laneId: string | null;
  memberName: string | null;
  runId: string | null;
  sessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CursorAgentAttributionHostRecord {
  schemaVersion: typeof CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION;
  attributionId: string;
  hostPid: number;
  /**
   * Opaque on purpose: the runtime's own start-time reading is a per-platform
   * value (Linux clock ticks since boot, not epoch milliseconds), so the app
   * carries it without comparing it and compares only what it read itself.
   */
  hostStartedAtNative: number | string | null;
  hostStartTimeFormat: string | null;
  projectPath: string | null;
  appInstanceId: string | null;
  appProfileScope: string;
  runtimeVersion: string | null;
  owners: readonly CursorAgentAttributionOwner[];
  updatedAt: string | null;
}

export interface CursorAgentAttributionRecord {
  schemaVersion: typeof CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION;
  /**
   * `readiness-probe` is the one cursor-agent the runtime spawns for itself.
   * The sweep documents it as a tree it must never reap; a record turns that
   * comment into evidence.
   */
  kind: CursorAgentAttributionKind;
  attributionId: string;
  pid: number;
  parentPid: number | null;
  /** Unix epoch milliseconds, UTC - the clock `readProcessStartTimeMs` answers in. */
  startedAtMs: number;
  startTimeToleranceMs: number | null;
  nativeStartToken: string | null;
  /** The exact `--workspace` argument, unjoined, or null when the agent had none. */
  workspacePath: string | null;
  cwd: string | null;
  appInstanceId: string | null;
  appProfileScope: string;
  hostPid: number | null;
  runtimeVersion: string | null;
  writtenAtMs: number;
  exitedAtMs: number | null;
}

/**
 * An agent record with the host that spawned it. `host` is null when no host
 * record can be validated for the id and profile. `owners` then contains an
 * unnamed owner that vetoes lease clearance. Only a validated host with an
 * explicitly empty owner list reports an empty lease set.
 */
export interface AttributedCursorAgentProcess {
  record: CursorAgentAttributionRecord;
  host: CursorAgentAttributionHostRecord | null;
  owners: readonly CursorAgentAttributionOwner[];
}

export interface ReadAttributedCursorAgentProcessOptions {
  /** Defaults to the directory this app designates in the bridge environment. */
  directory?: string;
  /** Defaults to this install's own profile scope. */
  appProfileScope?: string;
}

/**
 * The directory the runtime is told to write into, and the one this app reads
 * back. It is a sibling of the bridge control directory, under the same
 * `userData` root, so a second install writes somewhere else entirely.
 *
 * An explicit value in the environment wins, the way the identity store path
 * does: whatever the runtime was handed is what it wrote to. It is made
 * absolute before it travels, because the runtime is launched from each
 * project's own working directory: a relative value would name a different
 * place for the writer than for this reader.
 */
export function resolveCursorAgentAttributionDirectory(
  env: NodeJS.ProcessEnv = process.env
): string {
  const designated = env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]?.trim();
  if (designated) return path.resolve(designated);
  return path.join(getAppDataBasePath(), BRIDGE_CONTROL_DIR_NAME, PROCESS_ATTRIBUTION_DIR_NAME);
}

/**
 * Designates the directory on a bridge environment, and creates it best effort
 * so the runtime writing the first record does not have to.
 *
 * The creation is best effort for the same reason every other directory under
 * the bridge control root is created that way: a directory this app cannot
 * create means no records, and no records means the callers keep the
 * attribution they have today.
 */
export async function applyCursorAgentAttributionEnv(
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const directory = resolveCursorAgentAttributionDirectory(env);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    // A runtime that cannot write records leaves the app exactly as blind as it
    // is today, which is a supported state, not a launch failure - but not a
    // silent one either, or an empty store would be indistinguishable from this.
    console.error(
      `[CursorAgentAttribution] failed to create the attribution directory ${directory}`,
      error
    );
  }
  env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV] = directory;
  return env;
}

/**
 * Every agent record this install may look at, joined with its host's owners.
 *
 * Never throws: unreadable or invalid agent records contribute nothing. A
 * missing, unreadable or rejected host contributes an unnamed owner to its
 * readable agents, preserving the distinction from an explicitly empty lease set.
 *
 * Records name the install that asked for them, and only this install's are
 * returned. A second copy of the app hashes to a different profile scope and is
 * not evidence here. The app INSTANCE id is deliberately not compared: a tree
 * left behind by a previous run of this same install is precisely what the
 * startup sweep exists to reach.
 */
export async function readAttributedCursorAgentProcesses(
  options: ReadAttributedCursorAgentProcessOptions = {}
): Promise<readonly AttributedCursorAgentProcess[]> {
  try {
    const appProfileScope = options.appProfileScope ?? resolveAppProfileScope();
    if (!appProfileScope) return [];
    const root = path.join(
      options.directory ?? resolveCursorAgentAttributionDirectory(),
      ATTRIBUTION_LAYOUT_DIR
    );
    const hosts = await readHostRecords(path.join(root, ATTRIBUTION_HOSTS_DIR), appProfileScope);
    const records = await readAgentRecords(
      path.join(root, ATTRIBUTION_AGENTS_DIR),
      appProfileScope
    );
    records.sort((left, right) =>
      left.attributionId === right.attributionId
        ? left.pid - right.pid
        : left.attributionId.localeCompare(right.attributionId)
    );
    return records.map((record) => {
      const host = hosts.get(record.attributionId) ?? null;
      return { record, host, owners: host?.owners ?? [UNNAMED_OWNER] };
    });
  } catch (error) {
    console.error('[CursorAgentAttribution] failed to read the attribution records', error);
    return [];
  }
}

/** What a caller may say about records it is not yet allowed to act on. */
export function summarizeAttributedCursorAgentProcesses(
  processes: readonly AttributedCursorAgentProcess[]
): { total: number; withRecordedOwner: number } {
  return {
    total: processes.length,
    withRecordedOwner: processes.filter(
      (entry) =>
        entry.host !== null &&
        entry.owners.some((owner) => Boolean(owner.teamName?.trim() || owner.teamId?.trim()))
    ).length,
  };
}

export interface CursorAgentAttributionPort {
  readAttributedProcesses(): Promise<readonly AttributedCursorAgentProcess[]>;
}

export const DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT: CursorAgentAttributionPort = {
  readAttributedProcesses: () => readAttributedCursorAgentProcesses(),
};

/**
 * The same hash the bridge environment carries, over the same two authority
 * roots. A scope this app cannot compute is not a reason to widen the filter:
 * it answers with no records.
 */
function resolveAppProfileScope(): string | null {
  try {
    return buildOpenCodeAppProfileScope(getAppDataBasePath(), getClaudeBasePath());
  } catch {
    return null;
  }
}

async function readHostRecords(
  directory: string,
  appProfileScope: string
): Promise<ReadonlyMap<string, CursorAgentAttributionHostRecord>> {
  const hosts = new Map<string, CursorAgentAttributionHostRecord>();
  for (const fileName of await listRecordFileNames(directory)) {
    const host = parseHostRecord(await readJsonFile(path.join(directory, fileName)));
    if (!host) continue;
    // The file name is the join key the agent records are matched by, so a
    // payload naming a different id would lend its owners to trees its host
    // never spawned. Corrupt, not a second opinion - the rule the agent
    // directory below applies as well.
    if (fileName !== `${host.attributionId}${ATTRIBUTION_RECORD_SUFFIX}`) continue;
    if (host.appProfileScope !== appProfileScope) continue;
    hosts.set(host.attributionId, host);
  }
  return hosts;
}

async function readAgentRecords(
  directory: string,
  appProfileScope: string
): Promise<CursorAgentAttributionRecord[]> {
  const records: CursorAgentAttributionRecord[] = [];
  for (const attributionId of await listSubdirectoryNames(directory)) {
    const agentDirectory = path.join(directory, attributionId);
    for (const fileName of await listRecordFileNames(agentDirectory)) {
      const record = parseAgentRecord(await readJsonFile(path.join(agentDirectory, fileName)));
      if (!record) continue;
      // The directory name is the join key the host record is found by, so a
      // record that disagrees with it would join to a host that never spawned
      // it. That is a corrupt record, not a second opinion.
      if (record.attributionId !== attributionId) continue;
      if (record.appProfileScope !== appProfileScope) continue;
      records.push(record);
    }
  }
  return records;
}

/** A directory that cannot be listed - an older runtime wrote none - holds nothing. */
async function listRecordFileNames(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(ATTRIBUTION_RECORD_SUFFIX))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listSubdirectoryNames(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A half-written or unparseable record is not evidence, and not a failure either. */
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function parseAgentRecord(value: unknown): CursorAgentAttributionRecord | null {
  const source = asObject(value);
  if (!source) return null;
  if (source.schemaVersion !== CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION) return null;
  const kind = readString(source, 'kind');
  const attributionId = readString(source, 'attributionId');
  const pid = readPositiveInteger(source, 'pid');
  const startedAtMs = readPositiveInteger(source, 'startedAtMs');
  const appProfileScope = readString(source, 'appProfileScope');
  const writtenAtMs = readPositiveInteger(source, 'writtenAtMs');
  if (!isAttributionKind(kind)) return null;
  if (!attributionId || !pid || !startedAtMs || !appProfileScope || !writtenAtMs) return null;
  return {
    schemaVersion: CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION,
    kind,
    attributionId,
    pid,
    parentPid: readPositiveInteger(source, 'parentPid'),
    startedAtMs,
    startTimeToleranceMs: readPositiveInteger(source, 'startTimeToleranceMs'),
    nativeStartToken: readString(source, 'nativeStartToken'),
    workspacePath: readString(source, 'workspacePath'),
    cwd: readString(source, 'cwd'),
    appInstanceId: readString(source, 'appInstanceId'),
    appProfileScope,
    hostPid: readPositiveInteger(source, 'hostPid'),
    runtimeVersion: readString(source, 'runtimeVersion'),
    writtenAtMs,
    exitedAtMs: readPositiveInteger(source, 'exitedAtMs'),
  };
}

function parseHostRecord(value: unknown): CursorAgentAttributionHostRecord | null {
  const source = asObject(value);
  if (!source) return null;
  if (source.schemaVersion !== CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION) return null;
  const attributionId = readString(source, 'attributionId');
  const hostPid = readPositiveInteger(source, 'hostPid');
  const appProfileScope = readString(source, 'appProfileScope');
  if (!attributionId || !hostPid || !appProfileScope) return null;
  const hostStartedAtNative = source.hostStartedAtNative;
  return {
    schemaVersion: CURSOR_AGENT_ATTRIBUTION_SCHEMA_VERSION,
    attributionId,
    hostPid,
    hostStartedAtNative:
      typeof hostStartedAtNative === 'number' || typeof hostStartedAtNative === 'string'
        ? hostStartedAtNative
        : null,
    hostStartTimeFormat: readString(source, 'hostStartTimeFormat'),
    projectPath: readString(source, 'projectPath'),
    appInstanceId: readString(source, 'appInstanceId'),
    appProfileScope,
    runtimeVersion: readString(source, 'runtimeVersion'),
    owners: parseOwners(source.owners),
    updatedAt: readString(source, 'updatedAt'),
  };
}

/** What an owner this app cannot read at all is reported as. */
const UNNAMED_OWNER: CursorAgentAttributionOwner = {
  teamId: null,
  teamName: null,
  laneId: null,
  memberName: null,
  runId: null,
  sessionId: null,
  createdAt: null,
  updatedAt: null,
};

/**
 * The host's lease set, read so that a caller is only ever told about MORE
 * owners than it can name, never fewer. An entry this app cannot read, and a
 * set that is not a list at all, become an owner with no name: a caller that
 * has to prove it may clear every lease refuses on the unnamed one, where
 * dropping it would have turned schema drift or a corrupt file into "nobody
 * owns this host" - the one reading that lets a stop reach a tree it does not
 * own.
 */
function parseOwners(value: unknown): readonly CursorAgentAttributionOwner[] {
  if (!Array.isArray(value)) return [UNNAMED_OWNER];
  return value.map((entry) => {
    const source = asObject(entry);
    if (!source) return UNNAMED_OWNER;
    return {
      teamId: readString(source, 'teamId'),
      teamName: readString(source, 'teamName'),
      laneId: readString(source, 'laneId'),
      memberName: readString(source, 'memberName'),
      runId: readString(source, 'runId'),
      sessionId: readString(source, 'sessionId'),
      createdAt: readString(source, 'createdAt'),
      updatedAt: readString(source, 'updatedAt'),
    };
  });
}

function isAttributionKind(value: string | null): value is CursorAgentAttributionKind {
  return value === 'cursor-agent' || value === 'readiness-probe';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Verbatim, never trimmed: a workspace path is compared exactly, spaces included. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readPositiveInteger(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
