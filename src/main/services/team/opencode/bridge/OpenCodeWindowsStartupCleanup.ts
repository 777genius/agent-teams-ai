import { randomUUID } from 'node:crypto';

import { cleanupManagedOpenCodeServeProcesses } from './OpenCodeManagedHostProcessCleanup';
import { isStartupCleanupData } from './OpenCodeStartupCleanupBridge';
import { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget';
import {
  beginOpenCodeStartupRuntimeSweep,
  OpenCodeStartupCleanupBusyError,
  reportOpenCodeStartupCleanupFailure,
} from './OpenCodeStartupSweepGate';

import type { OpenCodeReadinessBridge } from './OpenCodeReadinessBridge';
import type { OpenCodeStartupCleanupRecoveryStatus } from '@shared/types/openCodeStartupCleanup';

type StartupCleanupBridge = Pick<OpenCodeReadinessBridge, 'cleanupOpenCodeStartupHosts'> &
  Partial<Pick<OpenCodeReadinessBridge, 'observeOpenCodeStartupCleanup'>>;

interface StartupCleanupPorts {
  appStartedAtMs: number;
  profileScope: string;
  ownershipMarkers?: Pick<
    Parameters<typeof cleanupManagedOpenCodeServeProcesses>[0],
    'requiredDetailsMarkers' | 'requiredServeConfigMarkersAny'
  >;
  logWarning(message: string): void;
  sweep?: typeof cleanupManagedOpenCodeServeProcesses;
  createBudget?: () => OpenCodeStartupCleanupBudget;
  waitMs?: (ms: number) => Promise<void>;
  maintenance?: (canAdmit: () => boolean) => Promise<void>;
}

let startupAdmissionsStopped = false;
let startupCleanupOwner:
  | Pick<OpenCodeWindowsStartupCleanup, 'retry' | 'getStatus' | 'stopAdmitting'>
  | undefined;

export function stopAdmittingOpenCodeStartupCleanup(): void {
  startupAdmissionsStopped = true;
  startupCleanupOwner?.stopAdmitting();
}

/** Explicit main-process retry boundary. Never retains or resumes a launch request. */
export function getOpenCodeWindowsStartupCleanupStatus(): OpenCodeStartupCleanupRecoveryStatus {
  return startupCleanupOwner?.getStatus() ?? { state: 'unavailable' };
}

export async function retryOpenCodeWindowsStartupCleanup(): Promise<OpenCodeStartupCleanupRecoveryStatus> {
  if (!startupCleanupOwner) throw new Error('Windows startup cleanup has not been initialized');
  await startupCleanupOwner.retry();
  return startupCleanupOwner.getStatus();
}

/** In-memory owner of the one startup operation; retry never queues a launch. */
export class OpenCodeWindowsStartupCleanup {
  private budget: OpenCodeStartupCleanupBudget;
  private settle: () => void;
  private pending: Promise<void> | undefined;
  private preflightWork: Promise<void> = Promise.resolve();
  private uncertain = false;
  private stopped = startupAdmissionsStopped;
  private initialized = false;
  private scanPartial = false;
  private coverage: 'partial' | 'complete' = 'partial';
  private requestId: string | undefined;
  private tailFenceMs: number | undefined;
  private bridge: StartupCleanupBridge | null = null;
  private readonly sweep: typeof cleanupManagedOpenCodeServeProcesses;
  private timer: ReturnType<typeof setTimeout>;

  constructor(private readonly ports: StartupCleanupPorts) {
    this.settle = beginOpenCodeStartupRuntimeSweep();
    this.budget = this.newBudget();
    this.sweep = ports.sweep ?? cleanupManagedOpenCodeServeProcesses;
    this.timer = this.armDeadline();
    startupCleanupOwner = {
      retry: () => this.retry(),
      getStatus: () => this.getStatus(),
      stopAdmitting: () => this.stopAdmitting(),
    };
    if (this.stopped) clearTimeout(this.timer);
  }

  getStatus(): OpenCodeStartupCleanupRecoveryStatus {
    return {
      state: this.stopped
        ? 'stopped'
        : this.pending || !this.initialized
          ? 'pending'
          : this.uncertain
            ? 'unknown'
            : this.coverage,
      requestId: this.requestId,
    };
  }

  stopAdmitting(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private newBudget(): OpenCodeStartupCleanupBudget {
    return this.ports.createBudget?.() ?? new OpenCodeStartupCleanupBudget();
  }

  private armDeadline(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.pending && !this.uncertain) {
        this.ports.logWarning(
          'OpenCode startup cleanup partial: initialization exhausted the budget; manual retry required'
        );
        this.settle();
        return;
      }
      reportOpenCodeStartupCleanupFailure(
        'OpenCode startup cleanup exceeded its deadline. An existing operation is still being observed; retry cleanup manually.'
      );
    }, this.budget.remainingMs());
    timer.unref?.();
    return timer;
  }

  private async scan(excludePids?: ReadonlySet<number>, tail = false): Promise<void> {
    if (this.stopped) return;
    if (this.budget.remainingMs() < 5_000) {
      this.scanPartial = true;
      this.coverage = 'partial';
      this.ports.logWarning(
        'OpenCode startup cleanup partial: budget exhausted; manual retry required'
      );
      return;
    }
    const result = await this.sweep({
      mode: tail && this.ports.ownershipMarkers ? 'force' : 'orphaned',
      platform: 'win32',
      startupBudget: this.budget,
      canAdmitStartupWork: () => !this.stopped,
      startedBeforeMs: tail
        ? (this.tailFenceMs ?? this.ports.appStartedAtMs)
        : this.ports.appStartedAtMs,
      ...(tail ? this.ports.ownershipMarkers : {}),
      requiredProfileScope: this.ports.profileScope,
      excludePids,
    });
    if (result.candidates.some((candidate) => candidate.action === 'failed')) {
      this.scanPartial = true;
      this.coverage = 'partial';
    }
    for (const diagnostic of result.diagnostics) this.ports.logWarning(diagnostic);
  }

  preflight(): Promise<void> {
    this.preflightWork = this.scan().catch((error: unknown) => {
      this.scanPartial = true;
      this.ports.logWarning(String(error));
    });
    this.pending = this.preflightWork;
    void this.preflightWork.then(() => {
      if (this.pending === this.preflightWork) this.pending = undefined;
    });
    // The app can finish initializing at the deadline while the gate continues
    // observing the same helper. This timeout never settles admission.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.budget.remainingMs());
      void this.preflightWork.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  finish(bridge: StartupCleanupBridge | null): Promise<void> {
    this.initialized = true;
    this.bridge = bridge;
    const operation = this.preflightWork.then(() => this.run());
    this.pending = operation;
    void operation.then(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    return operation;
  }

  /** Pending work is observation-only; terminal partial cleanup permits one explicit pass. */
  async retry(): Promise<void> {
    if (this.stopped) throw new Error('Startup cleanup is unavailable during shutdown');
    if (this.pending || !this.initialized) return;
    if (this.uncertain) {
      const observation = this.observeOriginalOperation();
      this.pending = observation;
      try {
        await observation;
      } finally {
        if (this.pending === observation) this.pending = undefined;
      }
      return;
    }
    this.scanPartial = false;
    this.coverage = 'partial';
    this.settle = beginOpenCodeStartupRuntimeSweep();
    this.budget = this.newBudget();
    this.timer = this.armDeadline();
    await this.finish(this.bridge);
  }

  private async observeOriginalOperation(): Promise<void> {
    const result = this.requestId
      ? await this.bridge?.observeOpenCodeStartupCleanup?.(this.requestId)
      : null;
    if (
      result &&
      result.requestId === this.requestId &&
      (result.ok
        ? isStartupCleanupData(result.data) && result.data.startupCleanup.completion === 'drained'
        : ['unsupported_command', 'unsupported_schema', 'invalid_input'].includes(
            result.error.kind
          ))
    ) {
      this.uncertain = false;
      // The normal tail did not run. Observation releases admission only; a
      // fresh cleanup pass requires a separate explicit action and budget.
      this.coverage = 'partial';
      this.settle();
      return;
    }
    throw new OpenCodeStartupCleanupBusyError(
      'OpenCode cleanup has an unconfirmed existing operation. No terminal evidence was found; no new cleanup or launch was queued.'
    );
  }

  private async run(): Promise<void> {
    try {
      if (this.stopped) return;
      if (!this.bridge || this.budget.remainingMs() < 5_000) {
        this.ports.logWarning(
          'OpenCode startup registry cleanup unavailable or budget exhausted; partial cleanup, manual retry required'
        );
        return;
      }
      // From dispatch until a validated terminal response, drainage is unproven.
      this.uncertain = true;
      this.requestId = `opencode-startup-cleanup-${randomUUID()}`;
      const result = await this.bridge.cleanupOpenCodeStartupHosts(
        this.budget,
        this.ports.appStartedAtMs,
        () => !this.stopped && this.budget.remainingMs() >= 5_000,
        this.requestId
      );
      this.requestId = result.requestId ?? this.requestId;
      if (!result.ok) {
        // These explicit protocol rejections occur before mutation. Never dispatch legacy cleanup.
        this.uncertain = !['unsupported_command', 'unsupported_schema', 'invalid_input'].includes(
          result.error.kind
        );
        this.ports.logWarning(
          `OpenCode startup cleanup failed: ${result.error.kind}: ${result.error.message}`
        );
        return;
      }
      if (!isStartupCleanupData(result.data)) {
        this.ports.logWarning('OpenCode startup cleanup returned invalid drainage evidence');
        return;
      }
      this.uncertain = result.data.startupCleanup.completion !== 'drained';
      this.coverage = this.scanPartial ? 'partial' : result.data.startupCleanup.coverage;
      if (result.data.startupCleanup.coverage === 'partial') {
        this.ports.logWarning(
          `OpenCode startup cleanup partial: ${result.data.remaining} registry hosts remain; manual retry required`
        );
      }
      for (const diagnostic of result.data.diagnostics) this.ports.logWarning(diagnostic);
      if (this.uncertain || this.stopped) return;
      this.tailFenceMs ??= Date.now();
      const exclusions = new Set([
        ...result.data.startupCleanup.survivingPids,
        ...result.data.hosts
          .filter((host) => !['disposed', 'removed_dead'].includes(host.action))
          .map((host) => host.pid),
      ]);
      await this.scan(exclusions);
      if (this.stopped) return;
      const wait = Math.min(8_000, this.budget.remainingMs());
      if (wait > 0)
        await (
          this.ports.waitMs ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        )(wait);
      if (this.stopped) return;
      await this.scan(exclusions, true);
    } catch (error) {
      this.coverage = 'partial';
      this.ports.logWarning(`OpenCode startup cleanup failed: ${String(error)}`);
    } finally {
      // Maintenance is independent of registry support, but cannot race an
      // unconfirmed destructive operation or begin after shutdown admission closes.
      if (!this.stopped && !this.uncertain && this.budget.remainingMs() >= 5_000) {
        await this.ports
          .maintenance?.(() => !this.stopped && this.budget.remainingMs() >= 5_000)
          .catch((error: unknown) => this.ports.logWarning(String(error)));
      }
      clearTimeout(this.timer);
      if (this.uncertain) {
        reportOpenCodeStartupCleanupFailure(
          'OpenCode startup cleanup completion is unconfirmed. Runtime evidence is required before another cleanup or launch; retry cannot recover lost evidence.'
        );
      } else {
        // Every local destructive helper was awaited; partial tree failure is terminal.
        this.settle();
      }
    }
  }
}
