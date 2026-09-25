import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { connect, type IncomingHttpHeaders, type IncomingHttpStatusHeader } from 'node:http2';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  expect,
  type Page,
  type Request,
  type Response,
  test,
  type TestInfo,
} from '@playwright/test';

import {
  assertHostedV1ExternalCoordinationStreamProof,
  captureOriginalHostedV1HttpResponse,
  createHostedV1ExternalCoordinationReplayBudget,
  createHostedV1ProbeDeadlineBudget,
  freezeHostedV1DiagnosticFailures,
  HostedV1ArtifactPersistenceError,
  type HostedV1ExternalCoordinationObservedEvent,
  type HostedV1ProbeDeadlineBudget,
  redactEvidence,
  restartHostedV1LifecycleOwner,
  pollHostedV1ExternalCoordinationReconnectProof,
  runHostedV1BestEffortDiagnostic,
  writeHostedV1AtomicArtifact,
} from '../../../scripts/e2e/hosted-v1/run';
import { encodeReplayCursor } from '../../../src/features/coordination-events';
import { advanceHostedV1MountGeneration } from '../../fixtures/hosted-v1/createSandbox';

interface RuntimeInput {
  readonly authMode: 'oidc' | 'oidc-viewer' | 'personal';
  readonly composeFile: string;
  readonly composeProject: string;
  readonly appDataDir: string;
  readonly controllerProjectObservationFile: string;
  readonly eventCursor: string;
  readonly fakeRuntimeLifecycleTraceFile: string;
  readonly fakeRuntimeStateFile: string;
  readonly forbiddenWorkspaceId: string;
  readonly origin: string;
  readonly pairingCode: string | null;
  readonly sandboxRoot: string;
  readonly lifecycleTrustAnchor: string;
  readonly projectWorkspaceId: string;
  readonly runtimeWorkspaceId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly workspaceId: string;
  readonly workspaceDir: string;
}

interface HostedV1ExternalCoordinationStreamEvent extends HostedV1ExternalCoordinationObservedEvent {
  readonly id: string;
  readonly deploymentId: string | null;
  readonly eventEpoch: string | null;
  readonly eventCursor: string | null;
  readonly scopeKind: string | null;
  readonly scopeId: string | null;
  readonly eventType: string | null;
  readonly payload: unknown;
}

interface HostedV1ExternalCoordinationStreamState {
  activeStreamId: number | null;
  controller: AbortController | null;
  opens: number;
  ids: string[];
  events: HostedV1ExternalCoordinationStreamEvent[];
  frames: Array<'heartbeat' | 'coordination_event'>;
  heartbeats: number;
  heartbeatFrameIndexes: number[];
  heartbeatStreamIds: number[];
  heartbeatObservedAtMs: number[];
  heartbeatCursors: string[];
  heartbeatEventCounts: number[];
  reconnects: number;
  cursor: string;
  reconnectTimer: number | null;
  closed: boolean;
  error: string | null;
}

function requireHostedV1JournalString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`hosted_e2e_journal_${name}_invalid`);
  }
  return value;
}

function requireHostedV1JournalSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('hosted_e2e_journal_event_sequence_invalid');
  }
  return value;
}

const runtimePath = process.env.HOSTED_E2E_RUNTIME_FILE;
if (!runtimePath) throw new Error('HOSTED_E2E_RUNTIME_FILE is required');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeInput;
const hostedV1DiagnosticRedactionContext = Object.freeze({
  root: runtime.sandboxRoot,
  lifecycleTrustAnchor: runtime.lifecycleTrustAnchor,
});
const hostedV1DiagnosticSourceRedaction = Object.freeze({
  replacements: Object.freeze([
    Object.freeze({ value: process.cwd(), placeholder: '<repository-root>' }),
    Object.freeze({ value: runtime.sandboxRoot, placeholder: '<sandbox-root>' }),
    Object.freeze({ value: runtime.workspaceDir, placeholder: '<workspace-root>' }),
    Object.freeze({ value: runtime.appDataDir, placeholder: '<runtime-app-data-root>' }),
    Object.freeze({ value: runtime.lifecycleTrustAnchor, placeholder: '<trust-anchor>' }),
    Object.freeze({ value: '/workspaces/sandbox', placeholder: '<runtime-workspace-root>' }),
    Object.freeze({ value: '/data/.claude', placeholder: '<runtime-claude-root>' }),
    Object.freeze({ value: '/data/.agent-teams', placeholder: '<runtime-app-data-root>' }),
    Object.freeze({ value: '/run/agent-teams-orchestrator', placeholder: '<lifecycle-runtime-root>' }),
    Object.freeze({ value: '/run/agent-teams', placeholder: '<runtime-state-root>' }),
    ...(runtime.pairingCode === null
      ? []
      : [Object.freeze({ value: runtime.pairingCode, placeholder: '<pairing-code>' })]),
  ]),
  maximumBytes: 16 * 1024,
});

function hostedV1AttachmentRetentionBudget(root: string): {
  readonly root: string;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
} {
  return Object.freeze({ root, maximumFileBytes: 16 * 1024, maximumTotalBytes: 4 * 1024 * 1024 });
}
const fakeRuntimeOwnerMutationErrorTraceFile = resolve(
  runtime.fakeRuntimeLifecycleTraceFile,
  '..',
  'owner-mutation-error-trace.json'
);
if (
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.workspaceId) ||
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.projectWorkspaceId) ||
  !/^workspace_[0-9a-f]{32}$/u.test(runtime.forbiddenWorkspaceId) ||
  new Set([runtime.workspaceId, runtime.projectWorkspaceId, runtime.forbiddenWorkspaceId]).size !==
    3
) {
  throw new Error('hosted_e2e_workspace_identity_invalid');
}
const execFileAsync = promisify(execFile);
const composeFile = process.env.COMPOSE_FILE;
const composeProject = process.env.COMPOSE_PROJECT_NAME;

if (
  !composeFile ||
  !composeProject ||
  !isAbsolute(composeFile) ||
  resolve(composeFile) !== composeFile ||
  (await realpath(composeFile)) !== composeFile ||
  composeFile !== runtime.composeFile ||
  composeProject !== runtime.composeProject ||
  !/^at-hosted-v1-[0-9a-f]{24}$/u.test(composeProject)
) {
  throw new Error('hosted_e2e_compose_context_invalid');
}
const validatedComposeFile = composeFile;
const validatedComposeProject = composeProject;
// The fake runtime is a separate process and therefore cannot use the
// controller's in-process wakeup hint. The origin covers both handoff and
// durable replay; valid streams may emit any number of heartbeats meanwhile.
const externalCoordinationReplayBudget = createHostedV1ExternalCoordinationReplayBudget({
  handoffBudgetMs: 10_000,
  heartbeatIntervalMs: 15_000,
  // Reserve a deterministic quiet window after the resumed-stream heartbeat.
  marginMs: 2_000,
});
const E2E_DOCKER_COMMAND_TIMEOUT_MS = 60_000;
const E2E_PROBE_RESPONSE_MAX_BYTES = 64 * 1024;
const E2E_PROBE_ATTEMPT_TIMEOUT_MS = 5_000;

type RunAcceptedJournalObservation = {
  readonly schemaVersion: 1;
  readonly status: 'observed' | 'not_found' | 'unavailable';
  readonly runId: string;
  readonly row?: Record<string, unknown> | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly error?: string;
};

async function readRunAcceptedJournalObservation(
  runId: string,
  timeoutOrSignal: number | AbortSignal = 1_000,
  signal?: AbortSignal
): Promise<RunAcceptedJournalObservation> {
  const timeoutMs = typeof timeoutOrSignal === 'number' ? timeoutOrSignal : 1_000;
  const diagnosticSignal = typeof timeoutOrSignal === 'number' ? signal : timeoutOrSignal;
  if (diagnosticSignal?.aborted) {
    throw Object.assign(new Error('hosted_e2e_journal_aborted'), { name: 'AbortError' });
  }
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('hosted_e2e_journal_read_timeout_invalid');
    }
    // better-sqlite3 is synchronous.  Running it in the Playwright process
    // makes a Promise.race timer cosmetic: the event loop cannot run the
    // timer while SQLite is blocked.  The isolated reader is killable, so its
    // one-second budget is real and cannot delay the handoff proof event loop.
    const program = String.raw`
      const [databasePath, runId] = process.argv.slice(1);
      const emit = (value) => process.stdout.write(JSON.stringify(value));
      try {
        const databaseModule = require('better-sqlite3-node');
        const Database = databaseModule.default || databaseModule;
        const database = new Database(databasePath, { fileMustExist: true, readonly: true });
        try {
          const row = database.prepare(
            "SELECT deployment_id AS deploymentId, event_epoch AS eventEpoch, event_id AS eventId, event_sequence AS eventSequence, json_extract(body_json, '$.eventType') AS eventType, json_extract(body_json, '$.runId') AS runId, json_extract(body_json, '$.teamId') AS teamId, json_extract(body_json, '$.scope.kind') AS scopeKind, json_extract(body_json, '$.scope.scopeId') AS scopeId, json_extract(body_json, '$.payload.runId') AS payloadRunId FROM coordination_event_journal WHERE json_extract(body_json, '$.eventType') = ? AND json_extract(body_json, '$.runId') = ? ORDER BY event_sequence DESC LIMIT 1"
          ).get('team-lifecycle.run-accepted', runId);
          const metadata = row ? database.prepare(
            'SELECT deployment_id AS deploymentId, event_epoch AS eventEpoch, high_watermark_sequence AS highWatermarkSequence FROM coordination_event_journal_metadata WHERE deployment_id = ?'
          ).get(row.deploymentId) : null;
          emit({ schemaVersion: 1, status: row && metadata ? 'observed' : 'not_found', runId, row: row || null, metadata: metadata || null });
        } finally { database.close(); }
      } catch (error) {
        const code = error && typeof error === 'object' && error.code === 'ENOENT' ? 'ENOENT' : null;
        emit({
          schemaVersion: 1,
          status: code === 'ENOENT' ? 'not_found' : 'unavailable',
          runId,
          ...(code === 'ENOENT' ? {} : { error: error instanceof Error ? error.name : 'unknown_error' }),
        });
      }
    `;
    const result = await execFileAsync(process.execPath, [
      '-e', program, `${runtime.appDataDir}/data/storage/app.db`, runId,
    ], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      signal: diagnosticSignal,
    });
    if (diagnosticSignal?.aborted) {
      throw Object.assign(new Error('hosted_e2e_journal_aborted'), { name: 'AbortError' });
    }
    return JSON.parse(result.stdout) as RunAcceptedJournalObservation;
  } catch (error) {
    return {
      schemaVersion: 1,
      status: 'unavailable',
      runId,
      error: error instanceof Error ? error.name : 'unknown_error',
    };
  }
}

async function attachExternalCoordinationEvidence(
  testInfo: TestInfo,
  phase: 'launch-receipt' | 'predicate-expiry',
  runId: string,
  page: Page,
  eventRequestUrls: readonly string[],
  initialEventStreamStatus: number,
  timing?: Record<string, number>,
  priorDiagnosticFailures: readonly string[] = []
): Promise<readonly string[]> {
  // Continue the caller's collector when supplied so snapshots retain each
  // failed operation once, in the order it was observed.
  const failures = (priorDiagnosticFailures.length > 0
    ? priorDiagnosticFailures
    : hostedV1DiagnosticFailures(testInfo)) as string[];
  const allFailures = () => freezeHostedV1DiagnosticFailures(failures);
  const journal = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'journal_read', operation: (signal) => readRunAcceptedJournalObservation(runId, signal),
  });
  // A missing row is a valid observation while the journal is catching up or
  // when the selected run emitted no accepted event.  A reader failure is
  // different: retain its structured evidence in the scenario-wide aggregate
  // without turning this best-effort attachment into a proof failure.
  if (journal?.status === 'unavailable') {
    recordHostedV1DiagnosticObservation(testInfo, {
      operation: 'journal_read',
      classification: 'failed_observation',
      error: journal.error ?? 'unknown_error',
      timing: Object.freeze({ observedAtMs: Date.now(), ...(timing ?? {}) }),
    });
  }
  const streamState = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'page_evaluate', operation: async (signal) => {
      if (signal.aborted) return null;
      const result = await page.evaluate(() => {
          const state = window.__hostedE2eSse;
          return state
            ? {
                activeStreamId: state.activeStreamId,
                error: state.error,
                opens: state.opens,
                ids: state.ids,
                events: state.events,
                reconnects: state.reconnects ?? 0,
                cursor: state.cursor,
              }
            : null;
      });
      return signal.aborted ? null : result;
    },
  });
  const attach = async (name: string, body: unknown): Promise<void> => {
    await trackHostedV1BestEffortDiagnostic(testInfo, { name: `attach:${name}`, operation: async (signal) => {
      if (signal.aborted) return;
      await testInfo.attach(name, {
        body: JSON.stringify({ ...((body ?? {}) as object), diagnosticFailures: allFailures() }, null, 2),
        contentType: 'application/json',
      });
      if (signal.aborted) return;
    }});
  };
  await attach(`personal-lifecycle-journal-${phase}.json`, {
    phase,
    observedAt: new Date().toISOString(),
    timing,
    journal,
    diagnosticFailures: failures,
  });
  await attach(`personal-lifecycle-sse-${phase}.json`, {
    phase,
    observedAt: new Date().toISOString(),
    timing,
    initialResponseStatus: initialEventStreamStatus,
    requestUrls: eventRequestUrls,
    state: streamState,
    diagnosticFailures: failures,
  });
  // This final attachment is a frozen aggregate of every failure observed
  // while all prior attachments were attempted.  It is deliberately last so
  // an earlier failed attachment cannot disappear from the evidence.
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: `attach:personal-lifecycle-diagnostic-failures-${phase}.json`,
    operation: async (signal) => {
      if (signal.aborted) return;
      await testInfo.attach(`personal-lifecycle-diagnostic-failures-${phase}.json`, {
      body: JSON.stringify(Object.freeze({
        schemaVersion: 1,
        phase,
        attachmentFailures: allFailures(),
      }), null, 2),
      contentType: 'application/json',
      });
      if (signal.aborted) return;
    },
  });
  // testInfo.attach can itself fail, including for the aggregate attachment.
  // Persist a complete replacement snapshot separately.  Repeating a phase
  // updates (rather than rejects) the deterministic artifact with all later
  // failures included.
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: `write:personal-lifecycle-diagnostic-failures-${phase}.immutable.json`,
    awaitAbortReap: true,
    operation: async (signal) => {
      if (signal.aborted) return;
      const path = join(testInfo.outputDir, `personal-lifecycle-diagnostic-failures-${phase}.immutable.json`);
      const body = JSON.stringify(Object.freeze({
        schemaVersion: 1,
        phase,
        attachmentFailures: allFailures(),
      }), null, 2);
      await writeHostedV1AtomicArtifact({
        path,
        body,
        sanitizeBody: (value) => redactEvidence(
          value,
          hostedV1DiagnosticRedactionContext,
          runtime.pairingCode
        ),
        retentionBudget: hostedV1AttachmentRetentionBudget(testInfo.outputDir),
        timeoutMs: 1_000,
        signal,
      });
    },
  });
  return allFailures();
}

/**
 * Attachments are diagnostics, never proof prerequisites.  Keep this wrapper
 * at the TestInfo boundary so every evidence attachment in a scenario has the
 * same failure semantics, including legacy call sites.
 */
interface HostedV1DiagnosticObservationFailure {
  readonly operation: string;
  readonly classification: 'failed_observation';
  readonly error: string;
  readonly timing: Readonly<Record<string, number>>;
}

interface HostedV1DiagnosticCollector {
  readonly failures: string[];
  readonly observations: HostedV1DiagnosticObservationFailure[];
  /** Admission closes before the final snapshot is written. */
  accepting: boolean;
  /** Started wrappers may merge until the one final drain has settled them. */
  collecting: boolean;
  readonly pending: Map<Promise<unknown>, AbortController>;
}

const hostedV1DiagnosticCollectors = new WeakMap<object, HostedV1DiagnosticCollector>();
const HOSTED_V1_FINAL_DIAGNOSTIC_DRAIN_TIMEOUT_MS = 2_000;

function hostedV1DiagnosticFailures(testInfo: TestInfo): string[] {
  const collector = hostedV1DiagnosticCollectors.get(testInfo);
  if (!collector) throw new Error('hosted_e2e_diagnostic_collector_missing');
  return collector.failures;
}

function recordHostedV1DiagnosticObservation(
  testInfo: TestInfo,
  observation: HostedV1DiagnosticObservationFailure
): void {
  const collector = hostedV1DiagnosticCollectors.get(testInfo);
  if (!collector) throw new Error('hosted_e2e_diagnostic_collector_missing');
  if (!collector.accepting) return;
  collector.observations.push(Object.freeze({
    ...observation,
    timing: Object.freeze({ ...observation.timing }),
  }));
}

function freezeHostedV1DiagnosticAggregate(testInfo: TestInfo): Readonly<{
  attachmentFailures: readonly string[];
  observationFailures: readonly HostedV1DiagnosticObservationFailure[];
}> {
  const collector = hostedV1DiagnosticCollectors.get(testInfo);
  if (!collector) throw new Error('hosted_e2e_diagnostic_collector_missing');
  return Object.freeze({
    attachmentFailures: freezeHostedV1DiagnosticFailures(collector.failures),
    observationFailures: Object.freeze([...collector.observations]),
  });
}

function trackHostedV1BestEffortDiagnostic<T>(
  testInfo: TestInfo,
  input: {
    readonly name: string;
    readonly operation: (signal: AbortSignal) => Promise<T>;
    readonly timeoutMs?: number;
    readonly awaitAbortReap?: boolean;
  }
): Promise<T | null> {
  const collector = hostedV1DiagnosticCollectors.get(testInfo);
  if (!collector) throw new Error('hosted_e2e_diagnostic_collector_missing');
  // Event callbacks can arrive while afterEach is persisting the final
  // snapshot.  Refusing admission here prevents them from attaching evidence
  // after that snapshot has become authoritative.
  if (!collector.accepting) return Promise.resolve(null);
  const controller = new AbortController();
  // A wrapper gets a private sink until it reaches terminal settlement.  This
  // is what makes the final drain authoritative: a wrapper which outlives a
  // failed-closed drain has no reference capable of appending to the final
  // aggregate later.
  const wrapperFailures: string[] = [];
  const running = runHostedV1BestEffortDiagnostic({
    ...input,
    failures: wrapperFailures,
    signal: controller.signal,
  });
  const diagnostic = running.then(
    (result) => {
      if (collector.collecting) collector.failures.push(...wrapperFailures);
      return result;
    },
    (error) => {
      if (collector.collecting) {
        collector.failures.push(
          `${input.name}:${error instanceof Error ? error.name : 'unknown_error'}`
        );
      }
      throw error;
    }
  );
  collector.pending.set(diagnostic, controller);
  void diagnostic.then(
    () => collector.pending.delete(diagnostic),
    () => collector.pending.delete(diagnostic)
  );
  return diagnostic;
}

