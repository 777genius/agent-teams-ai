import { createHash } from 'node:crypto';

import { hostTeamSelectionKey } from '../../contracts';
import { LegacyStoppedImportHold } from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { prepareStoppedLegacyImport } from '../infrastructure/stopped-import/prepareStoppedLegacyImport';

import { assertBackendRequestGuard } from './backendBinding';

import type {
  StoppedTeamImportAction,
  StoppedTeamImportResult,
} from '../../contracts/stoppedImport';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';
import type {
  CapturedLegacyStoppedSource,
  LegacyStoppedSourceOwners,
} from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';
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
}): Promise<StoppedTeamImportResult> {
  let effect = false;
  try {
    const input = validateStoppedImportAction(options.request);
    let source: CapturedLegacyStoppedSource | undefined;
    try {
      source = options.captureSource(input.teamName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Stable identity excludes mutable file content. Lost ACK/reopen always recovers this same command.
    const commandId = `stopped-import-${createHash('sha256')
      .update(
        JSON.stringify([source?.sourceOwnerId, source?.sourceId, options.contextId, input.teamName])
      )
      .digest('hex')}`;
    const guard = options.guard;
    assertBackendRequestGuard(guard);
    const target = await options.feature.captureStoppedImport(options.contextId, guard);
    const entries = await target.client.list(commandId, options.contextId, guard);
    const same = entries.filter((entry) => entry.record.teamName === input.teamName);
    if (
      same.length > 1 ||
      (source && same.some((entry) => entry.source.sourceId !== source.sourceId))
    )
      return { ok: false, reason: 'held', outcome: 'not-dispatched' };
    let receipt: Awaited<ReturnType<typeof target.client.lookup>> =
      same[0] ?? (await target.client.lookup(commandId, options.contextId, guard));
    if (receipt && source && receipt.source.sourceId !== source.sourceId)
      return { ok: false, reason: 'held', outcome: 'not-dispatched' };
    if (receipt?.phase === 'held' && input.action === 'retry') {
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
      if (!source) throw new LegacyStoppedImportHold('source-unreadable');
      const live = { isCurrent: () => guard.isCurrent() && source.isCurrent() };
      const request = await prepareStoppedLegacyImport({
        source,
        owners: options.owners,
        target: target.authority,
        destinationTeamName: input.teamName,
      });
      assertBackendRequestGuard(live);
      effect = true;
      try {
        receipt = await target.client.publish(commandId, request, live);
      } catch {
        receipt = await target.client.lookup(commandId, options.contextId, guard);
      }
    }
    if (receipt?.phase !== 'published')
      return {
        ok: false,
        reason: receipt ? 'held' : 'unknown',
        outcome: effect ? 'unknown' : 'not-dispatched',
      };
    if (source && !source.isCurrent()) throw new LegacyStoppedImportHold('source-changed');
    await target.registerPublished(receipt.record);
    assertBackendRequestGuard(guard, 'unknown');
    return { ok: true, selection: hostTeamSelectionKey(receipt.record.binding.handleId) };
  } catch (error) {
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
