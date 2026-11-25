import { randomUUID } from 'node:crypto';

import {
  captureLegacyStoppedSource,
  createRetainedLegacyLaunchScope,
  createRetainedLegacyOpenDiagnostic,
  createStoppedImportDiagnostic,
  importStoppedLegacyTeam,
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_NAMESPACE,
  RetainedLegacyLaunchCoordinator,
  RetainedLegacyLaunchRefusal,
  retainedLegacySourceOperationKey,
  validateRetainedLegacyLaunchRequest,
  validateStoppedImportAction,
} from '@features/agent-backend/main';
import {
  configureOriginalRuntimeLaunchAdmission,
  readOriginalRuntimeScope,
} from '@main/services/runtime/OriginalRuntimeScope';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { createLogger } from '@shared/utils/logger';

import type {
  RetainedLegacyLaunchResult,
  StoppedTeamImportResult,
} from '@features/agent-backend/contracts';
import type {
  CapturedLegacyStoppedSource,
  CapturedRetainedLegacyRuntime,
  DesktopBackendFeature,
  LegacyStoppedSourceOwners,
  RetainedLegacyOpenDiagnostic,
  RetainedLegacyOpenDiagnosticPhase,
  StoppedImportDiagnostic,
  StoppedImportDiagnosticPhase,
} from '@features/agent-backend/main';
import type { TeamProvisioningProgress } from '@shared/types';

interface ShellOwner {
  feature: DesktopBackendFeature;
  selected: boolean;
}
export type CaptureRetainedLegacyRuntime = (
  source: CapturedLegacyStoppedSource,
  isCurrent: () => boolean,
  onProgress?: (progress: TeamProvisioningProgress) => void,
  projectPath?: string
) => Promise<CapturedRetainedLegacyRuntime>;