async function settleHostedV1Diagnostics(testInfo: TestInfo): Promise<void> {
  const collector = hostedV1DiagnosticCollectors.get(testInfo);
  if (!collector) throw new Error('hosted_e2e_diagnostic_collector_missing');
  // Finalization is an admission gate, not merely a snapshot. Abort every
  // in-flight operation, then give every already-admitted wrapper one bounded
  // terminal-settlement window.  A timeout is fail-closed: serializing while a
  // wrapper could still append a failure would make the aggregate dishonest.
  collector.accepting = false;
  for (const controller of collector.pending.values()) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([
      Promise.allSettled([...collector.pending.keys()]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), HOSTED_V1_FINAL_DIAGNOSTIC_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (!drained) throw new Error('hosted_e2e_final_diagnostic_drain_timeout');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // No wrapper may mutate the aggregate after this point, including an
    // intentionally non-cooperative API which completes after a drain fault.
    collector.collecting = false;
    Object.freeze(collector.failures);
    Object.freeze(collector.observations);
  }
}

async function persistHostedV1FinalDiagnosticFailures(testInfo: TestInfo): Promise<void> {
  await settleHostedV1Diagnostics(testInfo);
  // This is the one final persistence point. It follows every independently
  // bounded diagnostic, including shutdown, reconnect, OIDC, and a proof
  // failure's finally path.
  // This is deliberately outside the closed collector: a late failed write
  // must not mutate the aggregate after its authoritative snapshot.
  const path = join(testInfo.outputDir, 'hosted-v1-diagnostic-failures-final.json');
  const body = JSON.stringify({ schemaVersion: 1, ...freezeHostedV1DiagnosticAggregate(testInfo) }, null, 2);
  // This record is deliberately synchronous and outside the artifact writer:
  // it remains observable even when the evidence filesystem is unavailable.
  console.error(JSON.stringify({
    event: 'hosted_e2e_final_diagnostic_persistence_attempt', path, timeoutMs: 2_000,
  }));
  try {
    await writeHostedV1AtomicArtifact({
      path,
      body,
      sanitizeBody: (value) => redactEvidence(
        value,
        hostedV1DiagnosticRedactionContext,
        runtime.pairingCode
      ),
      retentionBudget: hostedV1AttachmentRetentionBudget(testInfo.outputDir),
      timeoutMs: 2_000,
    });
    console.error(JSON.stringify({
      event: 'hosted_e2e_final_diagnostic_persistence_result', path, classification: 'published',
    }));
  } catch (error) {
    const classification = error instanceof HostedV1ArtifactPersistenceError
      ? error.classification
      : 'writer_failed';
    console.error(JSON.stringify({
      event: 'hosted_e2e_final_diagnostic_persistence_result', path, classification,
    }));
    throw new Error(`hosted_e2e_final_diagnostic_persistence_failed:${classification}:${path}`, {
      cause: error,
    });
  }
}

async function prepareHostedV1DiagnosticArtifact(
  testInfo: TestInfo,
  name: string,
  options: Parameters<TestInfo['attach']>[1],
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  // Do not read path-backed attachments here. File reads are preparation and
  // must share the writer's hard deadline instead of blocking this process.
  const preparedBody = options?.body === undefined
    ? options?.path === undefined ? '' : undefined
    : options.body;
  if (signal.aborted) return;
  const body = preparedBody === undefined
    ? undefined
    : typeof preparedBody === 'string' ? preparedBody : preparedBody.toString('utf8');
  await writeHostedV1AtomicArtifact({
    // Playwright's path helper may synchronously create or probe a directory. The
    // supervised writer owns all filesystem preparation, so derive the target
    // from TestInfo's pure outputDir value instead.
    path: join(testInfo.outputDir, name),
    ...(body === undefined
      ? {
          sourcePath: options?.path,
          sourceRedaction: hostedV1DiagnosticSourceRedaction,
        }
      : {
          body,
          sanitizeBody: (value) => redactEvidence(
            value,
            hostedV1DiagnosticRedactionContext,
            runtime.pairingCode
          ),
    }),
    retentionBudget: hostedV1AttachmentRetentionBudget(testInfo.outputDir),
    timeoutMs: 1_000,
    signal,
  });
}

async function attachHostedV1DiagnosticArtifact(
  testInfo: TestInfo,
  name: string,
  options: Parameters<TestInfo['attach']>[1]
): Promise<void> {
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: `attach:${name}`,
    awaitAbortReap: true,
    operation: (signal) => prepareHostedV1DiagnosticArtifact(testInfo, name, options, signal),
  });
}

function bestEffortDiagnosticTestInfo(testInfo: TestInfo): TestInfo {
  const collector: HostedV1DiagnosticCollector = {
    failures: [], observations: [], accepting: true, collecting: true, pending: new Map(),
  };
  hostedV1DiagnosticCollectors.set(testInfo, collector);
  const diagnosticTestInfo = new Proxy(testInfo, {
    get(target, property, receiver) {
      if (property === 'attach') {
        return (name: string, options: Parameters<TestInfo['attach']>[1]) =>
          attachHostedV1DiagnosticArtifact(testInfo, name, options);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  hostedV1DiagnosticCollectors.set(diagnosticTestInfo, collector);
  return diagnosticTestInfo;
}

test.afterEach(async ({}, testInfo) => {
  if (hostedV1DiagnosticCollectors.has(testInfo)) {
    await persistHostedV1FinalDiagnosticFailures(testInfo);
  }
});

declare global {
  interface Window {
    __hostedE2eSse?: HostedV1ExternalCoordinationStreamState;
    __hostedE2eProbe(
      input: string,
      init?: RequestInit,
      options?: {
        readonly attemptTimeoutMs?: number;
        readonly maximumBytes?: number;
        readonly overallDeadlineAtMs?: number;
      }
    ): Promise<{
      readonly status: number;
      readonly rawBody: string;
      readonly body: unknown;
    }>;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ defaultAttemptTimeoutMs, defaultMaximumBytes }) => {
      const nativeFetch = window.fetch.bind(window);
      window.__hostedE2eProbe = async (input, init = {}, options = {}) => {
        const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
        const attemptTimeoutMs = options.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
        const overallDeadlineAtMs =
          options.overallDeadlineAtMs ?? Date.now() + defaultAttemptTimeoutMs;
        if (
          !Number.isSafeInteger(maximumBytes) ||
          maximumBytes < 0 ||
          !Number.isSafeInteger(attemptTimeoutMs) ||
          attemptTimeoutMs < 1 ||
          !Number.isSafeInteger(overallDeadlineAtMs)
        ) {
          throw new Error('hosted_e2e_probe_limits_invalid');
        }
        const remainingMs = overallDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw new Error('hosted_e2e_probe_overall_deadline');
        const controller = new AbortController();
        const signal = init.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;
        const timeout = window.setTimeout(
          () => controller.abort(new Error('hosted_e2e_probe_attempt_deadline')),
          Math.max(1, Math.min(attemptTimeoutMs, remainingMs))
        );
        try {
          const response = await nativeFetch(input, { ...init, signal });
          const contentLength = response.headers.get('content-length');
          if (contentLength !== null) {
            if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
              const error = new Error('hosted_e2e_probe_content_length_invalid');
              void response.body?.cancel(error).catch(() => undefined);
              throw error;
            }
            const declaredBytes = Number(contentLength);
            if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
              const error = new Error('hosted_e2e_probe_body_too_large');
              void response.body?.cancel(error).catch(() => undefined);
              throw error;
            }
          }
          const chunks: Uint8Array[] = [];
          let receivedBytes = 0;
          if (response.body !== null) {
            const reader = response.body.getReader();
            let removeAbortListener = (): void => undefined;
            const abortRead = new Promise<never>((_resolve, reject) => {
              const onAbort = () => {
                void reader.cancel(signal.reason).catch(() => undefined);
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error('hosted_e2e_probe_attempt_deadline')
                );
              };
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
              if (signal.aborted) onAbort();
            });
            try {
              for (;;) {
                const { done, value } = await Promise.race([reader.read(), abortRead]);
                if (done) break;
                receivedBytes += value.byteLength;
                if (receivedBytes > maximumBytes) {
                  void reader.cancel('hosted_e2e_probe_body_too_large').catch(() => undefined);
                  throw new Error('hosted_e2e_probe_body_too_large');
                }
                chunks.push(new Uint8Array(value));
              }
            } finally {
              removeAbortListener();
            }
          }
          const bytes = new Uint8Array(receivedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          let rawBody: string;
          try {
            rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            throw new Error('hosted_e2e_probe_body_utf8_invalid');
          }
          let body: unknown = rawBody;
          try {
            body = JSON.parse(rawBody);
          } catch {
            // Some negative probes deliberately return an empty or non-JSON body.
          }
          return { status: response.status, rawBody, body };
        } finally {
          window.clearTimeout(timeout);
        }
      };
      window.fetch = (input, init = {}) =>
        nativeFetch(input, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(10_000),
        });
    },
    {
      defaultAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
      defaultMaximumBytes: E2E_PROBE_RESPONSE_MAX_BYTES,
    }
  );
});

async function exactRuntimeTeamButton(page: Page) {
  const row = page.locator(
    `[data-testid="hosted-team-lifecycle-row"][data-team-id="${runtime.teamId}"]`
  );
  await expect(row).toHaveCount(1);
  const button = row.getByRole('button');
  await expect(button).toHaveCount(1);
  return button;
}

async function compose(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    'docker',
    ['compose', '--project-name', validatedComposeProject, '--file', validatedComposeFile, ...args],
    {
      env: {
        ...process.env,
        COMPOSE_FILE: validatedComposeFile,
        COMPOSE_PROJECT_NAME: validatedComposeProject,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: E2E_DOCKER_COMMAND_TIMEOUT_MS,
    }
  );
  return `${result.stdout}${result.stderr}`;
}

async function composeDiagnostic(signal: AbortSignal, ...args: readonly string[]): Promise<string> {
  if (signal.aborted) throw Object.assign(new Error('hosted_e2e_compose_aborted'), { name: 'AbortError' });
  const result = await execFileAsync('docker', ['compose', '--project-name', validatedComposeProject, '--file', validatedComposeFile, ...args], {
    env: { ...process.env, COMPOSE_FILE: validatedComposeFile, COMPOSE_PROJECT_NAME: validatedComposeProject },
    maxBuffer: 8 * 1024 * 1024, timeout: E2E_DOCKER_COMMAND_TIMEOUT_MS, signal,
  });
  if (signal.aborted) throw Object.assign(new Error('hosted_e2e_compose_aborted'), { name: 'AbortError' });
  return `${result.stdout}${result.stderr}`;
}

async function docker(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', [...args], {
    env: {
      ...process.env,
      COMPOSE_FILE: validatedComposeFile,
      COMPOSE_PROJECT_NAME: validatedComposeProject,
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: E2E_DOCKER_COMMAND_TIMEOUT_MS,
  });
  return `${result.stdout}${result.stderr}`;
}

async function snapshotDirectoryFiles(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(resolve(directory, name), 'utf8')] as const)
    )
  );
}

async function selectRegisteredWorkspace(page: Page): Promise<void> {
  const workspaceButton = page.getByRole('button', { name: 'Workspace 1', exact: true });
  await expect(workspaceButton).toBeVisible();
  await workspaceButton.click();
  await expect(workspaceButton).toHaveAttribute('aria-pressed', 'true');
}

async function captureOriginalHttpResponse(
  response: Response,
  overallDeadlineAtMs = Date.now() + E2E_PROBE_ATTEMPT_TIMEOUT_MS
) {
  return captureOriginalHostedV1HttpResponse(response, {
    maximumBytes: E2E_PROBE_RESPONSE_MAX_BYTES,
    overallDeadlineAtMs,
  });
}

type OwnerMutationErrorTraceObservation = Readonly<{
  status: 'observed' | 'not_found' | 'unavailable';
  body: Buffer | null;
  error?: string;
}>;

async function attachOwnerMutationErrorTraceIfPresent(
  testInfo: TestInfo,
  evidenceName: string
): Promise<void> {
  const trace = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: `read:${evidenceName}-owner-mutation-error-trace.json`,
    operation: async (signal): Promise<OwnerMutationErrorTraceObservation> => {
      if (signal.aborted) throw Object.assign(new Error('hosted_e2e_trace_aborted'), { name: 'AbortError' });
      try {
        const body = await readFile(fakeRuntimeOwnerMutationErrorTraceFile, { signal });
        if (signal.aborted) throw Object.assign(new Error('hosted_e2e_trace_aborted'), { name: 'AbortError' });
        return Object.freeze({ status: 'observed' as const, body });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return Object.freeze({ status: 'not_found' as const, body: null });
        }
        return Object.freeze({
          status: 'unavailable' as const,
          body: null,
          error: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    },
  });
  if (trace?.status === 'unavailable') {
    recordHostedV1DiagnosticObservation(testInfo, {
      operation: `read:${evidenceName}-owner-mutation-error-trace.json`,
      classification: 'failed_observation',
      error: trace.error ?? 'unknown_error',
      timing: Object.freeze({ observedAtMs: Date.now() }),
    });
  }
  const traceBody = trace?.status === 'observed' && trace.body !== null
    ? trace.body
    : JSON.stringify(Object.freeze({ schemaVersion: 1, kind: trace?.status ?? 'unavailable', error: trace?.error ?? null }));
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: `attach:${evidenceName}-owner-mutation-error-trace.json`,
    operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach(`${evidenceName}-owner-mutation-error-trace.json`, {
      body: traceBody,
      contentType: 'application/json',
    }),
  });
}

async function clickAndExpectCommittedTaskMutation(
  page: Page,
  testInfo: TestInfo,
  evidenceName: string,
  click: () => Promise<void>
): Promise<void> {
  const responsePromise = page
    .waitForResponse(
      (response) => {
        const request = response.request();
        return (
          request.method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/mutations'
        );
      },
      { timeout: 30_000 }
    )
    .then((response) => captureOriginalHttpResponse(response));
  // Keep Playwright from reporting a secondary unhandled rejection if the
  // interaction itself fails before the awaited response arrives.
  void responsePromise.catch(() => undefined);
  try {
    await click();
    const response = await responsePromise;
    await testInfo.attach(`${evidenceName}-task-mutation-response.json`, {
      body: JSON.stringify(response, null, 2),
      contentType: 'application/json',
    });
    expect(response.capture, `${evidenceName} response capture source`).toBe(
      'playwright_original_response'
    );
    expect(response.method, `${evidenceName} task mutation method`).toBe('POST');
    expect(new URL(response.url).pathname, `${evidenceName} task mutation path`).toBe(
      '/api/hosted/v1/team-task-board/mutations'
    );
    expect(response.status, `${evidenceName} task mutation status`).toBe(200);
    expect(JSON.parse(response.rawBody), `${evidenceName} task mutation body`).toMatchObject({
      schemaVersion: 1,
      outcome: 'committed',
      commandId: expect.stringMatching(/^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/u),
      teamId: runtime.teamId,
      sourceGeneration: expect.stringMatching(/^generation_/u),
      revision: expect.stringMatching(/^revision_/u),
      affectedTaskIds: expect.arrayContaining([expect.stringMatching(/^task_[0-9a-f]{32}$/u)]),
    });
  } catch (error) {
    await attachOwnerMutationErrorTraceIfPresent(testInfo, evidenceName);
    throw error;
  }
}

interface Http2ProbeResponse {
  readonly body: string;
  readonly headers: IncomingHttpHeaders & IncomingHttpStatusHeader;
}

function probeBoundedHttp2(input: {
  readonly authority?: string;
  readonly body?: string;
  readonly deadlineBudget?: HostedV1ProbeDeadlineBudget;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly origin: string;
  readonly path: string;
}): Promise<Http2ProbeResponse> {
  const deadlineBudget =
    input.deadlineBudget ??
    createHostedV1ProbeDeadlineBudget({
      overallTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
      perAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
    });
  let attemptTimeoutMs: number;
  try {
    attemptTimeoutMs = deadlineBudget.nextAttemptTimeoutMs();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolveProbe, rejectProbe) => {
    const target = new URL(input.origin);
    if (target.protocol !== 'https:' || !input.path.startsWith('/')) {
      rejectProbe(new Error('hosted_e2e_http2_probe_target_invalid'));
      return;
    }
    const session = connect(target.origin, {
      rejectUnauthorized: false,
      servername: target.hostname,
    });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let responseHeaders: (IncomingHttpHeaders & IncomingHttpStatusHeader) | undefined;
    let settled = false;
    let request: ReturnType<typeof session.request> | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      session.removeListener('error', fail);
      request?.removeListener('error', fail);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      session.destroy();
      rejectProbe(error);
    };
    const timeout = setTimeout(() => {
      fail(new Error('hosted_e2e_http2_probe_timeout'));
    }, attemptTimeoutMs);

    session.once('error', fail);
    try {
      request = session.request({
        ...input.headers,
        ':method': input.method,
        ':path': input.path,
        ':scheme': 'https',
        ':authority': input.authority ?? target.host,
        ...(input.body === undefined
          ? {}
          : { 'content-length': String(Buffer.byteLength(input.body)) }),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.once('response', (headers) => {
      responseHeaders = headers;
      const contentLength = headers['content-length'];
      if (contentLength !== undefined) {
        if (typeof contentLength !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
          fail(new Error('hosted_e2e_probe_content_length_invalid'));
          return;
        }
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > E2E_PROBE_RESPONSE_MAX_BYTES) {
          fail(new Error('hosted_e2e_probe_body_too_large'));
          return;
        }
      }
    });
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > E2E_PROBE_RESPONSE_MAX_BYTES) {
        fail(new Error('hosted_e2e_probe_body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', fail);
    request.once('end', () => {
      if (settled) return;
      if (responseHeaders === undefined) {
        fail(new Error('hosted_e2e_foreign_authority_response_headers_missing'));
        return;
      }
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        fail(new Error('hosted_e2e_probe_body_utf8_invalid'));
        return;
      }
      settled = true;
      cleanup();
      session.close();
      resolveProbe({
        body,
        headers: responseHeaders,
      });
    });
    request.end(input.body);
  });
}

