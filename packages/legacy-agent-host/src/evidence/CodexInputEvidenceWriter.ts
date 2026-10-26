import {
  selectCodexFailedTool,
  retainFailedToolObservations,
  hasNativeCommand,
} from './NativeFailedToolObservation.js';
import { lstatSync, realpathSync } from 'node:fs';
import { digest } from '../team/identity.js';
import { bindRuntimeInputEvidence } from './bindRuntimeInputEvidence.js';
import { snapshotWorkspace } from './WorkspaceSnapshot.js';
import { TaskEvidenceJournal } from './TaskEvidenceJournal.js';
import { NATIVE_INTERVAL_WARNING } from './captureContracts.js';
import { snapshotWarningCodes } from './snapshotWarningCodes.js';
import { qualifyCodexFileChange } from './qualifyCodexFileChange.js';
import type { RuntimeInputEvidenceBinding } from './bindRuntimeInputEvidence.js';
import type { TaskToolEvidenceBinding } from './bindTaskToolEvidence.js';
import type {
  CodexAfterRequest,
  CodexCaptureRequest,
  CodexEvidenceCapture,
  CodexEvidenceCaptureOptions,
  CodexEvidenceWindow,
} from './codexCaptureContracts.js';
const sameBinding = (binding: RuntimeInputEvidenceBinding) =>
  digest({ ...binding, provenance: undefined });
