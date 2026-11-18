import { hostTeamSelectionKey } from '../../contracts';
import { LegacyStoppedImportHold } from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { createStoppedImportDiagnostic } from '../infrastructure/stopped-import/createStoppedImportDiagnostic';
import { prepareStoppedLegacyImport } from '../infrastructure/stopped-import/prepareStoppedLegacyImport';

import { assertBackendRequestGuard } from './backendBinding';
import { stoppedLegacyImportCommandId } from './createRetainedLegacyLaunchScope';

import type {
  StoppedTeamImportAction,
  StoppedTeamImportResult,
} from '../../contracts/stoppedImport';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';
import type {
  CapturedLegacyStoppedSource,
  LegacyStoppedSourceOwners,
} from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';
import type {
  StoppedImportDiagnosticPhase,
  StoppedImportDiagnosticSink,
} from '../infrastructure/stopped-import/createStoppedImportDiagnostic';
import type { BackendRequestGuard } from './backendBinding';

export function validateStoppedImportAction(value: unknown): StoppedTeamImportAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['teamName', 'action'].includes(key)) ||
    typeof input.teamName !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.teamName) ||
    !['prepare', 'lookup', 'retry'].includes(input.action as string)
  )
    throw new TypeError('invalid');
  return { teamName: input.teamName, action: input.action as StoppedTeamImportAction['action'] };
}
/** Original detached publication only. No source mutation, native adoption or Launch effect. */
export async function importStoppedLegacyTeam(options: {
  feature: DesktopBackendFeature;
  contextId: string;
  request: unknown;
  guard: BackendRequestGuard;
  captureSource(teamName: string): CapturedLegacyStoppedSource;
  owners: LegacyStoppedSourceOwners;
  observeFailure?: StoppedImportDiagnosticSink;
}): Promise<StoppedTeamImportResult> {
  let effect = false;
  const observe = createStoppedImportDiagnostic('application', (observation) =>
    options.observeFailure?.(observation)
  );
  let phase: StoppedImportDiagnosticPhase = 'request';
  try {
    const input = validateStoppedImportAction(options.request);
    let source: CapturedLegacyStoppedSource | undefined;
    phase = 'source-capture';
    try {
      source = options.captureSource(input.teamName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Stable identity excludes mutable file content. Lost ACK/reopen always recovers this same command.
    phase = 'command';
    const commandId = stoppedLegacyImportCommandId(source, options.contextId, input.teamName);
    const guard = options.guard;
    phase = 'guard';
    assertBackendRequestGuard(guard);
    phase = 'host-capture';
    const target = await options.feature.captureStoppedImport(options.contextId, guard);
    phase = 'receipts';
    const entries = await target.client.list(commandId, options.contextId, guard);
    const same = entries.filter((entry) => entry.record.teamName === input.teamName);
    if (
      same.length > 1 ||
      (source && same.some((entry) => entry.source.sourceId !== source.sourceId))
    ) {
      observe(phase, undefined, 'not-dispatched', 'receipt-conflict');
      return { ok: false, reason: 'held', outcome: 'not-dispatched' };
    }
    phase = 'lookup';
    let receipt: Awaited<ReturnType<typeof target.client.lookup>> =
      same[0] ?? (await target.client.lookup(commandId, options.contextId, guard));
    phase = 'receipt-source';
    if (receipt && source && receipt.source.sourceId !== source.sourceId) {
      observe(phase, undefined, 'not-dispatched', 'receipt-conflict');
      return { ok: false, reason: 'held', outcome: 'not-dispatched' };
    }
    if (receipt?.phase === 'held' && input.action === 'retry') {
      phase = 'retry';
      effect = true;
      receipt = await target.client.retry(
        receipt.commandId,
        {
          contextId: options.contextId,
          sourceId: receipt.source.sourceId,
          snapshotDigest: receipt.source.snapshotDigest,
          teamName: receipt.record.teamName,
        },
        guard
      );
    } else if (!receipt && input.action === 'prepare') {
      phase = 'prepare';
      if (!source) throw new LegacyStoppedImportHold('source-unreadable');
      const live = { isCurrent: () => guard.isCurrent() && source.isCurrent() };
      const request = await prepareStoppedLegacyImport({
        source,
        owners: options.owners,
        target: target.authority,
        destinationTeamName: input.teamName,
      });
      phase = 'publish-guard';
      assertBackendRequestGuard(live);
      effect = true;
      try {
        phase = 'publish';
        receipt = await target.client.publish(commandId, request, live);
      } catch {
        phase = 'reconcile';
        receipt = await target.client.lookup(commandId, options.contextId, guard);
      }
    }
    phase = 'receipt';
    if (receipt?.phase !== 'published') {
      observe(
        phase,
        undefined,
        effect ? 'unknown' : 'not-dispatched',
        receipt ? 'receipt-held' : 'receipt-absent'
      );
      return {
        ok: false,
        reason: receipt ? 'held' : 'unknown',
        outcome: effect ? 'unknown' : 'not-dispatched',
      };
    }
    phase = 'published-source';
    if (source && !source.isCurrent()) throw new LegacyStoppedImportHold('source-changed');
    phase = 'register';
    await target.registerPublished(receipt.record);
    phase = 'final-guard';
    assertBackendRequestGuard(guard, 'unknown');
    return { ok: true, selection: hostTeamSelectionKey(receipt.record.binding.handleId) };
  } catch (error) {
    observe(phase, error, effect ? 'unknown' : 'not-dispatched');
    return {
      ok: false,
      reason:
        error instanceof LegacyStoppedImportHold
          ? error.reason
          : error instanceof TypeError
            ? 'invalid'
            : effect
              ? 'unknown'
              : 'held',
      outcome: effect ? 'unknown' : 'not-dispatched',
    };
  }
}
