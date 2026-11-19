import { createHash } from 'node:crypto';

import { RetainedLegacyLaunchRefusal } from '../../core/application/RetainedLegacyLaunchCoordinator';
import { retainedLegacySourceOperationKey } from '../infrastructure/RetainedLegacyRuntimeScope';
import {
  createLegacyStoppedTeamSource,
  LegacyStoppedImportHold,
} from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';

import type {
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchValueMap,
} from '../../contracts/retainedLegacyLaunch';
import type { RetainedLegacyLaunchAuthority } from '../../core/application/RetainedLegacyLaunchCoordinator';
import type { DesktopBackendFeature } from '../composition/DesktopBackendFeature';
import type {
  CapturedLegacyStoppedSource,
  LegacyStoppedSourceOwners,
} from '../infrastructure/stopped-import/createLegacyStoppedTeamSource';
import type { BackendRequestGuard } from './backendBinding';

type RuntimeAction = Exclude<
  RetainedLegacyLaunchRequest['action'],
  'open' | 'close' | 'closeIntent' | 'rebind' | 'cancelModels'
>;
export interface CapturedRetainedLegacyRuntime {
  projectPath: string;
  /** Checks the original profile, executable selection and private account/configuration identity. */
  assertCurrent(): void;
  run<K extends RuntimeAction>(
    request: Extract<RetainedLegacyLaunchRequest, { action: K }>
  ): Promise<RetainedLegacyLaunchValueMap[K]>;
  close(): Promise<void>;
  cancelModels(
    input: Extract<RetainedLegacyLaunchRequest, { action: 'cancelModels' }>['input']
  ): Promise<RetainedLegacyLaunchValueMap['cancelModels']>;
}

export function stoppedLegacyImportCommandId(
  source: Pick<CapturedLegacyStoppedSource, 'sourceOwnerId' | 'sourceId'> | undefined,
  contextId: string,
  teamName: string
): string {
  return `stopped-import-${createHash('sha256')
    .update(JSON.stringify([source?.sourceOwnerId, source?.sourceId, contextId, teamName]))
    .digest('hex')}`;
}

/** Read original import receipts and the unchanged stopped-source refusal; never publish release evidence. */
export function createRetainedLegacyLaunchScope(options: {
  source: CapturedLegacyStoppedSource;
  owners: LegacyStoppedSourceOwners;
  target: Awaited<ReturnType<DesktopBackendFeature['captureStoppedImport']>>;
  guard: BackendRequestGuard;
  runtime: CapturedRetainedLegacyRuntime;
  /** Private observation only; it cannot decide eligibility or delay original cleanup. */
  onEligibilityRefusal?: (error: unknown) => unknown;
}): RetainedLegacyLaunchAuthority {
  const { source, owners, target, guard, runtime } = options;
  const commandId = stoppedLegacyImportCommandId(source, source.contextId, source.teamName);
  const assertSourceCurrent = () => {
    if (!guard.isCurrent() || !source.isCurrent())
      throw new RetainedLegacyLaunchRefusal('source-changed');
    target.authority.assertCurrent();
  };
  const current = () => {
    assertSourceCurrent();
    runtime.assertCurrent();
  };
  return {
    sourceKey: retainedLegacySourceOperationKey(source),
    teamName: source.teamName,
    projectPath: runtime.projectPath,
    assertSourceCurrent,
    assertRuntimeCurrent: () => runtime.assertCurrent(),
    async readImportAbsence() {
      current();
      try {
        const entries = await target.client.list(commandId, source.contextId, guard);
        current();
        // Held is already a durable import; it cannot become an original-runtime choice.
        if (entries.some((entry) => entry.record.teamName === source.teamName)) return 'present';
        const receipt = await target.client.lookup(commandId, source.contextId, guard);
        current();
        return receipt === null ? 'absent' : 'present';
      } catch (error) {
        current();
        if (error instanceof RetainedLegacyLaunchRefusal) throw error;
        return 'unknown';
      }
    },
    async readEligibility() {
      current();
      const original = createLegacyStoppedTeamSource(source, owners);
      try {
        await original.fenced(() => original.describe());
        current();
        return 'stopped';
      } catch (error) {
        current();
        if (
          error instanceof LegacyStoppedImportHold &&
          error.reason === 'native-custody-unverified'
        )
          return 'native-custody-unverified';
        try {
          void Promise.resolve(options.onEligibilityRefusal?.(error)).catch(() => {
            // A rejected observer cannot replace the original eligibility refusal.
          });
        } catch {
          // A broken observer cannot change admission, currentness or cleanup.
        }
        return 'other';
      }
    },
    async run(request) {
      current();
      const value = await runtime.run(request);
      current();
      return value;
    },
    close: () => runtime.close(),
    cancelModels: (request) => runtime.cancelModels(request.input),
  };
}