/** Optional per-input observations only. Native execution and its outcome stay owned by D. */
export function createCodexInputEvidenceCapture(
  options: CodexEvidenceCaptureOptions
): CodexEvidenceCapture {
  const journal = new TaskEvidenceJournal(options.ledgerProjectDir);
  const active = new Map<string, CodexEvidenceWindow>(),
    seen = new Set<string>();
  let sealed = false;
  let state: ReturnType<CodexEvidenceCapture['readStatus']> = {
    phase: 'idle',
    baseline: 'pending',
  };
  const keyOf = (request: CodexCaptureRequest) =>
    digest({
      sessionRef: request.sessionRef,
      inputId: request.inputId,
      operationRef: request.operationRef,
      windowRef: request.windowRef,
      host: options.captured.hostIncarnation,
    });
  const attribution = (request: CodexCaptureRequest) =>
    bindRuntimeInputEvidence({
      ...options,
      request: { ...request, phase: request.phase === 'gap' ? 'after' : request.phase },
    });
  const guard = (
    request: CodexCaptureRequest,
    key: string,
    window: CodexEvidenceWindow,
    allowGap = false
  ) => {
    if (
      sealed ||
      request.signal.aborted ||
      active.get(key) !== window ||
      (!allowGap && (window.invalidReason || window.request.signal.aborted))
    )
      throw new Error('closed-window');
    options.assertCurrent();
    const workspace = options.captured.workspace,
      info = lstatSync(workspace.path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(workspace.path) !== workspace.path ||
      digest({ dev: info.dev, ino: info.ino }) !== workspace.identity
    )
      throw new Error('workspace-changed');
    if (
      request.sessionRef !== window.request.sessionRef ||
      request.inputId !== window.request.inputId ||
      request.operationRef !== window.request.operationRef ||
      request.windowRef !== window.request.windowRef ||
      request.threadId !== window.request.threadId
    )
      throw new Error('window-mismatch');
    const current = attribution(request);
    if (current.kind !== 'bound' || sameBinding(current.binding) !== sameBinding(window.binding))
      throw new Error('causal-binding-changed');
    return current.binding;
  };
  const release = (key: string, window: CodexEvidenceWindow) => {
    if (active.get(key) === window) active.delete(key);
    options.windows.remove(key, window);
  };
  const gap = (
    request: CodexCaptureRequest,
    key: string,
    window: CodexEvidenceWindow,
    reason: string,
    snapshotWarnings: readonly string[] = window.before?.warnings ?? []
  ) => {
    const warningCodes = snapshotWarningCodes(snapshotWarnings);
    window.invalidReason = reason;
    state = { phase: 'gap', baseline: window.before?.complete ? 'ready' : 'missed', reason };
    try {
      options.withWriteFence(() => {
        guard(request, key, window, true);
        journal.notice(
          window.binding,
          `codex-gap:${request.windowRef}`,
          `Codex input capture gap: ${reason}.${warningCodes.length ? ` Snapshot warning codes: ${warningCodes.join(', ')}.` : ''}`,
          () => {
            guard(request, key, window, true);
          },
          {
            capturePhase: 'input-gap',
            ...(warningCodes.length ? { captureWarningCodes: warningCodes } : {}),
            captureWindowRef: request.windowRef,
            nativeThreadId: window.request.threadId,
          }
        );
      });
    } finally {
      release(key, window);
    }
  };
  const settle = async (request: CodexAfterRequest, key: string, window: CodexEvidenceWindow) => {
    guard(request, key, window);
    if (
      !window.before ||
      !request.beforeObserved ||
      request.gapReason ||
      request.outcome !== 'completed'
    ) {
      gap(request, key, window, request.gapReason ?? 'unqualified-input-outcome');
      return;
    }
    const nativeFailure = selectCodexFailedTool(request, options.captured.workspace.path);
    if (nativeFailure.kind === 'gap') {
      gap(request, key, window, nativeFailure.reason);
      return;
    }
    const final = await snapshotWorkspace({
      workspace: options.captured.workspace,
      toolName: 'codex.fileChange',
      input: null,
      prior: window.before,
      guard: () => {
        guard(request, key, window);
      },
    });
    const rebound = guard(request, key, window);
    if (!window.before.complete || !final.complete || rebound.provenance.outcome !== 'handed-off') {
      gap(request, key, window, 'incomplete-or-unknown-input', [
        ...window.before.warnings,
        ...final.warnings,
      ]);
      return;
    }
    if (nativeFailure.kind === 'failed') {
      options.withWriteFence(() => {
        guard(request, key, window);
        retainFailedToolObservations({
          selected: nativeFailure,
          binding: rebound,
          before: window.before!,
          after: final,
          warnings: [...window.warnings],
          journal,
          guard: () => {
            guard(request, key, window);
          },
        });
      });
      state = { phase: 'gap', baseline: 'ready', reason: 'observed-native-tool-failure-partial' };
      release(key, window);
      return;
    }
    const qualified = qualifyCodexFileChange(
      { ...request, items: request.items.filter((item) => !hasNativeCommand(item)) },
      options.captured.workspace.path,
      window.before,
      final
    );
    if (qualified.kind === 'gap') {
      gap(request, key, window, qualified.reason);
      return;
    }
    options.withWriteFence(() => {
      guard(request, key, window);
      const binding: TaskToolEvidenceBinding = Object.freeze({
        ...rebound,
        toolUseId: qualified.lastItemId,
        toolName: 'codex.fileChange',
        native: Object.freeze({
          provider: 'codex',
          threadId: request.threadId,
          turnId: request.turnId,
          windowRef: request.windowRef,
          itemIds: qualified.proof.itemIds,
        }),
      });
      journal.event(
        binding,
        qualified.file,
        window.before!.files.get(qualified.file)!,
        final.files.get(qualified.file)!,
        'succeeded',
        [...window.warnings],
        () => {
          guard(request, key, window);
        },
        qualified.proof
      );
      journal.notice(
        window.binding,
        `codex-after:${request.windowRef}`,
        NATIVE_INTERVAL_WARNING,
        () => {
          guard(request, key, window);
        },
        {
          capturePhase: 'input-after',
          captureWindowRef: request.windowRef,
          nativeThreadId: request.threadId,
          nativeTurnId: request.turnId,
        }
      );
    });
    state = { phase: 'gap', baseline: 'ready', reason: 'selected-update-only-partial-coverage' };
    release(key, window);
  };
  return {
    async observe(request) {
      const key = keyOf(request);
      let window = active.get(key);
      try {
        if (sealed) return;
        if (request.signal.aborted) {
          state = {
            phase: 'gap',
            baseline: window?.before?.complete ? 'ready' : 'missed',
            reason: 'aborted',
          };
          if (window) {
            window.invalidReason = 'aborted';
            release(key, window);
          }
          return;
        }
        options.assertCurrent();
        if (request.phase === 'gap') {
          state = {
            phase: 'gap',
            baseline: window?.before?.complete ? 'ready' : 'missed',
            reason: request.reason,
          };
          if (window) gap(request, key, window, request.reason);
          return;
        }
        if (request.phase === 'before') {
          if (window || seen.has(key)) {
            if (window) gap(request, key, window, 'duplicate-window');
            else state = { phase: 'gap', baseline: 'missed', reason: 'duplicate-window' };
            return;
          }
          if (seen.size >= 1000) {
            state = { phase: 'gap', baseline: 'missed', reason: 'capture-limit' };
            return;
          }
          const bound = attribution(request);
          if (bound.kind !== 'bound') {
            state = { phase: 'gap', baseline: 'missed', reason: bound.reason };
            return;
          }
          seen.add(key);
          window = {
            binding: bound.binding,
            request,
            warnings: new Set([
              NATIVE_INTERVAL_WARNING,
              'Execution sequence is unqualified; zero denotes unknown.',
              'Only one bounded existing text update path is qualified; selected workspace coverage remains partial.',
            ]),
          };
          if (!options.windows.add(key, window)) {
            state = { phase: 'gap', baseline: 'missed', reason: 'capture-limit' };
            return;
          }
          active.set(key, window);
          if (window.invalidReason) {
            gap(request, key, window, window.invalidReason);
            return;
          }
          state = { phase: 'capturing', baseline: 'pending' };
          const before = await snapshotWorkspace({
            workspace: options.captured.workspace,
            toolName: 'codex.fileChange',
            input: null,
            guard: () => {
              guard(request, key, window!);
            },
          });
          guard(request, key, window);
          window.before = before;
          if (!before.complete) {
            gap(request, key, window, 'incomplete-workspace-census');
            return;
          }
          options.withWriteFence(() => {
            guard(request, key, window!);
            const preimages = [...before.files].map(([path, image]) => ({
              path,
              ...journal.image(image, () => {
                guard(request, key, window!);
              }),
            }));
            journal.notice(
              window!.binding,
              `codex-before:${request.windowRef}`,
              'Codex original input baseline captured before turn/start; interval coverage remains partial.',
              () => {
                guard(request, key, window!);
              },
              {
                capturePhase: 'input-before',
                captureWindowRef: request.windowRef,
                nativeThreadId: request.threadId,
                preimages,
              }
            );
          });
          state = { phase: 'capturing', baseline: 'ready' };
          return;
        }
        if (!window) {
          if (!seen.has(key))
            state = { phase: 'gap', baseline: 'missed', reason: 'window-mismatch' };
          return;
        }
        guard(request, key, window);
        const fingerprint = digest({
          threadId: request.threadId,
          turnId: request.turnId,
          beforeObserved: request.beforeObserved,
          gapReason: request.gapReason,
          outcome: request.outcome,
          items: request.items,
        });
        if (window.terminalFingerprint && window.terminalFingerprint !== fingerprint) {
          gap(request, key, window, 'terminal-mismatch');
          return;
        }
        window.terminalFingerprint = fingerprint;
        if (!window.settlement) window.settlement = settle(request, key, window);
        await window.settlement;
      } catch {
        state = {
          phase: sealed ? 'sealed' : 'gap',
          baseline: window?.before?.complete ? 'ready' : 'missed',
          reason: window?.invalidReason ?? 'capture-unavailable',
        };
        if (window && active.get(key) === window) {
          try {
            gap(request, key, window, state.reason!);
          } catch {
            release(key, window);
          }
        }
      }
    },
    seal() {
      sealed = true;
      state = { phase: 'sealed', baseline: 'missed' };
      for (const [key, window] of active) release(key, window);
    },
    readStatus: () => Object.freeze({ ...state }),
  };
}