/** One Main authority survives context aliases and owns publication versus original Launch. */
export function createDesktopStoppedTeamOperations(readShell: () => ShellOwner | undefined) {
  let owners:
    | {
        value: LegacyStoppedSourceOwners;
        isCurrent(contextId: string): boolean;
        captureRuntime?: CaptureRetainedLegacyRuntime;
      }
    | undefined;
  const importOutcomes = new Map<string, 'published' | 'unknown'>();
  const observeImportFailure = (observation: StoppedImportDiagnostic) => {
    createLogger('StoppedTeamImport').diagnostic('Stopped Team import refusal', observation);
  };
  const observeRetainedOpenFailure = (observation: RetainedLegacyOpenDiagnostic) => {
    createLogger(RETAINED_LEGACY_OPEN_DIAGNOSTIC_NAMESPACE).diagnostic(observation);
  };
  const captureDebts = new Map<
    string,
    { runtime: CapturedRetainedLegacyRuntime; teamName: string; intentId: string }[]
  >();
  const coordinator = new RetainedLegacyLaunchCoordinator({
    capture: async () => {
      throw new RetainedLegacyLaunchRefusal('unavailable');
    },
    createId: randomUUID,
    now: Date.now,
  });

  configureOriginalRuntimeLaunchAdmission(async (teamName, operation) => {
    const original = readOriginalRuntimeScope();
    if (original) {
      if (original.operation !== 'launch' || original.teamName !== teamName)
        throw new RetainedLegacyLaunchRefusal('not-eligible');
      const source = captureLegacyStoppedSource(teamName, 'local', () => true);
      if (retainedLegacySourceOperationKey(source) !== original.sourceKey)
        throw new RetainedLegacyLaunchRefusal('source-changed');
      original.admitLaunch(teamName);
      return operation(() => {
        original.assertCurrent();
      });
    }
    const shell = readShell();
    if (shell?.selected) throw new RetainedLegacyLaunchRefusal('not-eligible');
    // No Host configured: retain the original API while respecting any earlier uncertain reservation.
    let key: string, source: CapturedLegacyStoppedSource;
    try {
      source = captureLegacyStoppedSource(teamName, 'local', () => readShell() === shell);
      key = retainedLegacySourceOperationKey(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return operation(() => {
          if (readShell() !== shell || readShell()?.selected)
            throw new RetainedLegacyLaunchRefusal('not-eligible');
        });
      throw error;
    }
    if (importOutcomes.has(key)) throw new RetainedLegacyLaunchRefusal('import-not-absent');
    if (captureDebts.has(key)) throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    return coordinator.import(key, async () => {
      const assertCurrent = () => {
        if (readShell() !== shell || readShell()?.selected)
          throw new RetainedLegacyLaunchRefusal('not-eligible');
        if (!source.isCurrent() || retainedLegacySourceOperationKey(source) !== key)
          throw new RetainedLegacyLaunchRefusal('source-changed');
        if (importOutcomes.has(key)) throw new RetainedLegacyLaunchRefusal('import-not-absent');
        if (captureDebts.has(key)) throw new RetainedLegacyLaunchRefusal('outcome-unknown');
      };
      assertCurrent();
      return operation(assertCurrent);
    });
  });

  const capture = (original: ShellOwner, contextId: string, current: () => boolean) => {
    const captured = owners;
    if (!original.selected || !captured || !captured.isCurrent(contextId))
      throw new RetainedLegacyLaunchRefusal('unavailable');
    const isCurrent = () =>
      readShell() === original && owners === captured && current() && captured.isCurrent(contextId);
    if (!isCurrent()) throw new RetainedLegacyLaunchRefusal('source-changed');
    return { captured, isCurrent };
  };

  return {
    configure(
      value: Omit<LegacyStoppedSourceOwners, 'launch'>,
      isCurrent: (contextId: string) => boolean,
      captureRuntime?: CaptureRetainedLegacyRuntime
    ): void {
      owners = {
        value: { ...value, launch: new TeamLaunchStateStore() },
        isCurrent,
        captureRuntime,
      };
    },
    async import(
      original: ShellOwner,
      contextId: string,
      request: unknown,
      current: () => boolean
    ): Promise<StoppedTeamImportResult> {
      const observe = createStoppedImportDiagnostic('desktop', observeImportFailure);
      let phase: StoppedImportDiagnosticPhase = 'request';
      try {
        const input = validateStoppedImportAction(request);
        phase = 'source-owner';
        const { captured, isCurrent } = capture(original, contextId, current);
        let source: CapturedLegacyStoppedSource | undefined;
        phase = 'source-capture';
        try {
          source = captureLegacyStoppedSource(input.teamName, contextId, isCurrent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Receipt recovery after a deleted source cannot authorize an original Launch.
        const run = () =>
          importStoppedLegacyTeam({
            feature: original.feature,
            contextId,
            request: input,
            guard: { isCurrent },
            owners: captured.value,
            observeFailure: observeImportFailure,
            captureSource: () => {
              if (!source) throw Object.assign(new Error('Missing source'), { code: 'ENOENT' });
              return source;
            },
          });
        if (!source) return run();
        phase = 'source-key';
        const key = retainedLegacySourceOperationKey(source);
        phase = 'source-queue';
        return await coordinator.import(key, async () => {
          phase = 'queued-source';
          if (captureDebts.has(key)) throw new RetainedLegacyLaunchRefusal('outcome-unknown');
          if (!isCurrent() || !source.isCurrent())
            throw new RetainedLegacyLaunchRefusal('source-changed');
          phase = 'application';
          const result = await run();
          phase = 'publication-result';
          if (result.ok) importOutcomes.set(key, 'published');
          else if (result.outcome === 'unknown') importOutcomes.set(key, 'unknown');
          return result;
        });
      } catch (error) {
        observe(phase, error, 'not-dispatched');
        return { ok: false, reason: 'held', outcome: 'not-dispatched' };
      }
    },
    async retained(
      original: ShellOwner,
      contextId: string,
      value: unknown,
      current: () => boolean,
      onProgress?: (progress: TeamProvisioningProgress) => void
    ): Promise<RetainedLegacyLaunchResult> {
      let observe: ReturnType<typeof createRetainedLegacyOpenDiagnostic> | undefined;
      let phase: RetainedLegacyOpenDiagnosticPhase = 'source-owner';
      try {
        const request = validateRetainedLegacyLaunchRequest(value);
        if (request.action === 'open')
          observe = createRetainedLegacyOpenDiagnostic(
            request,
            process.pid,
            observeRetainedOpenFailure
          );
        // Authenticated cleanup can release an effect-free choice after its selected context changes.
        if (
          request.action === 'close' ||
          request.action === 'closeIntent' ||
          request.action === 'cancelModels'
        ) {
          const result = await coordinator.request(request);
          if (
            request.action === 'closeIntent' &&
            [...captureDebts.values()]
              .flat()
              .some(
                (debt) => debt.teamName === request.teamName && debt.intentId === request.intentId
              )
          )
            return { ok: false, reason: 'outcome-unknown', outcome: 'unknown' };
          return result;
        }
        const { captured, isCurrent } = capture(original, contextId, current);
        phase = 'source-capture';
        const selectedSource =
          request.action === 'open'
            ? captureLegacyStoppedSource(request.teamName, contextId, isCurrent)
            : undefined;
        phase = 'source-key';
        const selectedKey = selectedSource
          ? retainedLegacySourceOperationKey(selectedSource)
          : undefined;
        phase = 'coordinator';
        const result = await coordinator.request(
          request,
          async (teamName, projectPath) => {
            try {
              phase = 'source-capture';
              const source =
                selectedSource ?? captureLegacyStoppedSource(teamName, contextId, isCurrent);
              phase = 'source-key';
              const key = retainedLegacySourceOperationKey(source);
              if (importOutcomes.has(key))
                throw new RetainedLegacyLaunchRefusal('import-not-absent');
              if (captureDebts.has(key)) throw new RetainedLegacyLaunchRefusal('outcome-unknown');
              phase = 'target-capture';
              const target = await original.feature.captureStoppedImport(contextId, { isCurrent });
              if (!isCurrent() || !source.isCurrent())
                throw new RetainedLegacyLaunchRefusal('source-changed');
              phase = 'runtime-capture';
              if (!captured.captureRuntime) throw new RetainedLegacyLaunchRefusal('unavailable');
              const runtime = await captured.captureRuntime(
                source,
                () => isCurrent() && !captureDebts.has(key),
                onProgress,
                projectPath
              );
              phase = 'scope-construction';
              try {
                const authority = createRetainedLegacyLaunchScope({
                  source,
                  owners: captured.value,
                  target,
                  guard: { isCurrent },
                  runtime,
                  onEligibilityRefusal: (error) =>
                    observe?.remember('coordinator-admission', error),
                });
                phase = 'coordinator-admission';
                return authority;
              } catch (error) {
                observe?.remember(phase, error);
                try {
                  await runtime.close();
                } catch {
                  const debt = captureDebts.get(key) ?? [];
                  debt.push({
                    runtime,
                    teamName,
                    intentId:
                      request.action === 'open' || request.action === 'rebind'
                        ? request.intentId
                        : '',
                  });
                  captureDebts.set(key, debt);
                  throw new RetainedLegacyLaunchRefusal('outcome-unknown');
                }
                throw error;
              }
            } catch (error) {
              observe?.remember(phase, error);
              throw error;
            }
          },
          selectedKey
        );
        observe?.finish(phase, result);
        return result;
      } catch (error) {
        observe?.remember(phase, error);
        const reason =
          error instanceof TypeError
            ? 'invalid'
            : error instanceof RetainedLegacyLaunchRefusal
              ? error.reason
              : 'unavailable';
        const result: RetainedLegacyLaunchResult = {
          ok: false,
          reason,
          outcome: reason === 'outcome-unknown' ? 'unknown' : 'not-dispatched',
        };
        observe?.finish(phase, result);
        return result;
      }
    },
    shutdown: async () => {
      await coordinator.shutdown();
      await Promise.allSettled(
        [...captureDebts.values()].flat().map((debt) => debt.runtime.close())
      );
      captureDebts.clear();
    },
    clearOwners: () => {
      owners = undefined;
    },
  };
}
