import type {
  TeamArtifactReconciliationPorts,
  TeamArtifactReconciliationResult,
  TeamArtifactReconciliationTrigger,
} from './ports/TeamArtifactReconciliationPorts';

const BURST_WINDOW_MS = 5_000;
const PRESSURE_LOG_INTERVAL_MS = 2_000;
const BURST_PRESSURE_THRESHOLD = 8;
const SLOW_RECONCILIATION_MS = 100;
const IDLE_DIAGNOSTICS_RETENTION_MS = 30_000;

interface ReconciliationDiagnostics {
  inFlight: number;
  burstCount: number;
  windowStartedAt: number;
  lastPressureLogAt: number;
}

export class TeamArtifactReconciliationCoordinator {
  private readonly diagnosticsByTeam = new Map<string, ReconciliationDiagnostics>();

  constructor(private readonly ports: TeamArtifactReconciliationPorts) {}

  async reconcile(teamName: string, trigger?: TeamArtifactReconciliationTrigger): Promise<void> {
    const now = this.ports.clock.nowMs();
    const diagnostics = this.diagnosticsByTeam.get(teamName) ?? {
      inFlight: 0,
      burstCount: 0,
      windowStartedAt: now,
      lastPressureLogAt: 0,
    };
    const triggerSource = trigger?.source ?? 'unknown';
    const triggerDetail =
      typeof trigger?.detail === 'string' && trigger.detail.trim().length > 0
        ? ` detail=${trigger.detail.trim()}`
        : '';
    if (now - diagnostics.windowStartedAt > BURST_WINDOW_MS) {
      diagnostics.windowStartedAt = now;
      diagnostics.burstCount = 0;
    }
    diagnostics.burstCount += 1;
    diagnostics.inFlight += 1;
    this.diagnosticsByTeam.set(teamName, diagnostics);

    const concurrentAtStart = diagnostics.inFlight;
    const shouldLogPressure =
      concurrentAtStart > 1 ||
      diagnostics.burstCount >= BURST_PRESSURE_THRESHOLD ||
      diagnostics.burstCount === 1;
    if (shouldLogPressure && now - diagnostics.lastPressureLogAt >= PRESSURE_LOG_INTERVAL_MS) {
      diagnostics.lastPressureLogAt = now;
      this.ports.logger.warn(
        `[reconcileTeamArtifacts] team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} inFlight=${concurrentAtStart} burst=${diagnostics.burstCount}`
      );
    }

    const startedAt = this.ports.clock.nowMs();
    try {
      const rawResult = this.ports.maintenance.reconcileArtifacts(teamName, {
        reason: 'file-watch',
      });
      const result = (rawResult ?? {}) as TeamArtifactReconciliationResult;
      const durationMs = this.ports.clock.nowMs() - startedAt;
      if (
        durationMs >= SLOW_RECONCILIATION_MS ||
        concurrentAtStart > 1 ||
        diagnostics.burstCount >= BURST_PRESSURE_THRESHOLD ||
        (result.linkedCommentsCreated ?? 0) > 0 ||
        (result.staleKanbanEntriesRemoved ?? 0) > 0 ||
        (result.staleColumnOrderRefsRemoved ?? 0) > 0
      ) {
        this.ports.logger.warn(
          `[reconcileTeamArtifacts] completed team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} durationMs=${durationMs} inFlightAtStart=${concurrentAtStart} burst=${diagnostics.burstCount} linkedCommentsCreated=${result.linkedCommentsCreated ?? 0} staleKanbanEntriesRemoved=${result.staleKanbanEntriesRemoved ?? 0} staleColumnOrderRefsRemoved=${result.staleColumnOrderRefsRemoved ?? 0}`
        );
      }
    } finally {
      const current = this.diagnosticsByTeam.get(teamName);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        if (
          current.inFlight === 0 &&
          this.ports.clock.nowMs() - current.windowStartedAt > IDLE_DIAGNOSTICS_RETENTION_MS
        ) {
          this.diagnosticsByTeam.delete(teamName);
        }
      }
    }
  }
}
