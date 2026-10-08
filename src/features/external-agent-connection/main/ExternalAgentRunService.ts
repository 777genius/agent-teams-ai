import { randomUUID } from 'node:crypto';

import { TEAM_TEMPLATES } from '@features/team-templates';
import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';

import { EXTERNAL_AGENT_RUN_MAX_TASK_LENGTH } from '../contracts';
import { buildExternalAgentPrompt } from '../core/domain/connectionPrompt';
import { canRunExternalAgent } from '../core/domain/runReadiness';

import type {
  AppConnectionContext,
  ConnectionInfoV1,
  ExternalAgentRunApi,
  ExternalAgentRunAvailability,
  ExternalAgentRunRequest,
  ExternalAgentRunSnapshot,
  ExternalAgentRunStatus,
} from '../contracts';
import type { CliProviderStatus } from '@shared/types';

export interface PreparedExternalAgentRun {
  launch(prompt: string, onOutput: (chunk: string) => void): Promise<{ successful: boolean }>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export interface ExternalAgentRunDependencies {
  getAvailability(): Promise<ExternalAgentRunAvailability>;
  getConnectionInfo(): Promise<ConnectionInfoV1>;
  withExpectedContext<T>(context: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  getProviderStatus(
    provider: ExternalAgentRunRequest['providerId']
  ): Promise<CliProviderStatus | null>;
  prepare(
    provider: ExternalAgentRunRequest['providerId'],
    connection: ConnectionInfoV1
  ): Promise<PreparedExternalAgentRun>;
}
interface ActiveRun {
  snapshot: ExternalAgentRunSnapshot;
  cancelled: boolean;
  timedOut: boolean;
  runtime: PreparedExternalAgentRun | null;
  done: Promise<void>;
  interrupted: Promise<never>;
  interrupt(): void;
}
const MAX_LOG_LENGTH = 64_000;

function validateRequest(input: unknown): ExternalAgentRunRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid run request');
  const value = input as Record<string, unknown>;
  const expected = value.expectedContext as Record<string, unknown> | undefined;
  if (
    Object.keys(value).some((key) => !['providerId', 'task', 'expectedContext'].includes(key)) ||
    !['anthropic', 'codex'].includes(String(value.providerId)) ||
    typeof value.task !== 'string' ||
    !value.task.trim() ||
    value.task.length > EXTERNAL_AGENT_RUN_MAX_TASK_LENGTH ||
    !expected ||
    typeof expected.appInstanceId !== 'string' ||
    typeof expected.dataRootFingerprint !== 'string' ||
    !Number.isSafeInteger(expected.connectionGeneration) ||
    Number(expected.connectionGeneration) < 1 ||
    Object.keys(expected).some(
      (key) => !['appInstanceId', 'dataRootFingerprint', 'connectionGeneration'].includes(key)
    )
  ) {
    throw new Error('Invalid run request');
  }
  return {
    providerId: value.providerId as ExternalAgentRunRequest['providerId'],
    task: value.task.trim(),
    expectedContext: { ...expected } as unknown as AppConnectionContext,
  };
}

/** One owned run. Reservation precedes every await; late preparation cannot launch after cancel. */
export class ExternalAgentRunService implements ExternalAgentRunApi {
  private active: ActiveRun | null = null;
  private latest: ExternalAgentRunSnapshot | null = null;
  private stopping = false;

  constructor(private readonly deps: ExternalAgentRunDependencies) {}

  getAvailability(): Promise<ExternalAgentRunAvailability> {
    return this.deps.getAvailability();
  }

  async getSnapshot(): Promise<ExternalAgentRunSnapshot | null> {
    const latest = this.latest;
    if (!latest) return null;
    try {
      return await this.deps.withExpectedContext(latest.context, async () => ({
        ...latest,
        context: { ...latest.context },
      }));
    } catch {
      // Transport replacement can invalidate generation without a root switch. Do not hide
      // a still-owned process and strand Cancel while duplicate-start admission remains closed.
      if (this.active?.snapshot.runId === latest.runId) await this.stopCurrent();
      return null;
    }
  }