function probeForeignAuthority(
  origin: string,
  cookieHeader: string,
  authority: string,
  deadlineBudget?: HostedV1ProbeDeadlineBudget
): Promise<Http2ProbeResponse> {
  return probeBoundedHttp2({
    authority,
    deadlineBudget,
    headers: { cookie: cookieHeader },
    method: 'GET',
    origin,
    path: '/api/auth/status',
  });
}

async function expectOriginalOidcSessionRevoked(
  testInfo: TestInfo,
  evidenceName: string,
  preLogoutCookieHeader: string
): Promise<void> {
  const response = await probeBoundedHttp2({
    headers: { cookie: preLogoutCookieHeader },
    method: 'GET',
    origin: runtime.origin,
    path: '/api/auth/status',
  });
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    throw new Error('hosted_e2e_oidc_revocation_body_invalid');
  }
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    throw new Error('hosted_e2e_oidc_revocation_body_invalid');
  }
  const body = parsedBody as Record<string, unknown>;
  const evidence = {
    schemaVersion: 1,
    request: { credentialSource: 'pre_logout_session_cookie' },
    response: {
      status: response.headers[':status'] ?? null,
      mode: typeof body.mode === 'string' ? body.mode : null,
      authenticated: typeof body.authenticated === 'boolean' ? body.authenticated : null,
      principalIsNull: body.principal === null,
      csrfTokenIsNull: body.csrfToken === null,
      setCookiePresent: response.headers['set-cookie'] !== undefined,
    },
  };
  await testInfo.attach(`${evidenceName}.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  expect(evidence.response, `${evidenceName} anonymous OIDC evidence`).toEqual({
    status: 200,
    mode: 'oidc',
    authenticated: false,
    principalIsNull: true,
    csrfTokenIsNull: true,
    setCookiePresent: false,
  });
}

test('production HTTPS personal flow remains sandboxed and truthful', async ({
  context,
  page,
}, rawTestInfo) => {
  const testInfo = bestEffortDiagnosticTestInfo(rawTestInfo);
  test.setTimeout(12 * 60_000);
  test.skip(runtime.authMode !== 'personal', 'personal-mode scenario only');
  if (runtime.pairingCode === null) throw new Error('hosted_e2e_pairing_code_missing');
  const documentResponse = await page.goto(runtime.origin, {
    waitUntil: 'domcontentloaded',
  });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(documentResponse?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();

  await page.getByLabel('Pairing code').fill(runtime.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  await selectRegisteredWorkspace(page);
  const teamButton = await exactRuntimeTeamButton(page);
  await expect(teamButton).toBeVisible();

  const cookies = await context.cookies(runtime.origin);
  for (const name of ['__Host-agent-teams-session', '__Host-agent-teams-device']) {
    const cookie = cookies.find((candidate) => candidate.name === name);
    expect(cookie, `${name} cookie`).toBeDefined();
    expect(cookie).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
  }
  expect(page.url()).not.toContain(runtime.pairingCode);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    runtime.pairingCode
  );

  const projects = await page.evaluate(async () => {
    return window.__hostedE2eProbe('/api/projects', {
      credentials: 'include',
      cache: 'no-store',
    });
  });
  expect(projects.status).toBe(200);
  expect(projects.rawBody).not.toContain('/workspaces/sandbox');
  expect(projects.rawBody).not.toContain(runtime.runtimeWorkspaceId);
  const projectValues = projects.body as {
    id: string;
    name: string;
  }[];
  await writeFile(
    runtime.controllerProjectObservationFile,
    `${JSON.stringify({
      status: 'observed',
      projectCount: projectValues.length,
      exactExpectedPublicProject:
        projectValues.length === 1 &&
        projectValues[0]?.id === runtime.projectWorkspaceId &&
        projectValues[0]?.name === 'sandbox',
      rawRuntimeIdentityAbsent: !projects.rawBody.includes(runtime.runtimeWorkspaceId),
      rawRuntimePathAbsent: !projects.rawBody.includes('/workspaces/sandbox'),
    })}\n`,
    { mode: 0o600 }
  );
  expect(projectValues).toHaveLength(1);
  expect(projectValues[0].id).toBe(runtime.projectWorkspaceId);
  expect(projectValues[0].name).toBe('sandbox');

  const csrfToken = await page.evaluate(async () => {
    const response = await window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    const body = response.body as { csrfToken: string | null };
    return body.csrfToken;
  });
  expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  if (csrfToken === null) throw new Error('hosted_e2e_csrf_token_missing');
  const badOrigin = await probeBoundedHttp2({
    body: JSON.stringify({ global: false }),
    headers: {
      'content-type': 'application/json',
      cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      origin: 'https://attacker.invalid',
      'sec-fetch-site': 'cross-site',
      'x-agent-teams-csrf': csrfToken,
    },
    method: 'POST',
    origin: runtime.origin,
    path: '/api/auth/logout',
  });
  expect(badOrigin.headers[':status']).toBe(403);
  const spoofedForwarding = await page.evaluate(() =>
    window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      headers: {
        forwarded: 'for=203.0.113.7;host=attacker.invalid;proto=http',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'http',
      },
    })
  );
  expect(spoofedForwarding.status).toBe(200);
  expect(spoofedForwarding.body).toMatchObject({ authenticated: true });
  const authenticatedCookies = await context.cookies(runtime.origin);
  const foreignAuthority = await probeForeignAuthority(
    runtime.origin,
    authenticatedCookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    'attacker.invalid'
  );
  expect(foreignAuthority.headers[':status']).toBe(421);
  expect(foreignAuthority.headers['set-cookie']).toBeUndefined();
  expect(foreignAuthority.body).not.toMatch(/"authenticated"\s*:\s*true/u);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await expect(teamButton).toBeVisible();
  const initialTaskBoardResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/page'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  await teamButton.click();
  const initialTaskBoardResponse = await initialTaskBoardResponsePromise;
  const initialTaskBoardPath = new URL(initialTaskBoardResponse.url).pathname;
  await testInfo.attach('initial-task-board-page-response.json', {
    body: JSON.stringify(
      {
        method: initialTaskBoardResponse.method,
        path: initialTaskBoardPath,
        status: initialTaskBoardResponse.status,
        declaredBodyBytes: initialTaskBoardResponse.declaredBodyBytes,
        bodyBytes: initialTaskBoardResponse.bodyBytes,
        rawBody: initialTaskBoardResponse.rawBody,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  expect(initialTaskBoardResponse.status, 'initial task-board page status').toBe(200);
  expect(
    initialTaskBoardResponse.bodyBytes,
    'initial bounded task-board response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  expect(initialTaskBoardResponse.method, 'initial task-board request method').toBe('POST');
  expect(initialTaskBoardPath, 'initial task-board request path').toBe(
    '/api/hosted/v1/team-task-board/page'
  );
  const initialTaskBoard = JSON.parse(initialTaskBoardResponse.rawBody) as {
    budget?: { elapsedMs?: number; timeLimitMs?: number };
    items?: { description?: string; subject?: string }[];
  };
  expect(initialTaskBoard.budget?.timeLimitMs, 'initial task-board page time budget').toBe(5_000);
  expect(initialTaskBoard.budget?.elapsedMs, 'initial task-board elapsed time').toBeLessThan(5_000);
  expect(initialTaskBoard.items, 'initial task-board marker item').toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: 'Marker-owned browser E2E task',
        description: 'Sandbox task-board projection fixture',
      }),
    ])
  );
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('Marker-owned browser E2E task')).toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({
        has: page.getByRole('heading', {
          name: 'Marker-owned browser E2E task',
          exact: true,
        }),
      })
      .locator('p', { hasText: /^Sandbox task-board projection fixture$/u })
  ).toBeVisible();

  const crossWorkspaceDraft = await page.evaluate(
    async ({ forbiddenWorkspaceId, token }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-configuration/draft/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          workspaceId: forbiddenWorkspaceId,
          idempotencyKey: 'idempotency_hosted-v1-e2e-cross-workspace',
          name: 'forbidden-cross-workspace-team',
          members: [{ name: 'lead' }],
        }),
      });
    },
    { forbiddenWorkspaceId: runtime.forbiddenWorkspaceId, token: csrfToken }
  );
  expect(runtime.forbiddenWorkspaceId).not.toBe(runtime.workspaceId);
  expect(crossWorkspaceDraft).toMatchObject({
    status: 403,
    body: {
      schemaVersion: 1,
      kind: 'error',
      error: { code: 'forbidden', reason: 'team_configuration_forbidden' },
      retryable: false,
    },
  });

  const configuredDraft = await page.evaluate(
    async (input) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-configuration/draft/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': input.csrfToken,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          idempotencyKey: 'idempotency_hosted-v1-e2e-draft',
          name: 'browser-created-team',
          members: [{ name: 'lead' }],
        }),
      });
    },
    { ...runtime, csrfToken }
  );
  expect(
    configuredDraft.status,
    `POST /api/hosted/v1/team-configuration/draft/create: ${configuredDraft.rawBody}`
  ).toBe(201);
  expect(configuredDraft.body).toMatchObject({
    schemaVersion: 1,
    kind: 'created',
    identity: { workspaceId: runtime.workspaceId },
    revision: expect.stringMatching(/^revision_/),
    outcome: 'created',
  });
  const createdIdentity = (
    configuredDraft.body as {
      identity: { workspaceId: string; teamId: string };
      revision: string;
    }
  ).identity;
  const createdRevision = (configuredDraft.body as { revision: string }).revision;
  expect(createdIdentity.teamId).toMatch(/^team_[0-9a-f]{32}$/u);
  expect(createdIdentity.teamId).not.toBe(runtime.teamId);

  const readModels = await page.evaluate(
    async ({ csrfToken: token, identity }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const probe = (input: string, init: RequestInit) =>
        window.__hostedE2eProbe(input, init, { overallDeadlineAtMs });
      const [teams, saved, lifecycle] = await Promise.all([
        probe('/api/teams', { credentials: 'include', cache: 'no-store' }),
        probe('/api/hosted/v1/team-configuration/saved-request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, ...identity }),
        }),
        probe('/api/teams/lifecycle/read', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify({
            schemaVersion: 1,
            cursor: null,
            expectedRevision: null,
          }),
        }),
      ]);
      return { teams, saved, lifecycle };
    },
    { csrfToken, identity: createdIdentity }
  );
  expect(readModels.teams.status).toBe(404);
  expect(readModels.teams.body).toEqual({ error: 'not_found' });
  expect(readModels.saved).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'found',
      draft: {
        ...createdIdentity,
        revision: createdRevision,
        metadata: { name: 'browser-created-team' },
        members: [{ name: 'lead' }],
      },
    },
  });
  expect(readModels.lifecycle.status).toBe(200);
  expect(readModels.lifecycle.body).toMatchObject({
    schemaVersion: 1,
    kind: 'success',
  });
  const lifecycleItems = (
    readModels.lifecycle.body as {
      items: { revision: string; teamId: string; workspaceId: string; lifecycle: string }[];
    }
  ).items;
  expect(lifecycleItems).toContainEqual(
    expect.objectContaining({
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
    })
  );
  const draftRows = lifecycleItems.filter(
    (item) =>
      item.teamId === createdIdentity.teamId && item.workspaceId === createdIdentity.workspaceId
  );
  expect(draftRows).toHaveLength(1);
  expect(draftRows[0]).toMatchObject({
    ...createdIdentity,
    lifecycle: 'draft',
    revision: expect.stringMatching(/^revision_/u),
  });
  const activeTeam = lifecycleItems.find((item) => item.teamId === runtime.teamId);
  expect(activeTeam?.revision).toMatch(/^revision_/u);
  if (activeTeam === undefined) throw new Error('hosted_e2e_active_team_missing');

  // Published draft attribution is valid, but is not an Owner execution grant.
  // Observe the existing fixture's durable effect state, not absence of a log file.
  const draftRuntimeBefore = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  expect(JSON.parse(draftRuntimeBefore)).toMatchObject({
    schemaVersion: 1,
    commands: [],
    activeRuns: [],
    eventIds: [],
    lifecycleCommandLedger: [],
    lifecycleReleaseLedger: [],
  });
  const seedTeamDirectory = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'teams',
    runtime.teamName
  );
  const seedTeamBefore = await snapshotDirectoryFiles(seedTeamDirectory);
  const teamsDirectory = resolve(seedTeamDirectory, '..');
  const teamDirectoriesBefore = (await readdir(teamsDirectory)).sort();
  const publishedDraftDirectories = [];
  for (const name of teamDirectoriesBefore) {
    const identity = JSON.parse(
      await readFile(resolve(teamsDirectory, name, 'team.identity.json'), 'utf8')
    ) as { teamId: string };
    if (identity.teamId === createdIdentity.teamId) publishedDraftDirectories.push(name);
  }
  expect(publishedDraftDirectories).toHaveLength(1);
  const publishedDraftDirectory = resolve(teamsDirectory, publishedDraftDirectories[0]);
  const publishedDraftBefore = await snapshotDirectoryFiles(publishedDraftDirectory);
  expect(JSON.parse(publishedDraftBefore['config.json'])).toEqual({
    name: publishedDraftDirectories[0],
    pendingCreate: true,
  });
  const draftTraceBefore = JSON.parse(
    await readFile(`${runtime.fakeRuntimeLifecycleTraceFile}.denials.json`, 'utf8')
  ) as { teamId: string }[];
  const draftExecutionDenials = await page.evaluate(
    async ({ token, identity, revision }) => {
      const results = [];
      for (const action of ['control-state', 'prepare', 'launch']) {
        results.push(
          await window.__hostedE2eProbe(`/api/hosted/v1/team-lifecycle/${action}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'x-agent-teams-csrf': token,
            },
            body: JSON.stringify({
              schemaVersion: 1,
              ...identity,
              // Projection requests accept identity only; launch uses the lifecycle revision,
              // which is independent of the saved configuration revision and display name.
              ...(action === 'launch'
                ? {
                    expectedRevision: revision,
                    commandId: 'lifecycle-command_hosted-v1-draft-denied',
                    idempotencyKey: 'idempotency_hosted-v1-draft-denied',
                  }
                : {}),
            }),
          })
        );
      }
      return results;
    },
    { token: csrfToken, identity: createdIdentity, revision: draftRows[0].revision }
  );
  // seedContainer rejects the non-seeded TeamId with a signed unavailable response;
  // the command HTTP adapter maps this to this exact 503 without losing the Owner.
  for (const denial of draftExecutionDenials) {
    expect(denial.status, denial.rawBody).toBe(503);
    expect(denial.body).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null });
  }
  const draftTraceAfter = JSON.parse(
    await readFile(`${runtime.fakeRuntimeLifecycleTraceFile}.denials.json`, 'utf8')
  ) as { exchangeId: string; teamId: string; operation: string }[];
  expect(draftTraceAfter.slice(0, draftTraceBefore.length)).toEqual(draftTraceBefore);
  // Count only this freshly created identity, across all operations. The mounted
  // seeded-team health poll cannot add records here or race a truncate/read.
  expect(draftTraceBefore.filter((entry) => entry.teamId === createdIdentity.teamId)).toEqual([]);
  const draftTraceDelta = draftTraceAfter.filter(
    (entry) => entry.teamId === createdIdentity.teamId
  );
  expect(draftTraceDelta).toHaveLength(6);
  expect(new Set(draftTraceDelta.map((entry) => entry.exchangeId)).size).toBe(3);
  for (const [index, operation] of [
    'control_state',
    'prepare_provisioning',
    'authorize',
  ].entries()) {
    const exchangeId = draftTraceDelta[index * 2].exchangeId;
    expect(exchangeId).toMatch(/^lifecycle-request_[0-9a-f]{32}$/);
    expect(draftTraceDelta[index * 2]).toEqual({
      exchangeId,
      operation,
      teamId: createdIdentity.teamId,
      stage: 'signed_request',
    });
    expect(draftTraceDelta[index * 2 + 1]).toEqual({
      exchangeId,
      operation,
      ...createdIdentity,
      workspaceId: createdIdentity.workspaceId,
      request: {
        schemaVersion: 1,
        ...createdIdentity,
        workspaceId: createdIdentity.workspaceId,
        ...(operation === 'authorize'
          ? {
              action: 'launch',
              expectedRevision: draftRows[0].revision,
              commandId: 'lifecycle-command_hosted-v1-draft-denied',
              idempotencyKey: 'idempotency_hosted-v1-draft-denied',
            }
          : {}),
      },
      signedProofValid: true,
      nonTeamAuthorityValid: true,
      stage: 'rejected',
      reason: 'nonseeded_team',
    });
  }
  const draftRuntimeAfter = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  expect(draftRuntimeAfter).toBe(draftRuntimeBefore);
  expect(await snapshotDirectoryFiles(seedTeamDirectory)).toEqual(seedTeamBefore);
  expect((await readdir(teamsDirectory)).sort()).toEqual(teamDirectoriesBefore);
  expect(await snapshotDirectoryFiles(publishedDraftDirectory)).toEqual(publishedDraftBefore);
  await testInfo.attach('personal-draft-execution-denial.json', {
    body: JSON.stringify(
      {
        identity: createdIdentity,
        lifecycleRevision: draftRows[0].revision,
        responses: draftExecutionDenials,
        ownerTrace: draftTraceDelta,
        runtimeBefore: draftRuntimeBefore,
        runtimeAfter: draftRuntimeAfter,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });

  const draftCrud = await page.evaluate(
    async ({ csrfToken: token, identity, revision }) => {
      const mutate = async (path: string, body: unknown) => {
        return window.__hostedE2eProbe(path, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify(body),
        });
      };
      const updated = await mutate('/api/hosted/v1/team-configuration/draft/update', {
        schemaVersion: 1,
        ...identity,
        expectedRevision: revision,
        updates: { description: 'Browser E2E draft CRUD proof' },
      });
      const updatedRevision = (updated.body as { draft?: { revision?: string } }).draft?.revision;
      const deleted = await mutate('/api/hosted/v1/team-configuration/draft/delete', {
        schemaVersion: 1,
        ...identity,
        expectedRevision: updatedRevision,
      });
      const savedAfterDelete = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-configuration/saved-request',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, ...identity }),
        }
      );
      return {
        updated,
        deleted,
        savedAfterDelete,
      };
    },
    { csrfToken, identity: createdIdentity, revision: createdRevision }
  );
  expect(draftCrud.updated).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'updated',
      draft: {
        ...createdIdentity,
        metadata: {
          name: 'browser-created-team',
          description: 'Browser E2E draft CRUD proof',
        },
      },
    },
  });
  expect(draftCrud.deleted).toMatchObject({
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'deleted',
      identity: createdIdentity,
      outcome: 'deleted',
    },
  });
  expect(draftCrud.savedAfterDelete).toMatchObject({
    status: 503,
    body: {
      schemaVersion: 1,
      kind: 'error',
      error: { code: 'unavailable', reason: 'team_configuration_unavailable' },
      retryable: true,
    },
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await expect(teamButton).toBeVisible();
  await teamButton.click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByText('No messages yet.')).toBeVisible();
  await page.getByLabel('New task title').fill('Browser-created sandbox task');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-create-task', () =>
    page.getByRole('button', { name: 'Save task' }).click()
  );
  await expect(page.getByText('Browser-created sandbox task')).toBeVisible();
  let browserTask = page.getByRole('listitem').filter({ hasText: 'Browser-created sandbox task' });
  await browserTask
    .getByLabel('Title for Browser-created sandbox task')
    .fill('Updated sandbox task');
  await browserTask
    .getByLabel('Description for Browser-created sandbox task')
    .fill('Owner-bound task mutation E2E details');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-save-details', () =>
    browserTask.getByRole('button', { name: 'Save details' }).click()
  );
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  browserTask = page.getByRole('listitem').filter({ hasText: 'Updated sandbox task' });
  await browserTask.getByLabel('Owner for Updated sandbox task').fill(`member_${'f'.repeat(32)}`);
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-set-owner', () =>
    browserTask.getByRole('button', { name: 'Save owner' }).click()
  );
  await expect(browserTask.getByLabel('Owner for Updated sandbox task')).toHaveValue(
    `member_${'f'.repeat(32)}`
  );
  await browserTask.getByLabel('Owner for Updated sandbox task').fill('');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-clear-owner', () =>
    browserTask.getByRole('button', { name: 'Save owner' }).click()
  );
  await expect(browserTask.getByLabel('Owner for Updated sandbox task')).toHaveValue('');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-next-status', () =>
    browserTask.getByRole('button', { name: 'Next status' }).click()
  );
  await expect(browserTask.getByText('in progress')).toBeVisible();
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-move-up', () =>
    browserTask.getByRole('button', { name: 'Move Updated sandbox task up', exact: true }).click()
  );
  const todoRegion = page.getByRole('region', { name: 'To do', exact: true });
  await expect(todoRegion).toBeVisible();
  await expect
    .poll(async () => todoRegion.getByRole('listitem').first().textContent())
    .toMatch(/^Updated sandbox task/u);
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'personal-move-right', () =>
    browserTask
      .getByRole('button', { name: 'Move Updated sandbox task right', exact: true })
      .click()
  );
  await expect(
    page.getByRole('region', { name: 'In progress' }).getByText('Updated sandbox task')
  ).toBeVisible();
  const replayProbe = await page.evaluate(
    async ({ token, teamId }) => {
      const headers = {
        'content-type': 'application/json',
        'x-agent-teams-csrf': token,
      };
      const pageResponse = await window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
      const board = pageResponse.body as {
        sourceGeneration: string;
        revision: string;
        items: { taskId: string; subject: string }[];
      };
      const task = board.items.find((item) => item.subject === 'Updated sandbox task');
      if (!task) throw new Error('hosted_e2e_mutated_task_missing');
      const command = {
        schemaVersion: 1,
        kind: 'update_status',
        commandId: 'command_hosted-v1-task-replay',
        idempotencyKey: 'idempotency_hosted-v1-task-replay',
        teamId,
        expectedSourceGeneration: board.sourceGeneration,
        expectedRevision: board.revision,
        taskId: task.taskId,
        status: 'completed',
      };
      const mutate = async (body: object) => {
        return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/mutations', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(body),
        });
      };
      return {
        command,
        committed: await mutate(command),
        replayed: await mutate(command),
        mismatch: await mutate({ ...command, status: 'pending' }),
      };
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  expect(replayProbe.committed).toMatchObject({
    status: 200,
    body: { outcome: 'committed' },
  });
  expect(replayProbe.replayed).toMatchObject({
    status: 200,
    body: { outcome: 'idempotent_replay' },
  });
  expect(replayProbe.mismatch).toMatchObject({
    status: 409,
    body: { error: { reason: 'idempotency_mismatch' } },
  });
  await restartHostedV1LifecycleOwner({ compose });
  const requestPostRestartReplay = (timeoutMs: number, overallDeadlineAtMs: number) =>
    page.evaluate(
      async ({ token, command, requestTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/mutations',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify(command),
              },
              { attemptTimeoutMs: requestTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        token: csrfToken,
        command: replayProbe.command,
        requestTimeoutMs: timeoutMs,
        overallDeadlineAtMs,
      }
    );
  const postRestartReplayDeadline = Date.now() + 20_000;
  let postRestartReplay = await requestPostRestartReplay(2_000, postRestartReplayDeadline);
  while (
    (postRestartReplay.status !== 200 ||
      (postRestartReplay.body as { outcome?: string } | null)?.outcome !== 'idempotent_replay') &&
    Date.now() < postRestartReplayDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, postRestartReplayDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= postRestartReplayDeadline) break;
    postRestartReplay = await requestPostRestartReplay(
      Math.max(1, Math.min(2_000, postRestartReplayDeadline - Date.now())),
      postRestartReplayDeadline
    );
  }
  await testInfo.attach('post-restart-replay-readiness-last-response.json', {
    body: JSON.stringify(postRestartReplay, null, 2),
    contentType: 'application/json',
  });
  expect(postRestartReplay, 'last post-restart replay readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: { outcome: 'idempotent_replay' },
  });
  const interruptedCommand = await page.evaluate(
    async ({ token, teamId }) => {
      const response = await window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
      const board = response.body as { sourceGeneration: string; revision: string };
      return {
        schemaVersion: 1,
        kind: 'create_task',
        commandId: 'command_hosted-v1-task-interrupted-wal',
        idempotencyKey: 'idempotency_hosted-v1-task-interrupted-wal',
        teamId,
        expectedSourceGeneration: board.sourceGeneration,
        expectedRevision: board.revision,
        subject: 'Recovered interrupted WAL task',
        description: 'Forward-recovered after the first of two target renames',
        status: 'pending',
        ownerId: `member_${'f'.repeat(32)}`,
        column: 'todo',
        order: 0,
      };
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  const fakeRuntimeDirectory = resolve(runtime.fakeRuntimeStateFile, '..');
  const taskWalPath = resolve(fakeRuntimeDirectory, 'task-mutation.wal.json');
  const taskCrashPath = resolve(fakeRuntimeDirectory, 'task-mutation.crash.json');
  await writeFile(
    taskCrashPath,
    `${JSON.stringify({
      schemaVersion: 1,
      commandId: interruptedCommand.commandId,
      afterRenames: 1,
    })}\n`,
    { mode: 0o600 }
  );
  await chown(taskCrashPath, 1000, 1000);
  const interruptedAttempt = await page.evaluate(
    async ({ token, command }) => {
      try {
        const response = await fetch('/api/hosted/v1/team-task-board/mutations', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': token,
          },
          body: JSON.stringify(command),
        });
        return { networkError: false, status: response.status };
      } catch {
        return { networkError: true, status: null };
      }
    },
    { token: csrfToken, command: interruptedCommand }
  );
  expect(
    interruptedAttempt.networkError ||
      interruptedAttempt.status === 502 ||
      interruptedAttempt.status === 503
  ).toBe(true);
  await expect
    .poll(() => compose('ps', '--status', 'exited', '--quiet', 'fake-runtime'))
    .not.toBe('');
  const interruptedWal = JSON.parse(await readFile(taskWalPath, 'utf8')) as {
    schemaVersion: number;
    commandId: string;
    writes: [string, string][];
  };
  expect(interruptedWal).toMatchObject({
    schemaVersion: 3,
    commandId: interruptedCommand.commandId,
  });
  expect(interruptedWal.writes).toHaveLength(2);
  const interruptedState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    taskLedger?: { key: string }[];
  };
  expect(
    (interruptedState.taskLedger ?? []).some((entry) =>
      entry.key.endsWith(`\u0000${interruptedCommand.idempotencyKey}`)
    )
  ).toBe(false);
  const recoveredWalOwnerOperations: Array<'task_board_read' | 'task_board_mutation'> = [];
  const observeRecoveredWalOwnerOperation = (request: Request): void => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/hosted/v1/team-task-board/page') {
      recoveredWalOwnerOperations.push('task_board_read');
    } else if (path === '/api/hosted/v1/team-task-board/mutations') {
      recoveredWalOwnerOperations.push('task_board_mutation');
    }
  };
  page.on('request', observeRecoveredWalOwnerOperation);
  await restartHostedV1LifecycleOwner({ compose });
  // The first owner operation after restart is deliberately a read. It proves startup recovery
  // made the interrupted postimage visible and removed the WAL before any mutation replay can
  // influence either observation.
  const requestRecoveredBoard = (timeoutMs: number, overallDeadlineAtMs: number) =>
    page.evaluate(
      async ({ token, teamId, timeoutMs: attemptTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false as const,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/page',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify({
                  schemaVersion: 1,
                  teamId,
                  cursor: null,
                  expectedSourceGeneration: null,
                  limit: 100,
                }),
              },
              { attemptTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true as const,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, teamId: runtime.teamId, timeoutMs, overallDeadlineAtMs }
    );
  const recoveredBoardDeadline = Date.now() + 20_000;
  let recoveredBoardProbe: Awaited<ReturnType<typeof requestRecoveredBoard>> | null = null;
  while (Date.now() < recoveredBoardDeadline) {
    recoveredBoardProbe = await requestRecoveredBoard(
      Math.max(1, Math.min(2_000, recoveredBoardDeadline - Date.now())),
      recoveredBoardDeadline
    );
    if (!recoveredBoardProbe.networkError && recoveredBoardProbe.status === 200) break;
    const retryDelayMs = Math.min(250, Math.max(0, recoveredBoardDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, retryDelayMs));
  }
  await testInfo.attach('recovered-wal-cold-first-board-response.json', {
    body: JSON.stringify(recoveredBoardProbe, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredBoardProbe, 'cold first recovered WAL board response').toMatchObject({
    networkError: false,
    status: 200,
  });
  const recoveredBoardBody = recoveredBoardProbe?.body as {
    revision?: unknown;
    items?: Array<{ subject?: unknown; ownerId?: unknown }>;
  } | null;
  expect(recoveredBoardBody).toMatchObject({
    revision: expect.stringMatching(/^revision_/u),
    items: expect.arrayContaining([
      expect.objectContaining({
        subject: 'Recovered interrupted WAL task',
        ownerId: `member_${'f'.repeat(32)}`,
      }),
    ]),
  });
  const recoveredRevision = recoveredBoardBody?.revision;
  expect(recoveredRevision).toEqual(expect.stringMatching(/^revision_/u));
  const recoveredWalAbsence = await readFile(taskWalPath, 'utf8').then(
    () => ({ code: null }),
    (error: NodeJS.ErrnoException) => ({ code: error.code ?? null })
  );
  expect(recoveredWalAbsence).toEqual({ code: 'ENOENT' });
  expect(recoveredWalOwnerOperations.length).toBeGreaterThan(0);
  expect(recoveredWalOwnerOperations.every((operation) => operation === 'task_board_read')).toBe(
    true
  );

  const requestRecoveredWalMutation = (
    command: typeof interruptedCommand,
    timeoutMs: number,
    overallDeadlineAtMs: number
  ) =>
    page.evaluate(
      async ({ token, command, requestTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-task-board/mutations',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify(command),
              },
              { attemptTimeoutMs: requestTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, command, requestTimeoutMs: timeoutMs, overallDeadlineAtMs }
    );
  const recoveryDeadline = Date.now() + 20_000;
  let recoveredReplay = await requestRecoveredWalMutation(
    interruptedCommand,
    2_000,
    recoveryDeadline
  );
  while (
    (recoveredReplay.status !== 200 ||
      (recoveredReplay.body as { outcome?: string } | null)?.outcome !== 'idempotent_replay') &&
    Date.now() < recoveryDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, recoveryDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= recoveryDeadline) break;
    recoveredReplay = await requestRecoveredWalMutation(
      interruptedCommand,
      Math.max(1, Math.min(2_000, recoveryDeadline - Date.now())),
      recoveryDeadline
    );
  }
  await testInfo.attach('recovered-wal-readiness-last-response.json', {
    body: JSON.stringify(recoveredReplay, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredReplay, 'last WAL recovery readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: { outcome: 'idempotent_replay', revision: recoveredRevision },
  });
  const recoveredMismatchDeadline = Date.now() + 5_000;
  const recoveredMismatch = await requestRecoveredWalMutation(
    { ...interruptedCommand, description: 'mismatched replay' },
    Math.max(1, recoveredMismatchDeadline - Date.now()),
    recoveredMismatchDeadline
  );
  await testInfo.attach('recovered-wal-mismatch-response.json', {
    body: JSON.stringify(recoveredMismatch, null, 2),
    contentType: 'application/json',
  });
  const recoveredWalProbe = { replay: recoveredReplay, mismatch: recoveredMismatch };
  expect(recoveredWalProbe).toMatchObject({
    replay: { status: 200, body: { outcome: 'idempotent_replay' } },
    mismatch: { status: 409, body: { error: { reason: 'idempotency_mismatch' } } },
  });
  page.off('request', observeRecoveredWalOwnerOperation);
  expect(recoveredWalOwnerOperations[0]).toBe('task_board_read');
  expect(recoveredWalOwnerOperations.indexOf('task_board_mutation')).toBeGreaterThan(0);
  await testInfo.attach('recovered-wal-cold-read-ordering-proof.json', {
    body: JSON.stringify({
      observedOwnerOperations: recoveredWalOwnerOperations,
      proofOrder: ['task_board_read', 'wal_absence', 'mutation_replay_and_mismatch'],
      coldBoardStatus: recoveredBoardProbe?.status,
      recoveredRevision,
      walReadErrorCode: recoveredWalAbsence.code,
      replayStatus: recoveredReplay.status,
      mismatchStatus: recoveredMismatch.status,
    }),
    contentType: 'application/json',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  const recoveredUiBoardDeadline = Date.now() + 25_000;
  const recoveredUiBoardAttempts: Array<{
    bodyBytes: number;
    rawBody: string;
    status: number;
  }> = [];
  const clickAndCaptureRecoveredUiBoard = async (click: () => Promise<void>) => {
    const remainingMs = Math.max(1, recoveredUiBoardDeadline - Date.now());
    const responsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-task-board/page',
        { timeout: remainingMs }
      )
      .then((response) => captureOriginalHttpResponse(response, recoveredUiBoardDeadline));
    void responsePromise.catch(() => undefined);
    await click();
    const { status, bodyBytes, rawBody } = await responsePromise;
    const attempt = { status, bodyBytes, rawBody };
    recoveredUiBoardAttempts.push(attempt);
    return attempt;
  };
  let recoveredUiBoardAttempt = await clickAndCaptureRecoveredUiBoard(() => teamButton.click());
  while (recoveredUiBoardAttempt.status === 503 && Date.now() < recoveredUiBoardDeadline) {
    const retryDelayMs = Math.min(250, Math.max(0, recoveredUiBoardDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= recoveredUiBoardDeadline) break;
    recoveredUiBoardAttempt = await clickAndCaptureRecoveredUiBoard(() =>
      page.getByRole('button', { name: 'Refresh task board', exact: true }).click()
    );
  }
  await testInfo.attach('recovered-wal-ui-board-readiness-responses.json', {
    body: JSON.stringify(recoveredUiBoardAttempts, null, 2),
    contentType: 'application/json',
  });
  expect(recoveredUiBoardAttempt.status, 'recovered WAL UI task-board status').toBe(200);
  expect(
    recoveredUiBoardAttempt.bodyBytes,
    'recovered bounded board response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  const personalMessageReadinessDeadline = Date.now() + 25_000;
  const personalMessageReadinessAttempts: Array<{
    advertisement: string | null;
    bodyBytes: number;
    rawBody: string;
    status: number;
  }> = [];
  let personalMessageReady = false;
  while (!personalMessageReady && Date.now() < personalMessageReadinessDeadline) {
    const remainingMs = Math.max(1, personalMessageReadinessDeadline - Date.now());
    if (remainingMs < 1_000) break;
    const responsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/hosted/v1/team-messages/page',
        { timeout: remainingMs }
      )
      .then(async (response) => ({
        advertisement: response.headers()['x-agent-teams-team-message-send-advertisement'] ?? null,
        captured: await captureOriginalHttpResponse(response, personalMessageReadinessDeadline),
      }));
    void responsePromise.catch(() => undefined);
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    const { advertisement, captured } = await responsePromise;
    personalMessageReadinessAttempts.push({
      advertisement,
      bodyBytes: captured.bodyBytes,
      rawBody: captured.rawBody,
      status: captured.status,
    });
    personalMessageReady = captured.status === 200 && advertisement === 'enabled';
    if (!personalMessageReady && Date.now() < personalMessageReadinessDeadline) {
      await page.waitForTimeout(
        Math.min(250, Math.max(1, personalMessageReadinessDeadline - Date.now()))
      );
    }
  }
  await testInfo.attach('personal-owner-message-readiness-responses.json', {
    body: JSON.stringify(personalMessageReadinessAttempts, null, 2),
    contentType: 'application/json',
  });
  expect(
    personalMessageReady,
    `message send capability became authoritative; last responses=${JSON.stringify(
      personalMessageReadinessAttempts.slice(-3)
    )}`
  ).toBe(true);
  await expect(page.getByLabel('New message')).toBeVisible();
  const personalMessage = 'sandbox capability prompt/message probe for the active team';
  const personalMessageResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-messages/send'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  void personalMessageResponsePromise.catch(() => undefined);
  await page.getByLabel('New message').fill(personalMessage);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const personalMessageResponse = await personalMessageResponsePromise;
  await testInfo.attach('personal-owner-message-send-original-response.json', {
    body: JSON.stringify(personalMessageResponse, null, 2),
    contentType: 'application/json',
  });
  expect(personalMessageResponse.capture).toBe('playwright_original_response');
  expect(personalMessageResponse.method).toBe('POST');
  expect(new URL(personalMessageResponse.url).pathname).toBe('/api/hosted/v1/team-messages/send');
  expect(personalMessageResponse.status).toBe(200);
  expect(personalMessageResponse.bodyBytes).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  const personalMessageBody = JSON.parse(personalMessageResponse.rawBody) as {
    kind: string;
    receipt: {
      schemaVersion: number;
      teamId: string;
      messageId: string;
      clientMessageId: string;
      persistence: string;
      runtimeDelivery: string;
    };
  };
  expect(personalMessageBody).toEqual({
    kind: 'persisted',
    receipt: {
      schemaVersion: 1,
      teamId: runtime.teamId,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
      clientMessageId: expect.stringMatching(/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
      persistence: 'durable',
      runtimeDelivery: 'delivered',
    },
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({
      hasText: personalMessage,
    })
  ).toBeVisible();
  const personalMessageReplayAndPage = await page.evaluate(
    async ({ token, teamId, text, clientMessageId }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const replay = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/send',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            clientMessageId,
            text,
          }),
        },
        { overallDeadlineAtMs }
      );
      const pageResponse = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/page',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: 50,
          }),
        },
        { overallDeadlineAtMs }
      );
      return { replay, page: pageResponse };
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      text: personalMessage,
      clientMessageId: personalMessageBody.receipt.clientMessageId,
    }
  );
  expect(personalMessageReplayAndPage.replay.status).toBe(200);
  expect(personalMessageReplayAndPage.replay.body).toEqual({
    ...personalMessageBody,
    kind: 'idempotent_replay',
    receipt: {
      ...personalMessageBody.receipt,
      runtimeDelivery: 'operator_required',
    },
  });
  expect(JSON.parse(personalMessageReplayAndPage.replay.rawBody)).toEqual(
    personalMessageReplayAndPage.replay.body
  );
  expect(personalMessageReplayAndPage.page.status).toBe(200);
  expect(
    (
      personalMessageReplayAndPage.page.body as {
        messages: Array<{ messageId: string; text: string }>;
      }
    ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
  ).toEqual([
    expect.objectContaining({
      messageId: personalMessageBody.receipt.messageId,
      text: personalMessage,
    }),
  ]);
  const personalMessageState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    messageLedger: Array<{
      clientMessageId: string;
      delivered: boolean;
      messageId: string;
    }>;
  };
  expect(
    personalMessageState.messageLedger.filter(
      (entry) => entry.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      delivered: true,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
    }),
  ]);
  const personalInboxPath = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'teams',
    runtime.teamName,
    'inboxes',
    'team-lead.json'
  );
  const personalInboxRows = JSON.parse(await readFile(personalInboxPath, 'utf8')) as Array<{
    hostedOperation?: { clientMessageId?: string };
    hostedDelivery?: { acknowledgement?: string };
  }>;
  expect(
    personalInboxRows.filter(
      (row) => row.hostedOperation?.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      hostedDelivery: expect.objectContaining({ acknowledgement: 'durable' }),
    }),
  ]);
  const personalInboxAfterDeliveryBytes = await readFile(personalInboxPath, 'utf8');

  const eventRequestHeaders: Record<string, string>[] = [];
  const eventRequestUrls: string[] = [];
  const eventRequestHeaderDiagnostics = hostedV1DiagnosticFailures(testInfo);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/hosted/v1/events' && url.searchParams.get('e2e') === 'resume') {
      void trackHostedV1BestEffortDiagnostic(testInfo, {
        name: 'request_all_headers:personal-event-stream',
        operation: async (signal) => {
          if (signal.aborted) return;
          eventRequestUrls.push(request.url());
          if (signal.aborted) return;
          const headers = await request.allHeaders();
          // The finalization gate may close while Playwright is resolving
          // headers.  Do not let that late callback feed an attachment after
          // the final diagnostic snapshot is persisted.
          if (!signal.aborted) eventRequestHeaders.push(headers);
        },
      });
    }
  });
  const initialEventStreamResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname === '/api/hosted/v1/events' &&
      url.searchParams.get('e2e') === 'resume'
    );
  });
  void initialEventStreamResponsePromise.catch(() => undefined);
  await page.evaluate((cursor) => {
    const state: HostedV1ExternalCoordinationStreamState = {
      controller: null,
      activeStreamId: null,
      opens: 0,
      ids: [],
      events: [],
      frames: [],
      heartbeats: 0,
      heartbeatFrameIndexes: [],
      heartbeatStreamIds: [],
      heartbeatObservedAtMs: [],
      heartbeatCursors: [],
      heartbeatEventCounts: [],
      reconnects: 0,
      cursor,
      reconnectTimer: null,
      closed: false,
      error: null,
    };
    const consume = async () => {
      const controller = new AbortController();
      state.controller = controller;
      let streamId: number | null = null;
      const invalidateStream = () => {
        if (streamId !== null && state.activeStreamId === streamId) {
          state.activeStreamId = null;
        }
      };
      controller.signal.addEventListener('abort', invalidateStream, { once: true });
      try {
        const response = await fetch(
          `/api/hosted/v1/events?after=${encodeURIComponent(state.cursor)}&e2e=resume`,
          { credentials: 'include', headers: { accept: 'text/event-stream' }, signal: controller.signal }
        );
        if (!response.ok || !response.body) throw new Error('coordination_stream_unavailable');
        const responseStreamId = state.opens + 1;
        streamId = responseStreamId;
        state.opens = responseStreamId;
        // This assignment is deliberately after a successful fetch and body
        // check. A pending replacement must not make a closed predecessor
        // appear live merely because the retry cleared its error text.
        state.activeStreamId = responseStreamId;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!state.closed) {
          const result = await reader.read();
          if (result.done) throw new Error('coordination_stream_closed');
          buffer += decoder.decode(result.value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (frame === ': heartbeat') {
              state.heartbeats += 1;
              state.heartbeatStreamIds.push(responseStreamId);
              state.frames.push('heartbeat');
              state.heartbeatFrameIndexes.push(state.frames.length - 1);
              state.heartbeatObservedAtMs.push(Date.now());
              state.heartbeatCursors.push(state.cursor);
              state.heartbeatEventCounts.push(state.events.length);
              continue;
            }
            const fields = new Map(
              frame.split('\n').flatMap((line) => {
                const separator = line.indexOf(':');
                return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1).trimStart()] as const];
              })
            );
            if (fields.get('event') !== 'coordination_event') continue;
            const data = JSON.parse(fields.get('data') ?? '') as {
          eventType?: unknown;
          deploymentId?: unknown;
          eventId?: unknown;
          eventEpoch?: unknown;
          eventSequence?: unknown;
          eventCursor?: unknown;
          scope?: { kind?: unknown; scopeId?: unknown };
          payload?: unknown;
        };
            const eventCursor = fields.get('id') ?? '';
            if (!eventCursor) throw new Error('coordination_event_cursor_missing');
            state.frames.push('coordination_event');
            if (data.eventType === 'team-lifecycle.run-accepted') state.ids.push(eventCursor);
            state.events.push({
              id: eventCursor,
              deploymentId: typeof data.deploymentId === 'string' ? data.deploymentId : null,
              eventId: typeof data.eventId === 'string' ? data.eventId : null,
              eventEpoch: typeof data.eventEpoch === 'string' ? data.eventEpoch : null,
              eventSequence: typeof data.eventSequence === 'number' ? data.eventSequence : null,
              eventCursor: typeof data.eventCursor === 'string' ? data.eventCursor : null,
              scopeKind: typeof data.scope?.kind === 'string' ? data.scope.kind : null,
              scopeId: typeof data.scope?.scopeId === 'string' ? data.scope.scopeId : null,
              eventType: typeof data.eventType === 'string' ? data.eventType : null,
              payload: data.payload ?? null,
              frameIndex: state.frames.length - 1,
              streamId: responseStreamId,
              observedAtMs: Date.now(),
            });
            state.cursor = eventCursor;
          }
        }
      } catch (error) {
        // Close, read failure, and abort all synchronously retire precisely
        // the response generation that owned this reader.
        invalidateStream();
        if (state.closed) return;
        state.error = error instanceof Error ? error.message : String(error);
        state.reconnects += 1;
        state.reconnectTimer = window.setTimeout(() => {
          state.error = null;
          void consume();
        }, 250);
      }
    };
    void consume();
    window.__hostedE2eSse = state;
  }, runtime.eventCursor);
  const initialEventStreamResponse = await initialEventStreamResponsePromise;
  const initialEventStreamStatus = initialEventStreamResponse.status();
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'attach:initial-event-stream-response.json',
    operation: async (signal) => {
      if (signal.aborted) return;
      const requestHeaders = await initialEventStreamResponse.request().allHeaders();
      if (signal.aborted) return;
      const responseHeaders = await initialEventStreamResponse.allHeaders();
      if (signal.aborted) return;
      await testInfo.attach('initial-event-stream-response.json', {
      body: JSON.stringify({
        status: initialEventStreamStatus,
        requestHeaders,
        responseHeaders,
        failureBody: null,
      }, null, 2),
      contentType: 'application/json',
      });
    },
  });
  expect(initialEventStreamStatus, 'initial coordination event stream status').toBe(200);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__hostedE2eSse;
        return state ? { opens: state.opens, events: state.ids.length } : null;
      })
    )
    .toEqual({ opens: 1, events: 0 });

  // This reader is the asserted delivery stream. It exposes heartbeat frames
  // that EventSource deliberately hides, without a second replay query.
  await expect
    .poll(
      () => page.evaluate(() => {
        const state = window.__hostedE2eSse;
        return Boolean(state && state.opens === 1 && state.heartbeats >= 1 && state.reconnects === 0 && state.error === null);
      }),
      { timeout: externalCoordinationReplayBudget.replayBudgetMs }
    )
    .toBe(true);
  const lifecycleHandoffOriginMs = Date.now();
  const lifecycleDeadlines = externalCoordinationReplayBudget.deadlinesFrom(
    lifecycleHandoffOriginMs
  );
  const remainingLifecycleBudget = (deadlineMs: number, phase: string): number => {
    try {
      return externalCoordinationReplayBudget.requireRemainingAt(deadlineMs, Date.now());
    } catch (error) {
      if (error instanceof Error && error.message === 'hosted_e2e_external_replay_deadline_exhausted') {
        throw new Error(`hosted_e2e_external_coordination_${phase}_deadline_exhausted`, {
          cause: error,
        });
      }
      throw error;
    }
  };
  const lifecycleLaunchReceipt = await page.evaluate(
    async (input) => {
      const state = window.__hostedE2eSse;
      if (!state) throw new Error('coordination_stream_state_missing');
      const launchBoundaryFrameIndex = state.frames.length;
      const launchBoundaryEventIds = state.events.map((event) => event.eventId);
      const commitInitiatedAtMs = Date.now();
      const launch = await window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': input.csrfToken,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-e2e',
          idempotencyKey: 'idempotency_hosted-v1-e2e',
          workspaceId: input.identity.workspaceId,
          teamId: input.identity.teamId,
          expectedRevision: input.revision,
        }),
      });
      return { commitInitiatedAtMs, launch, launchBoundaryFrameIndex, launchBoundaryEventIds };
    },
    { csrfToken, identity: activeTeam, revision: activeTeam.revision }
  );
  const lifecycleLaunch = lifecycleLaunchReceipt.launch;
  const launchReceiptDiagnosticFailures = hostedV1DiagnosticFailures(testInfo);
  expect(lifecycleLaunch.status).toBe(202);
  expect(lifecycleLaunch.body).toMatchObject({
    schemaVersion: 1,
    kind: 'accepted',
    action: 'launch',
    teamId: runtime.teamId,
    workspaceId: runtime.workspaceId,
    resourceRevision: expect.stringMatching(/^revision_/u),
    runId: expect.stringMatching(/^run_/u),
  });
  const lifecycleLaunchBody = lifecycleLaunch.body as {
    commandId: string;
    resourceRevision: string;
    runId: string;
  };
  expect(lifecycleLaunchBody.resourceRevision).not.toBe(activeTeam.revision);
  let observedJournal: RunAcceptedJournalObservation | undefined;
  try {
    await expect
      .poll(
        async () => {
          const observation = await readRunAcceptedJournalObservation(
            lifecycleLaunchBody.runId,
            Math.min(
              1_000,
              remainingLifecycleBudget(lifecycleDeadlines.handoffDeadlineMs, 'handoff')
            )
          );
          if (observation.status === 'observed') observedJournal = observation;
          if (observation.status === 'unavailable') {
            recordHostedV1DiagnosticObservation(testInfo, {
              operation: 'journal_read',
              classification: 'failed_observation',
              error: observation.error ?? 'unknown_error',
              timing: Object.freeze({ observedAtMs: Date.now() }),
            });
          }
          return observation.status;
        },
        {
          timeout: remainingLifecycleBudget(
            lifecycleDeadlines.handoffDeadlineMs,
            'handoff'
          ),
        }
      )
      .toBe('observed');
    expect(observedJournal?.status).toBe('observed');
    const observedJournalRow = observedJournal?.row;
    expect(observedJournalRow?.eventId).toEqual(expect.any(String));
    await expect
      .poll(
        () =>
          page.evaluate((eventId) => {
            const state = window.__hostedE2eSse;
            return state?.opens === 1 && state.events.filter((event) => event.eventId === eventId).length === 1;
          }, observedJournalRow?.eventId),
        {
          timeout: remainingLifecycleBudget(lifecycleDeadlines.replayDeadlineMs, 'replay'),
        }
      )
      .toBe(true);
  } catch (error) {
    await attachExternalCoordinationEvidence(
      testInfo,
      'predicate-expiry',
      lifecycleLaunchBody.runId,
      page,
      eventRequestUrls,
      initialEventStreamStatus,
      {
        handoffOriginMs: lifecycleHandoffOriginMs,
        commitInitiatedAtMs: lifecycleLaunchReceipt.commitInitiatedAtMs,
        handoffDeadlineMs: lifecycleDeadlines.handoffDeadlineMs,
        replayDeadlineMs: lifecycleDeadlines.replayDeadlineMs,
        observedElapsedMs: Date.now() - lifecycleHandoffOriginMs,
      }
    );
    throw error;
  }
  const journalObservation = observedJournal;
  if (!journalObservation) throw new Error('hosted_e2e_journal_observation_missing');
  expect(journalObservation.status).toBe('observed');
  const journalRow = journalObservation.row;
  const journalMetadata = journalObservation.metadata;
  const journalEventEpoch = requireHostedV1JournalString(journalRow?.eventEpoch, 'event_epoch');
  expect(journalRow).toEqual(expect.objectContaining({
    eventType: 'team-lifecycle.run-accepted',
    runId: lifecycleLaunchBody.runId,
    payloadRunId: lifecycleLaunchBody.runId,
    teamId: runtime.teamId,
    scopeKind: 'team',
    scopeId: runtime.teamId,
    deploymentId: expect.any(String),
    eventEpoch: expect.any(String),
    eventId: expect.any(String),
    eventSequence: expect.any(Number),
  }));
  expect(journalMetadata).toEqual(expect.objectContaining({
    deploymentId: journalRow?.deploymentId,
    eventEpoch: journalEventEpoch,
    highWatermarkSequence: expect.any(Number),
  }));
  expect(journalMetadata?.highWatermarkSequence).toBeGreaterThanOrEqual(
    requireHostedV1JournalSequence(journalRow?.eventSequence)
  );
  const journalEventId = requireHostedV1JournalString(journalRow?.eventId, 'event_id');
  const journalDeploymentId = requireHostedV1JournalString(journalRow?.deploymentId, 'deployment_id');
  const journalEventSequence = requireHostedV1JournalSequence(journalRow?.eventSequence);
  const deliveredEvents = await page.evaluate(() => window.__hostedE2eSse);
  if (!deliveredEvents) throw new Error('hosted_e2e_external_coordination_stream_missing');
  const targetEvents = deliveredEvents.events.filter((event) => event.eventId === journalEventId);
  assertHostedV1ExternalCoordinationStreamProof({
    launchBoundaryEventIds: lifecycleLaunchReceipt.launchBoundaryEventIds,
    launchBoundaryFrameIndex: lifecycleLaunchReceipt.launchBoundaryFrameIndex,
    opens: deliveredEvents.opens,
    reconnects: deliveredEvents.reconnects,
    error: deliveredEvents.error,
    heartbeatStreamIds: deliveredEvents.heartbeatStreamIds,
    heartbeatFrameIndexes: deliveredEvents.heartbeatFrameIndexes,
    events: deliveredEvents.events,
    targetEventId: journalEventId,
  });
  expect(lifecycleLaunchReceipt.launchBoundaryEventIds).not.toContain(journalEventId);
  expect(targetEvents).toHaveLength(1);
  const targetEvent = targetEvents[0]!;
  expect(deliveredEvents.opens).toBe(1);
  expect(deliveredEvents.reconnects).toBe(0);
  expect(deliveredEvents.error).toBeNull();
  expect(deliveredEvents.heartbeatStreamIds).not.toHaveLength(0);
  expect(deliveredEvents.heartbeatStreamIds.every((streamId) => streamId === 1)).toBe(true);
  expect(deliveredEvents.heartbeatFrameIndexes.some((index) => index < targetEvent.frameIndex)).toBe(true);
  expect(deliveredEvents.events.every((event) => event.streamId === 1)).toBe(true);
  const eventSequences = deliveredEvents.events.map((event) => event.eventSequence).filter(
    (sequence): sequence is number => typeof sequence === 'number'
  );
  expect(eventSequences).toEqual([...eventSequences].sort((left, right) => left - right));
  expect(new Set(eventSequences).size).toBe(eventSequences.length);
  expect(targetEvent).toEqual(expect.objectContaining({
    id: expect.any(String),
    deploymentId: journalDeploymentId,
    eventId: journalEventId,
    eventSequence: journalEventSequence,
    eventCursor: expect.any(String),
    eventEpoch: journalRow?.eventEpoch,
    scopeKind: 'workspace',
    scopeId: runtime.workspaceId,
    payload: { kind: 'invalidate', resource: 'team_lifecycle' },
    streamId: 1,
  }));
  expect(targetEvent.id).toBe(targetEvent.eventCursor);
  const expectedJournalCursor = encodeReplayCursor({
    cursorVersion: 1,
    deploymentId: journalDeploymentId,
    eventEpoch: journalEventEpoch,
    eventSequence: journalEventSequence,
  });
  expect(targetEvent.eventCursor).toBe(expectedJournalCursor);
  // The handoff proof above is complete.  These are useful artifacts, but
  // they must not spend the ten-second commitment deadline or reject a timely
  // journal/stream proof.
  const launchRuntimeState = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'read:personal-lifecycle-launch-runtime-state.json',
    operation: (signal) => readFile(runtime.fakeRuntimeStateFile, { signal }),
  });
  const launchRuntimeTrace = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'read:personal-lifecycle-launch-runtime-trace.json',
    operation: (signal) => readFile(runtime.fakeRuntimeLifecycleTraceFile, { signal }),
  });
  await Promise.all([
    trackHostedV1BestEffortDiagnostic(testInfo, {
      name: 'attach:personal-lifecycle-launch-response.json',
      operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('personal-lifecycle-launch-response.json', {
        body: JSON.stringify(lifecycleLaunch, null, 2), contentType: 'application/json',
      }),
    }),
    trackHostedV1BestEffortDiagnostic(testInfo, {
      name: 'attach:personal-lifecycle-launch-runtime-state.json',
      operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('personal-lifecycle-launch-runtime-state.json', {
        body: launchRuntimeState ?? JSON.stringify({ schemaVersion: 1, kind: 'read_unavailable' }),
        contentType: 'application/json',
      }),
    }),
    trackHostedV1BestEffortDiagnostic(testInfo, {
      name: 'attach:personal-lifecycle-launch-runtime-trace.json',
      operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('personal-lifecycle-launch-runtime-trace.json', {
        body: launchRuntimeTrace ?? JSON.stringify({ schemaVersion: 1, kind: 'read_unavailable' }),
        contentType: 'application/json',
      }),
    }),
  ]);
  await attachExternalCoordinationEvidence(
    testInfo,
    'predicate-expiry',
    lifecycleLaunchBody.runId,
    page,
    eventRequestUrls,
    initialEventStreamStatus,
    {
      handoffOriginMs: lifecycleHandoffOriginMs,
      commitInitiatedAtMs: lifecycleLaunchReceipt.commitInitiatedAtMs,
      handoffDeadlineMs: lifecycleDeadlines.handoffDeadlineMs,
      replayDeadlineMs: lifecycleDeadlines.replayDeadlineMs,
      observedElapsedMs: Date.now() - lifecycleHandoffOriginMs,
    },
    launchReceiptDiagnosticFailures
  );
  const firstDeliveredCursor = await page.evaluate(() => {
    const state = window.__hostedE2eSse;
    return state?.ids[0] ?? null;
  });
  expect(firstDeliveredCursor).toMatch(/^cev1\./);
  expect(firstDeliveredCursor).not.toBe(runtime.eventCursor);

  const lifecycleCommand = (
    action: 'recover' | 'stop',
    sequence: number,
    expectedRevision: string
  ) => ({
    schemaVersion: 1 as const,
    commandId: `lifecycle-command_hosted-v1-e2e-${action}-${sequence}`,
    idempotencyKey: `idempotency_hosted-v1-e2e-${action}-${sequence}`,
    workspaceId: activeTeam.workspaceId,
    teamId: activeTeam.teamId,
    runId: lifecycleLaunchBody.runId,
    expectedRevision,
  });
  const requestLifecycle = (
    action: 'recover' | 'stop',
    command: ReturnType<typeof lifecycleCommand>
  ) =>
    page.evaluate(
      async (input) => {
        return window.__hostedE2eProbe(`/api/hosted/v1/team-lifecycle/${input.action}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-agent-teams-csrf': input.csrfToken,
          },
          body: JSON.stringify(input.command),
        });
      },
      {
        action,
        csrfToken,
        command,
      }
    );
  const firstStopCommand = lifecycleCommand('stop', 1, lifecycleLaunchBody.resourceRevision);
  const firstStop = await requestLifecycle('stop', firstStopCommand);
  expect(firstStop).toMatchObject({
    status: 202,
    body: {
      action: 'stop',
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const firstStopRevision = String(
    (firstStop.body as { resourceRevision: string }).resourceRevision
  );
  expect(firstStopRevision).not.toBe(lifecycleLaunchBody.resourceRevision);
  const recoveryCommand = lifecycleCommand('recover', 2, firstStopRevision);
  const recovery = await requestLifecycle('recover', recoveryCommand);
  expect(recovery).toMatchObject({
    status: 202,
    body: {
      action: 'recover',
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const recoveryRevision = String((recovery.body as { resourceRevision: string }).resourceRevision);
  expect(recoveryRevision).not.toBe(firstStopRevision);
  const finalStopCommand = lifecycleCommand('stop', 3, recoveryRevision);
  const interceptedFinalStopResponses: Array<{ status: number; body: unknown }> = [];
  const finalStopRoute = '**/api/hosted/v1/team-lifecycle/stop';
  let forwardingFinalStopProbe = false;
  await page.route(finalStopRoute, async (route) => {
    const body = route.request().postDataJSON() as { commandId?: unknown };
    if (body.commandId !== finalStopCommand.commandId || forwardingFinalStopProbe) {
      await route.fallback();
      return;
    }
    forwardingFinalStopProbe = true;
    try {
      const upstream = await page.evaluate(
        ({ token, command, overallDeadlineAtMs }) =>
          window.__hostedE2eProbe(
            '/api/hosted/v1/team-lifecycle/stop',
            {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/json',
                'x-agent-teams-csrf': token,
              },
              body: JSON.stringify(command),
            },
            { overallDeadlineAtMs }
          ),
        {
          token: csrfToken,
          command: finalStopCommand,
          overallDeadlineAtMs: Date.now() + E2E_PROBE_ATTEMPT_TIMEOUT_MS,
        }
      );
      interceptedFinalStopResponses.push({ status: upstream.status, body: upstream.body });
    } finally {
      forwardingFinalStopProbe = false;
      await route.abort('failed');
    }
  });
  let lostFinalStopAttempt: {
    networkError: boolean;
    status: number | null;
    body: unknown;
    error?: string;
  };
  try {
    lostFinalStopAttempt = await page.evaluate(
      async ({ token, command }) => {
        try {
          return {
            networkError: false,
            ...(await window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/stop', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/json',
                'x-agent-teams-csrf': token,
              },
              body: JSON.stringify(command),
            })),
          };
        } catch (error) {
          return {
            networkError: true,
            status: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { token: csrfToken, command: finalStopCommand }
    );
  } finally {
    await page.unroute(finalStopRoute);
  }
  expect(lostFinalStopAttempt).toMatchObject({ networkError: true, status: null });
  expect(interceptedFinalStopResponses).toHaveLength(1);
  const interceptedFinalStop = interceptedFinalStopResponses[0]!;
  expect(interceptedFinalStop).toMatchObject({
    status: 202,
    body: {
      action: 'stop',
      commandId: finalStopCommand.commandId,
      teamId: runtime.teamId,
      resourceRevision: expect.stringMatching(/^revision_/u),
    },
  });
  const finalStopRevision = String(
    (interceptedFinalStop.body as { resourceRevision: string }).resourceRevision
  );
  expect(finalStopRevision).not.toBe(recoveryRevision);
  await testInfo.attach('personal-lifecycle-response-loss.json', {
    body: JSON.stringify(
      {
        command: finalStopCommand,
        clientAttempt: lostFinalStopAttempt,
        upstream: interceptedFinalStop,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  const runtimeState = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: { teamId: string; runId: string }[];
    commands: { action: string; teamId: string; runId: string }[];
    eventIds: string[];
  };
  expect(runtimeState.commands.map((command) => command.action)).toEqual([
    'launch',
    'stop',
    'recover',
    'stop',
  ]);
  expect(runtimeState.commands.every((command) => command.teamId === runtime.teamId)).toBe(true);
  expect(
    runtimeState.commands.every((command) => command.runId === lifecycleLaunchBody.runId)
  ).toBe(true);
  expect(runtimeState.eventIds).toHaveLength(1);
  expect(runtimeState.activeRuns).toEqual([]);

  await restartHostedV1LifecycleOwner({ compose });
  const postRestartSessionCookies = (await context.cookies(runtime.origin)).filter(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  );
  expect(postRestartSessionCookies, 'current post-restart session cookie').toHaveLength(1);
  const postRestartSessionCookie = postRestartSessionCookies[0];
  if (postRestartSessionCookie === undefined) {
    throw new Error('hosted_e2e_post_restart_session_cookie_missing');
  }
  const postRestartSessionCookieHeader = `${postRestartSessionCookie.name}=${postRestartSessionCookie.value}`;
  const requestPostRestartLifecycle = (
    body: string,
    deadlineBudget: HostedV1ProbeDeadlineBudget
  ) => {
    return probeBoundedHttp2({
      body,
      deadlineBudget,
      headers: {
        'content-type': 'application/json',
        cookie: postRestartSessionCookieHeader,
        origin: runtime.origin,
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': csrfToken,
      },
      method: 'POST',
      origin: runtime.origin,
      path: '/api/hosted/v1/team-lifecycle/stop',
    }).then(
      (response) => {
        let body: unknown = response.body;
        try {
          body = JSON.parse(response.body);
        } catch {
          // Preserve the bounded raw response so the strict receipt assertion fails truthfully.
        }
        return {
          networkError: false as const,
          status: response.headers[':status'] ?? null,
          rawBody: response.body,
          body,
        };
      },
      (error) => ({
        networkError: true as const,
        status: null,
        rawBody: null,
        body: null,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  };
  const postLifecycleRecoveryBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 20_000,
    perAttemptTimeoutMs: 2_000,
  });
  const finalStopReplayBody = JSON.stringify(finalStopCommand);
  let postLifecycleReplay = await requestPostRestartLifecycle(
    finalStopReplayBody,
    postLifecycleRecoveryBudget
  );
  while (
    (postLifecycleReplay.status !== 200 ||
      (postLifecycleReplay.body as { kind?: string } | null)?.kind !== 'idempotent_replay') &&
    postLifecycleRecoveryBudget.remainingMs() > 0
  ) {
    let retryDelayMs: number;
    try {
      retryDelayMs = postLifecycleRecoveryBudget.clipRetryDelayMs(250);
    } catch {
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, retryDelayMs));
    if (postLifecycleRecoveryBudget.remainingMs() <= 0) break;
    postLifecycleReplay = await requestPostRestartLifecycle(
      finalStopReplayBody,
      postLifecycleRecoveryBudget
    );
  }
  await testInfo.attach('post-lifecycle-replay-readiness-last-response.json', {
    body: JSON.stringify(postLifecycleReplay, null, 2),
    contentType: 'application/json',
  });
  expect(postLifecycleReplay, 'last post-lifecycle replay readiness response').toMatchObject({
    networkError: false,
    status: 200,
    body: {
      schemaVersion: 1,
      kind: 'idempotent_replay',
      action: 'stop',
      commandId: finalStopCommand.commandId,
      workspaceId: runtime.workspaceId,
      teamId: runtime.teamId,
      runId: lifecycleLaunchBody.runId,
      resourceRevision: finalStopRevision,
    },
  });
  expect({ ...(postLifecycleReplay.body as object), kind: 'accepted' }).toEqual(
    interceptedFinalStop.body
  );
  const lifecycleMismatchCommand = {
    ...finalStopCommand,
    expectedRevision: finalStopRevision,
  };
  const lifecycleMismatchBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 5_000,
    perAttemptTimeoutMs: 5_000,
  });
  const postLifecycleMismatch = await requestPostRestartLifecycle(
    JSON.stringify(lifecycleMismatchCommand),
    lifecycleMismatchBudget
  );
  expect(postLifecycleMismatch).toMatchObject({
    networkError: false,
    status: 409,
    body: {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    },
  });
  const postRestartLifecycleState = JSON.parse(
    await readFile(runtime.fakeRuntimeStateFile, 'utf8')
  ) as { commands: { commandId: string }[] };
  expect(
    postRestartLifecycleState.commands.filter(
      (command) => command.commandId === finalStopCommand.commandId
    )
  ).toHaveLength(1);
  await testInfo.attach('post-restart-identical-lifecycle-replay.json', {
    body: JSON.stringify(
      {
        command: finalStopCommand,
        interceptedResponse: interceptedFinalStop,
        replayResponse: postLifecycleReplay,
        mismatchResponse: postLifecycleMismatch,
        matchingEffectCount: postRestartLifecycleState.commands.filter(
          (command) => command.commandId === finalStopCommand.commandId
        ).length,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });

  const expectInstanceLockRejection = async () => {
    await expect(
      compose(
        'exec',
        '-T',
        'hosted-controller',
        '/usr/local/bin/hosted-entrypoint',
        '/usr/local/bin/node',
        '/app/dist-standalone/index.cjs'
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('instance_lock:') });
  };
  await expectInstanceLockRejection();

  const controllerId = (await compose('ps', '--quiet', 'hosted-controller')).trim();
  expect(controllerId).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    (
      await docker(
        'inspect',
        '--format',
        '{{ index .Config.Labels "com.docker.compose.project" }}',
        controllerId
      )
    ).trim()
  ).toBe(composeProject);
  const controllerProcesses = await docker('top', controllerId, '-eo', 'pid,args');
  const controllerProcess = controllerProcesses
    .split('\n')
    .find((line) => /\bnode\b.*\bdist-standalone\/index\.cjs\b/u.test(line));
  expect(controllerProcess, controllerProcesses).toBeDefined();
  const controllerPid = Number(controllerProcess?.trim().split(/\s+/u)[0]);
  expect(Number.isSafeInteger(controllerPid) && controllerPid > 1).toBe(true);

  // A restart proof is relative to the reader that existed before shutdown.
  // Failed reconnection attempts may change reconnects, but they cannot make a
  // successful resumed stream look like the prior one.
  const reconnectBaseline = await page.evaluate(() => {
    const state = window.__hostedE2eSse;
    if (!state) throw new Error('coordination_stream_state_missing_before_restart');
    return {
      opens: state.opens,
      reconnects: state.reconnects,
      streamGeneration: state.opens,
      cursor: state.cursor,
    };
  });
  expect(reconnectBaseline.opens).toBeGreaterThanOrEqual(1);

  process.kill(controllerPid, 'SIGTERM');
  await expect
    .poll(async () => compose('ps', '--status', 'exited', '--quiet', 'hosted-controller'))
    .not.toBe('');
  const shutdownState = JSON.parse(
    await docker('inspect', '--format', '{{json .State}}', controllerId)
  ) as { Error: string; ExitCode: number; OOMKilled: boolean };
  const shutdownLogs = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'compose_logs:personal-controller-shutdown',
    operation: (signal) => composeDiagnostic(signal, 'logs', '--no-color', 'hosted-controller'),
  });
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'attach:personal-controller-shutdown.json',
    operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('personal-controller-shutdown.json', {
      body: JSON.stringify({ logs: shutdownLogs, state: shutdownState }, null, 2),
      contentType: 'application/json',
    }),
  });
  expect(shutdownState).toMatchObject({ Error: '', ExitCode: 0, OOMKilled: false });
  const reconnectOriginMs = Date.now();
  const reconnectDeadlines = externalCoordinationReplayBudget.deadlinesFrom(reconnectOriginMs);
  await restartHostedV1LifecycleOwner({ compose });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__hostedE2eSse;
          return state?.opens ?? 0;
        }),
      {
        timeout: externalCoordinationReplayBudget.requireRemainingAt(
          reconnectDeadlines.replayDeadlineMs,
          Date.now()
        ),
      }
    )
    .toBeGreaterThan(reconnectBaseline.opens);
  await expect
    .poll(() => eventRequestUrls.length, {
      timeout: externalCoordinationReplayBudget.requireRemainingAt(
        reconnectDeadlines.replayDeadlineMs,
        Date.now()
      ),
    })
    .toBeGreaterThan(reconnectBaseline.opens);
  const resumeHeaders = eventRequestHeaders;
  if (resumeHeaders[0]) expect(resumeHeaders[0]['last-event-id']).toBeUndefined();
  expect(
    eventRequestUrls
      .slice(reconnectBaseline.opens)
      .some((url) => new URL(url).searchParams.get('after') === firstDeliveredCursor)
  ).toBe(true);
  // Capture and validate the exact state which crosses the completion
  // boundary. The shared helper never rereads mutable browser state or
  // substitutes a later Node-side clock reading for the heartbeat receipt.
  const reconnectProofCapture = await pollHostedV1ExternalCoordinationReconnectProof({
    baseline: reconnectBaseline,
    originMs: reconnectOriginMs,
    replayDeadlineMs: reconnectDeadlines.replayDeadlineMs,
    targetEventId: journalEventId,
    targetEventSequence: journalEventSequence,
    timeoutMs: externalCoordinationReplayBudget.requireRemainingAt(
      reconnectDeadlines.replayDeadlineMs,
      Date.now()
    ),
    stateReader: () => page.evaluate(() => window.__hostedE2eSse ?? null),
    poll: async (predicate, timeoutMs) => {
      await expect.poll(predicate, { timeout: timeoutMs }).not.toBeNull();
    },
  });
  // Nothing diagnostic may run before this proof: Playwright attachment/read
  // work is intentionally best-effort and must not consume the replay deadline.
  const reconnectProofState = JSON.parse(
    reconnectProofCapture.serializedState
  ) as HostedV1ExternalCoordinationStreamState;
  expect(reconnectProofState.ids).toEqual([firstDeliveredCursor]);
  const reconnectState = await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'page_evaluate:personal-event-stream-reconnect',
    operation: async (signal) => {
      if (signal.aborted) return null;
      const result = await page.evaluate(() => {
          const state = window.__hostedE2eSse;
          return state
            ? {
                activeStreamId: state.activeStreamId,
                error: state.error,
                opens: state.opens,
                ids: state.ids,
                cursor: state.cursor,
              }
            : null;
      });
      return signal.aborted ? null : result;
    },
  });
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'attach:personal-event-stream-reconnect.json',
    operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('personal-event-stream-reconnect.json', {
      body: JSON.stringify({
        requestUrls: eventRequestUrls,
        requestHeaders: resumeHeaders,
        state: reconnectState,
        diagnosticFailures: hostedV1DiagnosticFailures(testInfo),
        requestHeaderDiagnosticFailures: eventRequestHeaderDiagnostics,
      }, null, 2),
      contentType: 'application/json',
    }),
  });
  await expectInstanceLockRejection();
  await page.evaluate(() => {
    const state = window.__hostedE2eSse;
    if (!state) return;
    state.closed = true;
    state.activeStreamId = null;
    if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer);
    state.controller?.abort();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await teamButton.click();
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  const postRestartRuntimeBeforeBytes = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const requestPostRestartPersonalMessage = (
    text: string,
    attemptTimeoutMs: number,
    overallDeadlineAtMs: number
  ) =>
    page.evaluate(
      async ({ token, teamId, clientMessageId, text, attemptTimeoutMs, overallDeadlineAtMs }) => {
        try {
          return {
            networkError: false as const,
            ...(await window.__hostedE2eProbe(
              '/api/hosted/v1/team-messages/send',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/json',
                  'x-agent-teams-csrf': token,
                },
                body: JSON.stringify({
                  schemaVersion: 1,
                  teamId,
                  clientMessageId,
                  text,
                }),
              },
              { attemptTimeoutMs, overallDeadlineAtMs }
            )),
          };
        } catch (error) {
          return {
            networkError: true as const,
            status: null,
            rawBody: null,
            body: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        token: csrfToken,
        teamId: runtime.teamId,
        clientMessageId: personalMessageBody.receipt.clientMessageId,
        text,
        attemptTimeoutMs,
        overallDeadlineAtMs,
      }
    );
  const personalMessageRecoveryDeadline = Date.now() + 20_000;
  let postRestartPersonalReplay = await requestPostRestartPersonalMessage(
    personalMessage,
    2_000,
    personalMessageRecoveryDeadline
  );
  while (
    (postRestartPersonalReplay.status !== 200 ||
      (postRestartPersonalReplay.body as { kind?: string } | null)?.kind !== 'idempotent_replay') &&
    Date.now() < personalMessageRecoveryDeadline
  ) {
    const retryDelayMs = Math.min(250, Math.max(0, personalMessageRecoveryDeadline - Date.now()));
    if (retryDelayMs === 0) break;
    await page.waitForTimeout(retryDelayMs);
    if (Date.now() >= personalMessageRecoveryDeadline) break;
    postRestartPersonalReplay = await requestPostRestartPersonalMessage(
      personalMessage,
      Math.max(1, Math.min(2_000, personalMessageRecoveryDeadline - Date.now())),
      personalMessageRecoveryDeadline
    );
  }
  expect(postRestartPersonalReplay).toMatchObject({
    networkError: false,
    status: 200,
  });
  expect(postRestartPersonalReplay.body).toEqual({
    ...personalMessageBody,
    kind: 'idempotent_replay',
    receipt: {
      ...personalMessageBody.receipt,
      runtimeDelivery: 'operator_required',
    },
  });
  expect(JSON.parse(String(postRestartPersonalReplay.rawBody))).toEqual(
    postRestartPersonalReplay.body
  );
  const personalMessageMismatchDeadline = Date.now() + 5_000;
  const postRestartPersonalMismatch = await requestPostRestartPersonalMessage(
    `${personalMessage} with a different payload`,
    5_000,
    personalMessageMismatchDeadline
  );
  expect(postRestartPersonalMismatch).toMatchObject({
    networkError: false,
    status: 409,
  });
  expect(postRestartPersonalMismatch.body).toEqual({
    schemaVersion: 1,
    kind: 'error',
    error: { code: 'conflict', reason: 'team_message_idempotency_conflict' },
    retryable: false,
  });
  expect(JSON.parse(String(postRestartPersonalMismatch.rawBody))).toEqual(
    postRestartPersonalMismatch.body
  );
  const postRestartPersonalPage = await page.evaluate(
    ({ token, teamId }) =>
      window.__hostedE2eProbe('/api/hosted/v1/team-messages/page', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 50,
        }),
      }),
    { token: csrfToken, teamId: runtime.teamId }
  );
  expect(postRestartPersonalPage.status).toBe(200);
  expect(
    (
      postRestartPersonalPage.body as {
        messages: Array<{ messageId: string; text: string }>;
      }
    ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
  ).toEqual([
    expect.objectContaining({
      messageId: personalMessageBody.receipt.messageId,
      text: personalMessage,
    }),
  ]);
  expect(await readFile(personalInboxPath, 'utf8')).toBe(personalInboxAfterDeliveryBytes);
  expect(await readFile(runtime.fakeRuntimeStateFile, 'utf8')).toBe(postRestartRuntimeBeforeBytes);
  const postRestartPersonalState = JSON.parse(postRestartRuntimeBeforeBytes) as {
    messageLedger: Array<{ clientMessageId: string; delivered: boolean }>;
  };
  expect(
    postRestartPersonalState.messageLedger.filter(
      ({ clientMessageId }) => clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([expect.objectContaining({ delivered: true })]);
  const postRestartInboxRows = JSON.parse(personalInboxAfterDeliveryBytes) as Array<{
    hostedOperation?: { clientMessageId?: string };
    hostedDelivery?: { acknowledgement?: string };
  }>;
  expect(
    postRestartInboxRows.filter(
      (row) => row.hostedOperation?.clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([
    expect.objectContaining({
      hostedDelivery: expect.objectContaining({ acknowledgement: 'durable' }),
    }),
  ]);
  await testInfo.attach('personal-message-post-restart-durability.json', {
    body: JSON.stringify(
      {
        replay: postRestartPersonalReplay,
        mismatch: postRestartPersonalMismatch,
        projectedMessageCount: (
          postRestartPersonalPage.body as { messages: Array<{ messageId: string }> }
        ).messages.filter(({ messageId }) => messageId === personalMessageBody.receipt.messageId)
          .length,
        inboxByteStable: true,
        runtimeStateByteStable: true,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: personalMessage })
  ).toHaveCount(1);

  const originalBootstrap = process.env.E2E_LIFECYCLE_BOOTSTRAP;
  if (!originalBootstrap) throw new Error('hosted_e2e_mount_bootstrap_missing');
  const originalMountGeneration = (
    JSON.parse(originalBootstrap) as {
      workspaceManifest: { registrations: [{ mountBinding: { mountGeneration: number } }] };
    }
  ).workspaceManifest.registrations[0].mountBinding.mountGeneration;
  const fakeRuntimeStateDir = resolve(runtime.fakeRuntimeStateFile, '..');
  const scenarioRoot = resolve(fakeRuntimeStateDir, '..');
  const markerPath = resolve(scenarioRoot, '.agent-teams-hosted-v1-e2e-owner.json');
  const ownerGenerationPath = resolve(fakeRuntimeStateDir, 'owner-generation.json');
  const ownerGenerationBeforeRestart = JSON.parse(await readFile(ownerGenerationPath, 'utf8')) as {
    generation: number;
    marker: string;
  };
  const ownerGenerationBeforeRestartBytes = await readFile(ownerGenerationPath, 'utf8');
  const fakeRuntimeContainerBeforeStaleAdmission = (
    await compose('ps', '--quiet', 'fake-runtime')
  ).trim();
  expect(fakeRuntimeContainerBeforeStaleAdmission).not.toBe('');
  await compose('stop', '--timeout', '30', 'hosted-controller');
  const admissionEnvelope = JSON.parse(
    await readFile(resolve(scenarioRoot, 'lifecycle-run', 'lifecycle-owner-admission.json'), 'utf8')
  ) as { payload?: string };
  expect(typeof admissionEnvelope.payload).toBe('string');
  const admittedPayload = JSON.parse(admissionEnvelope.payload as string) as {
    bootstrapBinding?: { bootstrapDigest?: string; mountGeneration?: number };
  };
  expect(admittedPayload.bootstrapBinding).toMatchObject({
    bootstrapDigest: createHash('sha256').update(originalBootstrap).digest('hex'),
    mountGeneration: originalMountGeneration,
  });
  const freshMount = await advanceHostedV1MountGeneration({
    bootstrap: originalBootstrap,
    fakeRuntimeStateDir,
    markerPath,
    root: scenarioRoot,
  });
  expect(freshMount.mountGeneration).toBe(originalMountGeneration + 1);
  const freshMountStatePath = resolve(fakeRuntimeStateDir, 'mount-generation.json');
  const freshMountStateBytes = await readFile(freshMountStatePath, 'utf8');
  await expect(
    advanceHostedV1MountGeneration({
      bootstrap: originalBootstrap,
      fakeRuntimeStateDir,
      markerPath,
      root: scenarioRoot,
    })
  ).rejects.toThrow('hosted_e2e_mount_generation_stale');
  expect(await readFile(freshMountStatePath, 'utf8')).toBe(freshMountStateBytes);

  await compose('up', '--detach', '--no-build', '--no-deps', '--no-recreate', 'hosted-controller');
  expect((await compose('ps', '--quiet', 'fake-runtime')).trim()).toBe(
    fakeRuntimeContainerBeforeStaleAdmission
  );
  let staleRuntimeTrace: Array<{
    expectedMountGeneration?: number;
    operation?: string;
    receivedMountGeneration?: number;
    stage?: string;
  }> = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            staleRuntimeTrace = JSON.parse(
              await readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8')
            ) as typeof staleRuntimeTrace;
          } catch {
            return false;
          }
          return staleRuntimeTrace.some(
            (entry) =>
              entry.operation === 'readiness' &&
              entry.stage === 'mount_generation_stale' &&
              entry.expectedMountGeneration === freshMount.mountGeneration &&
              entry.receivedMountGeneration === originalMountGeneration
          );
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    expect(await readFile(ownerGenerationPath, 'utf8')).toBe(ownerGenerationBeforeRestartBytes);
  } finally {
    await compose('down', '--timeout', '30', '--remove-orphans');
  }
  await testInfo.attach('personal-stale-mount-generation-rejection.json', {
    body: JSON.stringify(
      {
        originalMountGeneration,
        expectedMountGeneration: freshMount.mountGeneration,
        admissionManifestBootstrapMatched: true,
        fakeRuntimeContainerRestarted: false,
        ownerGenerationByteStable: true,
        trace: staleRuntimeTrace,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });

  process.env.E2E_LIFECYCLE_BOOTSTRAP = freshMount.bootstrap;
  await compose('up', '--detach', '--wait', '--no-build');
  let freshRuntimeTrace: Array<{
    mountGeneration?: number;
    operation?: string;
    ownerGeneration?: number;
    stage?: string;
  }> = [];
  await expect
    .poll(
      async () => {
        try {
          freshRuntimeTrace = JSON.parse(
            await readFile(runtime.fakeRuntimeLifecycleTraceFile, 'utf8')
          ) as typeof freshRuntimeTrace;
        } catch {
          return false;
        }
        return freshRuntimeTrace.some(
          (entry) =>
            entry.operation === 'readiness' &&
            entry.stage === 'ready' &&
            entry.mountGeneration === freshMount.mountGeneration
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const ownerGenerationAfterRestart = JSON.parse(await readFile(ownerGenerationPath, 'utf8')) as {
    generation: number;
    marker: string;
  };
  expect(ownerGenerationAfterRestart.marker).toBe(ownerGenerationBeforeRestart.marker);
  expect(ownerGenerationAfterRestart.generation).toBeGreaterThan(
    ownerGenerationBeforeRestart.generation
  );
  expect(freshRuntimeTrace[0]).toMatchObject({
    operation: 'startup',
    stage: 'ready',
    mountGeneration: freshMount.mountGeneration,
  });
  expect(freshRuntimeTrace).toContainEqual(
    expect.objectContaining({
      operation: 'readiness',
      stage: 'ready',
      mountGeneration: freshMount.mountGeneration,
      ownerGeneration: ownerGenerationAfterRestart.generation,
    })
  );
  expect(freshRuntimeTrace).not.toContainEqual(
    expect.objectContaining({ stage: 'mount_generation_stale' })
  );
  await testInfo.attach('personal-complete-restart-mount-generation.json', {
    body: JSON.stringify(
      {
        priorMountGeneration: originalMountGeneration,
        freshMountGeneration: freshMount.mountGeneration,
        monotonicStep: freshMount.mountGeneration - originalMountGeneration,
        staleBootstrapRejectedByFixtureDriver: true,
        staleBootstrapRejectedByOwnerReadiness: true,
        durableStateByteStableAfterStaleAttempt: true,
        ownerGeneration: {
          before: ownerGenerationBeforeRestart.generation,
          after: ownerGenerationAfterRestart.generation,
        },
        runtimeStartup: freshRuntimeTrace[0],
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectRegisteredWorkspace(page);
  await (await exactRuntimeTeamButton(page)).click();
  await expect(page.getByText('Updated sandbox task')).toBeVisible();
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: personalMessage })
  ).toHaveCount(1);
  expect(await readFile(personalInboxPath, 'utf8')).toBe(personalInboxAfterDeliveryBytes);
  const completeRestartRuntimeState = JSON.parse(
    await readFile(runtime.fakeRuntimeStateFile, 'utf8')
  ) as { messageLedger: Array<{ clientMessageId: string; delivered: boolean }> };
  expect(
    completeRestartRuntimeState.messageLedger.filter(
      ({ clientMessageId }) => clientMessageId === personalMessageBody.receipt.clientMessageId
    )
  ).toEqual([expect.objectContaining({ delivered: true })]);
  await expect(readFile(taskWalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  const originalSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  )?.value;
  const personalLogoutResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/auth/logout';
  });
  const personalLogoutReloadPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  void personalLogoutResponsePromise.catch(() => undefined);
  void personalLogoutReloadPromise.catch(() => undefined);
  await page.getByRole('button', { name: 'Sign out' }).click();
  const personalLogoutResponse = await personalLogoutResponsePromise;
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'attach:personal-local-logout-response.json',
    operation: async (signal) => {
      if (signal.aborted) return;
      const headers = await personalLogoutResponse.allHeaders();
      if (signal.aborted) return;
      await testInfo.attach('personal-local-logout-response.json', {
      body: JSON.stringify(
        {
          method: personalLogoutResponse.request().method(),
          url: personalLogoutResponse.url(),
          status: personalLogoutResponse.status(),
          headers,
        },
        null,
        2
      ),
      contentType: 'application/json',
      });
    },
  });
  expect(personalLogoutResponse.status()).toBe(200);
  await personalLogoutReloadPromise;
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  let renewedSession: string | undefined;
  await expect
    .poll(async () => {
      renewedSession = (await context.cookies(runtime.origin)).find(
        (cookie) => cookie.name === '__Host-agent-teams-session'
      )?.value;
      return Boolean(renewedSession && renewedSession !== originalSession);
    })
    .toBe(true);
  expect(renewedSession).toBeTruthy();

  await page.getByRole('button', { name: 'Forget browser' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  expect(
    (await context.cookies(runtime.origin)).filter((cookie) =>
      cookie.name.startsWith('__Host-agent-teams-')
    )
  ).toHaveLength(0);
});

test('production HTTPS OIDC flow uses the isolated provider without pairing fallback', async ({
  context,
  page,
}, rawTestInfo) => {
  const testInfo = bestEffortDiagnosticTestInfo(rawTestInfo);
  test.setTimeout(180_000);
  test.skip(runtime.authMode !== 'oidc', 'OIDC-mode scenario only');
  const documentResponse = await page.goto(runtime.origin, {
    waitUntil: 'domcontentloaded',
  });
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()['strict-transport-security']).toContain('max-age=31536000');
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await expect(page.getByText('Continue with Synthetic OIDC.')).toBeVisible();

  const oidcNavigationUrls: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) oidcNavigationUrls.push(request.url());
  });
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByRole('complementary', { name: 'Hosted account' })).toBeVisible();
  await expect(page.getByText('Synthetic OIDC Owner')).toBeVisible();
  await expect(page.getByText('owner', { exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(runtime.origin);
  const providerAuthorizationNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(({ pathname }) => pathname === '/authorize');
  expect(providerAuthorizationNavigation).toBeDefined();
  expect(providerAuthorizationNavigation?.searchParams.get('client_id')).toBe(
    'agent-teams-hosted-e2e'
  );
  expect(providerAuthorizationNavigation?.searchParams.get('redirect_uri')).toBe(
    `${runtime.origin}/api/auth/oidc/callback`
  );
  expect(providerAuthorizationNavigation?.searchParams.get('response_type')).toBe('code');
  expect(providerAuthorizationNavigation?.searchParams.get('code_challenge_method')).toBe('S256');
  const callbackNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(
      ({ origin, pathname }) => origin === runtime.origin && pathname === '/api/auth/oidc/callback'
    );
  expect(callbackNavigation).toBeDefined();
  expect([...callbackNavigation!.searchParams.keys()].sort()).toEqual(['code', 'state']);
  expect(callbackNavigation?.searchParams.get('code')).toMatch(/\S/u);
  expect(callbackNavigation?.searchParams.get('state')).toMatch(/\S/u);

  const status = await page.evaluate(async () => {
    return window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
  });
  const statusBody =
    typeof status.body === 'object' && status.body !== null && !Array.isArray(status.body)
      ? (status.body as Record<string, unknown>)
      : {};
  const statusPrincipal =
    typeof statusBody.principal === 'object' &&
    statusBody.principal !== null &&
    !Array.isArray(statusBody.principal)
      ? (statusBody.principal as Record<string, unknown>)
      : {};
  const csrfToken = typeof statusBody.csrfToken === 'string' ? statusBody.csrfToken : null;
  const authenticatedStatusEvidence = {
    status: status.status,
    mode: typeof statusBody.mode === 'string' ? statusBody.mode : null,
    authenticated: typeof statusBody.authenticated === 'boolean' ? statusBody.authenticated : null,
    principalDisplayName:
      typeof statusPrincipal.displayName === 'string' ? statusPrincipal.displayName : null,
    principalRole: typeof statusPrincipal.role === 'string' ? statusPrincipal.role : null,
    principalAuthenticationMethod:
      typeof statusPrincipal.authenticationMethod === 'string'
        ? statusPrincipal.authenticationMethod
        : null,
    csrfTokenPresent: csrfToken !== null,
    csrfTokenFormatValid: csrfToken !== null && /^[A-Za-z0-9_-]{32,}$/u.test(csrfToken),
  };
  expect(authenticatedStatusEvidence).toEqual({
    status: 200,
    mode: 'oidc',
    authenticated: true,
    principalDisplayName: 'Synthetic OIDC Owner',
    principalRole: 'owner',
    principalAuthenticationMethod: 'oidc',
    csrfTokenPresent: true,
    csrfTokenFormatValid: true,
  });
  if (!csrfToken) throw new Error('hosted_e2e_oidc_csrf_token_missing');

  const cookies = await context.cookies(runtime.origin);
  const session = cookies.find((cookie) => cookie.name === '__Host-agent-teams-session');
  const sessionCookieEvidence = {
    present: session !== undefined,
    secure: session?.secure ?? null,
    httpOnly: session?.httpOnly ?? null,
    sameSite: session?.sameSite ?? null,
    path: session?.path ?? null,
  };
  expect(sessionCookieEvidence).toEqual({
    present: true,
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  if (session === undefined) throw new Error('hosted_e2e_oidc_session_cookie_missing');
  expect(cookies.some((cookie) => cookie.name === '__Host-agent-teams-device')).toBe(false);
  expect(cookies.some((cookie) => cookie.name.startsWith('__Host-agent-teams-oidc-'))).toBe(false);

  const providerOrigin = providerAuthorizationNavigation!.origin;
  const cookieHeader = `${session.name}=${session.value}`;
  const foreignAuthorityBudget = createHostedV1ProbeDeadlineBudget({
    overallTimeoutMs: 10_000,
    perAttemptTimeoutMs: E2E_PROBE_ATTEMPT_TIMEOUT_MS,
  });
  for (const [name, tlsOrigin, authority] of [
    ['application SNI with OIDC authority', runtime.origin, new URL(providerOrigin).host],
    ['OIDC SNI with application authority', providerOrigin, new URL(runtime.origin).host],
  ] as const) {
    const mismatchedHost = await probeForeignAuthority(
      tlsOrigin,
      cookieHeader,
      authority,
      foreignAuthorityBudget
    );
    const mismatchedHostEvidence = {
      status: mismatchedHost.headers[':status'] ?? null,
      setCookiePresent: mismatchedHost.headers['set-cookie'] !== undefined,
      authenticatedTrueMarkerPresent: /"authenticated"\s*:\s*true/u.test(mismatchedHost.body),
    };
    await testInfo.attach(`${name.replaceAll(' ', '-')}-response.json`, {
      body: JSON.stringify(mismatchedHostEvidence, null, 2),
      contentType: 'application/json',
    });
    expect(mismatchedHostEvidence, name).toEqual({
      status: 421,
      setCookiePresent: false,
      authenticatedTrueMarkerPresent: false,
    });
  }

  await selectRegisteredWorkspace(page);
  const teamButton = await exactRuntimeTeamButton(page);
  await teamButton.click();
  await page.getByLabel('New task title').fill('OIDC owner sandbox task');
  await clickAndExpectCommittedTaskMutation(page, testInfo, 'oidc-create-task', () =>
    page.getByRole('button', { name: 'Save task' }).click()
  );
  await expect(page.getByText('OIDC owner sandbox task')).toBeVisible();

  const oidcMessage = 'OIDC owner durable delivery proof';
  const messageResponsePromise = page
    .waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/hosted/v1/team-messages/send'
      );
    })
    .then((response) => captureOriginalHttpResponse(response));
  void messageResponsePromise.catch(() => undefined);
  await page.getByLabel('New message').fill(oidcMessage);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const messageResponse = await messageResponsePromise;
  await testInfo.attach('oidc-owner-message-send-response.json', {
    body: JSON.stringify(messageResponse, null, 2),
    contentType: 'application/json',
  });
  expect(messageResponse.capture, 'OIDC message response capture source').toBe(
    'playwright_original_response'
  );
  expect(messageResponse.method, 'OIDC owner message send method').toBe('POST');
  expect(new URL(messageResponse.url).pathname, 'OIDC owner message send path').toBe(
    '/api/hosted/v1/team-messages/send'
  );
  expect(messageResponse.status, 'OIDC owner message send status').toBe(200);
  expect(
    messageResponse.bodyBytes,
    'OIDC bounded original message response bytes'
  ).toBeLessThanOrEqual(E2E_PROBE_RESPONSE_MAX_BYTES);
  const oidcMessageBody = JSON.parse(messageResponse.rawBody) as {
    kind: string;
    receipt: { messageId: string; clientMessageId: string };
  };
  expect(oidcMessageBody, 'OIDC owner fresh durable delivery receipt').toMatchObject({
    kind: 'persisted',
    receipt: {
      schemaVersion: 1,
      teamId: runtime.teamId,
      messageId: expect.stringMatching(/^message_[0-9a-f]{32}$/u),
      clientMessageId: expect.stringMatching(/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u),
      persistence: 'durable',
      runtimeDelivery: 'delivered',
    },
  });
  await expect(
    page.getByTestId('hosted-team-message').filter({ hasText: oidcMessage })
  ).toBeVisible();
  const oidcMessageReplayAndPage = await page.evaluate(
    async ({ token, teamId, text, clientMessageId }) => {
      const overallDeadlineAtMs = Date.now() + 10_000;
      const replay = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/send',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({ schemaVersion: 1, teamId, clientMessageId, text }),
        },
        { overallDeadlineAtMs }
      );
      const pageResponse = await window.__hostedE2eProbe(
        '/api/hosted/v1/team-messages/page',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
          body: JSON.stringify({
            schemaVersion: 1,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: 50,
          }),
        },
        { overallDeadlineAtMs }
      );
      return { replay, page: pageResponse };
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      text: oidcMessage,
      clientMessageId: oidcMessageBody.receipt.clientMessageId,
    }
  );
  expect(oidcMessageReplayAndPage.replay).toMatchObject({
    status: 200,
    body: {
      kind: 'idempotent_replay',
      receipt: {
        messageId: oidcMessageBody.receipt.messageId,
        clientMessageId: oidcMessageBody.receipt.clientMessageId,
      },
    },
  });
  expect(oidcMessageReplayAndPage.page).toMatchObject({
    status: 200,
    body: {
      messages: expect.arrayContaining([
        expect.objectContaining({
          messageId: oidcMessageBody.receipt.messageId,
          text: oidcMessage,
        }),
      ]),
    },
  });

  const lifecycleRead = await page.evaluate(
    async ({ token }) => {
      return window.__hostedE2eProbe('/api/teams/lifecycle/read', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({ schemaVersion: 1, cursor: null, expectedRevision: null }),
      });
    },
    { token: csrfToken }
  );
  expect(lifecycleRead.status).toBe(200);
  const lifecycleItem = (
    lifecycleRead.body as {
      items: { revision: string; teamId: string; workspaceId: string }[];
    }
  ).items.find(
    (item) => item.teamId === runtime.teamId && item.workspaceId === runtime.workspaceId
  );
  expect(lifecycleItem?.revision).toMatch(/^revision_/u);
  if (lifecycleItem === undefined) throw new Error('hosted_e2e_oidc_active_team_missing');
  const lifecycleResponse = await page.evaluate(
    async ({ token, identity }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-oidc-owner',
          idempotencyKey: 'idempotency_hosted-v1-oidc-owner',
          workspaceId: identity.workspaceId,
          teamId: identity.teamId,
          expectedRevision: identity.revision,
        }),
      });
    },
    { token: csrfToken, identity: lifecycleItem }
  );
  await trackHostedV1BestEffortDiagnostic(testInfo, {
    name: 'attach:oidc-owner-lifecycle-launch-response.json',
    operation: (signal) => signal.aborted ? Promise.resolve() : testInfo.attach('oidc-owner-lifecycle-launch-response.json', {
      body: JSON.stringify(lifecycleResponse, null, 2),
      contentType: 'application/json',
    }),
  });
  expect(lifecycleResponse).toMatchObject({
    status: 202,
    body: {
      schemaVersion: 1,
      kind: 'accepted',
      action: 'launch',
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
      resourceRevision: expect.stringMatching(/^revision_/u),
      runId: expect.stringMatching(/^run_/u),
    },
  });
  expect((lifecycleResponse.body as { resourceRevision: string }).resourceRevision).not.toBe(
    lifecycleItem.revision
  );
  const lifecycleEvidence = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: { teamId: string; runId: string }[];
    commands: { action: string; teamId: string; runId: string }[];
    eventIds: string[];
  };
  const oidcRunId = String((lifecycleResponse.body as { runId: string }).runId);
  expect(lifecycleEvidence.commands).toContainEqual(
    expect.objectContaining({
      action: 'launch',
      teamId: runtime.teamId,
      runId: oidcRunId,
    })
  );
  expect(lifecycleEvidence.activeRuns).toContainEqual({ teamId: runtime.teamId, runId: oidcRunId });
  expect(lifecycleEvidence.eventIds).toHaveLength(1);

  const oidcStop = await page.evaluate(
    async ({ token, workspaceId, teamId, runId, expectedRevision }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/stop', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-agent-teams-csrf': token },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-oidc-owner-stop',
          idempotencyKey: 'idempotency_hosted-v1-oidc-owner-stop',
          workspaceId,
          teamId,
          runId,
          expectedRevision,
        }),
      });
    },
    {
      token: csrfToken,
      workspaceId: runtime.workspaceId,
      teamId: runtime.teamId,
      runId: oidcRunId,
      expectedRevision: String(
        (lifecycleResponse.body as { resourceRevision: string }).resourceRevision
      ),
    }
  );
  expect(oidcStop).toMatchObject({
    status: 202,
    body: { kind: 'accepted', action: 'stop', runId: oidcRunId },
  });
  const stoppedOidcLifecycle = JSON.parse(await readFile(runtime.fakeRuntimeStateFile, 'utf8')) as {
    activeRuns: unknown[];
    commands: { action: string }[];
  };
  expect(stoppedOidcLifecycle.activeRuns).toEqual([]);
  expect(stoppedOidcLifecycle.commands.at(-1)).toMatchObject({ action: 'stop' });

  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  const providerLogoutNavigation = oidcNavigationUrls
    .map((value) => new URL(value))
    .find(({ pathname }) => pathname === '/logout');
  expect(providerLogoutNavigation).toBeDefined();
  expect(providerLogoutNavigation?.origin).toBe(providerAuthorizationNavigation?.origin);
  expect(providerLogoutNavigation?.searchParams.get('client_id')).toBe('agent-teams-hosted-e2e');
  expect(providerLogoutNavigation?.searchParams.get('post_logout_redirect_uri')).toBe(
    `${runtime.origin}/`
  );
  expect(
    oidcNavigationUrls
      .map((value) => new URL(value))
      .some((url) => url.href === `${runtime.origin}/`)
  ).toBe(true);
  expect(
    (await context.cookies(runtime.origin)).some(
      (cookie) => cookie.name === '__Host-agent-teams-session'
    )
  ).toBe(false);
  await expectOriginalOidcSessionRevoked(
    testInfo,
    'oidc-owner-pre-logout-session-revocation',
    cookieHeader
  );
});

test('OIDC viewer is isolated from workspace mutations', async ({ page, context }, rawTestInfo) => {
  const testInfo = bestEffortDiagnosticTestInfo(rawTestInfo);
  test.setTimeout(180_000);
  test.skip(runtime.authMode !== 'oidc-viewer', 'OIDC viewer scenario only');
  const viewerNavigationUrls: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) viewerNavigationUrls.push(request.url());
  });
  await page.goto(runtime.origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByText('viewer', { exact: true })).toBeVisible();
  const csrfToken = await page.evaluate(async () => {
    const response = await window.__hostedE2eProbe('/api/auth/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    return (response.body as { csrfToken: string | null }).csrfToken;
  });
  expect(
    typeof csrfToken === 'string' && /^[A-Za-z0-9_-]{32,}$/u.test(csrfToken),
    'OIDC viewer CSRF token is present and valid'
  ).toBe(true);
  if (!csrfToken) throw new Error('hosted_e2e_oidc_viewer_csrf_token_missing');
  const viewerTaskDirectory = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'tasks',
    runtime.teamName
  );
  const viewerTeamDirectory = resolve(
    runtime.fakeRuntimeStateFile,
    '..',
    '..',
    'claude',
    'teams',
    runtime.teamName
  );
  const viewerRuntimeStateBeforeText = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const viewerRuntimeStateBefore = JSON.parse(viewerRuntimeStateBeforeText) as {
    commands?: unknown[];
    taskLedger?: unknown[];
  };
  const viewerTaskFilesBefore = await snapshotDirectoryFiles(viewerTaskDirectory);
  const viewerTeamFilesBefore = await snapshotDirectoryFiles(viewerTeamDirectory);
  const viewerTaskBoardPage = await page.evaluate(
    async ({ token, teamId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/page', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 100,
        }),
      });
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  await testInfo.attach('oidc-viewer-task-board-page-response.json', {
    body: JSON.stringify(viewerTaskBoardPage, null, 2),
    contentType: 'application/json',
  });
  expect(viewerTaskBoardPage).toMatchObject({
    status: 200,
    body: {
      sourceGeneration: expect.any(String),
      revision: expect.any(String),
    },
  });
  const viewerTaskBoard = viewerTaskBoardPage.body as {
    sourceGeneration: string;
    revision: string;
  };
  await selectRegisteredWorkspace(page);
  await (await exactRuntimeTeamButton(page)).click();
  await expect(page.getByText('Marker-owned browser E2E task', { exact: true })).toBeVisible();
  await expect(page.getByText('No messages yet.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('New task title')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save task', exact: true })).toHaveCount(0);
  const messageDenial = await page.evaluate(
    async ({ token, teamId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-messages/send', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          teamId,
          clientMessageId: 'client_message_hosted-v1-viewer-denied',
          text: 'Viewer must not persist or deliver this message',
        }),
      });
    },
    { token: csrfToken, teamId: runtime.teamId }
  );
  await testInfo.attach('oidc-viewer-message-send-denial-response.json', {
    body: JSON.stringify(messageDenial, null, 2),
    contentType: 'application/json',
  });
  expect(messageDenial.status).toBe(403);
  expect(messageDenial.body).toEqual({ error: 'permission_denied' });
  const denial = await page.evaluate(
    async ({ token, teamId, workspaceId }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-lifecycle/launch', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: 'lifecycle-command_hosted-v1-viewer',
          idempotencyKey: 'idempotency_hosted-v1-viewer',
          workspaceId,
          teamId,
          expectedRevision: 'revision_hosted-v1-e2e-0001',
        }),
      });
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      workspaceId: runtime.workspaceId,
    }
  );
  await testInfo.attach('oidc-viewer-lifecycle-launch-denial-response.json', {
    body: JSON.stringify(denial, null, 2),
    contentType: 'application/json',
  });
  expect(denial.status).toBe(403);
  expect(denial.body).toEqual({ error: 'permission_denied' });
  const taskDenial = await page.evaluate(
    async ({ token, teamId, sourceGeneration, revision }) => {
      return window.__hostedE2eProbe('/api/hosted/v1/team-task-board/mutations', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-agent-teams-csrf': token ?? '',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: 'create_task',
          commandId: 'command_hosted-v1-viewer-task',
          idempotencyKey: 'idempotency_hosted-v1-viewer-task',
          teamId,
          expectedSourceGeneration: sourceGeneration,
          expectedRevision: revision,
          subject: 'Viewer must not create this task',
          description: null,
          status: 'pending',
          ownerId: null,
          column: 'todo',
          order: 0,
        }),
      });
    },
    {
      token: csrfToken,
      teamId: runtime.teamId,
      sourceGeneration: viewerTaskBoard.sourceGeneration,
      revision: viewerTaskBoard.revision,
    }
  );
  await testInfo.attach('oidc-viewer-task-mutation-denial-response.json', {
    body: JSON.stringify(taskDenial, null, 2),
    contentType: 'application/json',
  });
  expect(taskDenial.status).toBe(403);
  expect(taskDenial.body).toEqual({ error: 'permission_denied' });
  const viewerRuntimeStateAfterText = await readFile(runtime.fakeRuntimeStateFile, 'utf8');
  const viewerRuntimeStateAfter = JSON.parse(viewerRuntimeStateAfterText) as {
    commands?: unknown[];
    taskLedger?: unknown[];
  };
  expect(viewerRuntimeStateAfterText, 'viewer denials must not rewrite runtime state').toBe(
    viewerRuntimeStateBeforeText
  );
  expect(
    viewerRuntimeStateAfter.commands,
    'viewer denial must not append lifecycle commands'
  ).toEqual(viewerRuntimeStateBefore.commands);
  expect(viewerRuntimeStateAfter.taskLedger, 'viewer denial must not append task commands').toEqual(
    viewerRuntimeStateBefore.taskLedger
  );
  expect(
    await snapshotDirectoryFiles(viewerTaskDirectory),
    'viewer task denial must not create or rewrite task files'
  ).toEqual(viewerTaskFilesBefore);
  expect(
    await snapshotDirectoryFiles(viewerTeamDirectory),
    'viewer denials must not create or rewrite team state including kanban'
  ).toEqual(viewerTeamFilesBefore);
  const viewerFakeRuntimeDirectory = resolve(runtime.fakeRuntimeStateFile, '..');
  await expect(
    readFile(resolve(viewerFakeRuntimeDirectory, 'task-mutation.wal.json'))
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(resolve(viewerFakeRuntimeDirectory, 'task-mutation.crash.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });

  const viewerSession = (await context.cookies(runtime.origin)).find(
    (cookie) => cookie.name === '__Host-agent-teams-session'
  );
  expect(viewerSession).toBeDefined();
  if (viewerSession === undefined) throw new Error('hosted_e2e_oidc_viewer_session_cookie_missing');
  const viewerSessionCookieHeader = `${viewerSession.name}=${viewerSession.value}`;
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to this deployment' })).toBeVisible();
  expect(
    viewerNavigationUrls
      .map((value) => new URL(value))
      .some(({ pathname }) => pathname === '/logout')
  ).toBe(true);
  expect(
    (await context.cookies(runtime.origin)).some(
      (cookie) =>
        cookie.name === '__Host-agent-teams-session' ||
        cookie.name.startsWith('__Host-agent-teams-oidc')
    )
  ).toBe(false);
  await expectOriginalOidcSessionRevoked(
    testInfo,
    'oidc-viewer-pre-logout-session-revocation',
    viewerSessionCookieHeader
  );
});