  async start(input: ExternalAgentRunRequest): Promise<ExternalAgentRunSnapshot> {
    if (this.stopping || this.active)
      throw new Error('An agent run is already active or shutting down');
    const request = validateRequest(input);
    const snapshot: ExternalAgentRunSnapshot = {
      runId: randomUUID(),
      providerId: request.providerId,
      task: request.task,
      context: Object.freeze({ ...request.expectedContext }),
      status: 'preparing',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logs: '',
      error: null,
    };
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error('Run interrupted'));
    });
    // Cancellation is expected and may happen between two awaited operations.
    void interrupted.catch(() => undefined);
    const run: ActiveRun = {
      snapshot,
      cancelled: false,
      timedOut: false,
      runtime: null,
      done: Promise.resolve(),
      interrupted,
      interrupt,
    };
    this.latest = snapshot;
    this.active = run;
    run.done = this.execute(run, request);
    return { ...snapshot, context: { ...snapshot.context } };
  }

  async cancel(input: { runId: string }): Promise<ExternalAgentRunSnapshot | null> {
    if (
      !input ||
      typeof input.runId !== 'string' ||
      Object.keys(input).some((key) => key !== 'runId')
    ) {
      throw new Error('Invalid cancellation request');
    }
    const run = this.active;
    if (run?.snapshot.runId === input.runId) {
      run.cancelled = true;
      run.interrupt();
      if (run.runtime) await run.runtime.stop();
    }
    return this.getSnapshot();
  }

  async stopCurrent(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.cancelled = true;
    run.interrupt();
    if (run.runtime) await run.runtime.stop();
    await run.done;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.stopCurrent();
  }

  private publish(run: ActiveRun, patch: Partial<ExternalAgentRunSnapshot>): void {
    run.snapshot = { ...run.snapshot, ...patch };
    if (this.active === run) this.latest = run.snapshot;
  }

  private async assertReady(request: ExternalAgentRunRequest): Promise<void> {
    const provider = await this.deps.getProviderStatus(request.providerId);
    if (!canRunExternalAgent(provider))
      throw new Error('Provider is not authenticated and ready for native one-shot execution');
  }

  private async execute(run: ActiveRun, request: ExternalAgentRunRequest): Promise<void> {
    let terminal: ExternalAgentRunStatus = 'failed';
    let error: string | null = null;
    const timeout = setTimeout(() => {
      run.timedOut = true;
      run.cancelled = true;
      run.interrupt();
      void run.runtime?.stop().catch(() => undefined);
    }, 10 * 60_000);
    timeout.unref?.();
    try {
      const guarded = <T>(operation: Promise<T>): Promise<T> =>
        Promise.race([operation, run.interrupted]);
      const connection = await guarded(this.deps.getConnectionInfo());
      await this.deps.withExpectedContext(request.expectedContext, async () => {
        await guarded(this.assertReady(request));
      });
      if (run.cancelled) return;
      run.runtime = await guarded(
        this.deps.prepare(request.providerId, connection).then(async (runtime) => {
          if (run.cancelled) {
            await runtime.dispose();
            throw new Error('Run interrupted');
          }
          // Claim ownership before promise adoption: cancellation can win the next microtask.
          run.runtime = runtime;
          return runtime;
        })
      );
      if (run.cancelled) return;
      let execution: Promise<{ successful: boolean }> | undefined;
      await this.deps.withExpectedContext(request.expectedContext, async () => {
        await guarded(this.assertReady(request));
        // Re-read discovery after binary/env preparation: transport replacement invalidates admission.
        const fresh = await guarded(this.deps.getConnectionInfo());
        if (
          fresh.context.appInstanceId !== request.expectedContext.appInstanceId ||
          fresh.context.dataRootFingerprint !== request.expectedContext.dataRootFingerprint ||
          fresh.context.connectionGeneration !== request.expectedContext.connectionGeneration ||
          fresh.mcp.url !== connection.mcp.url
        )
          throw new Error('App connection changed before native launch');
        if (run.cancelled) return;
        const prompt = buildExternalAgentPrompt({
          task: request.task,
          intent: 'manage',
          templates: TEAM_TEMPLATES,
          connection: fresh,
          includeCdp: false,
        });
        this.publish(run, { status: 'running' });
        execution = run.runtime!.launch(prompt, (chunk) => {
          const redacted = boundedDiagnosticString(chunk, MAX_LOG_LENGTH);
          if (redacted)
            this.publish(run, { logs: `${run.snapshot.logs}${redacted}\n`.slice(-MAX_LOG_LENGTH) });
        });
      });
      if (execution) {
        const result = await guarded(execution);
        terminal = result.successful ? 'completed' : 'failed';
        if (!result.successful)
          error = 'Native agent reported failure. Inspect the output for details.';
      }
    } catch {
      // CLI spawn errors can contain arguments, prompt or environment; never expose them.
      error =
        'Native agent could not run. Refresh the app connection and provider status, then retry.';
    } finally {
      clearTimeout(timeout);
      let cleanupFailed = false;
      try {
        await run.runtime?.dispose();
      } catch {
        cleanupFailed = true;
        this.stopping = true;
        terminal = 'failed';
        error = 'Native run cleanup failed. Restart the app before another run.';
      }
      if (run.cancelled && !cleanupFailed) {
        terminal = run.timedOut ? 'failed' : 'cancelled';
        error = run.timedOut ? 'Native agent run timed out' : null;
      }
      this.publish(run, { status: terminal, error, finishedAt: new Date().toISOString() });
      if (this.active === run) this.active = null;
    }
  }
}
