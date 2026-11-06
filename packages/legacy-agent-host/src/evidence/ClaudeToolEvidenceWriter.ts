import { lstatSync, realpathSync } from 'node:fs';
import { bindTaskToolEvidence } from './bindTaskToolEvidence.js';
import { digest } from '../team/identity.js';
import { snapshotWorkspace } from './WorkspaceSnapshot.js';
import { TaskEvidenceJournal } from './TaskEvidenceJournal.js';
import { NATIVE_INTERVAL_WARNING } from './captureContracts.js';
import type { ClaudeCaptureRequest, ClaudeCaptureValue } from '@agent-teams/provider-implementations/claude';
import type { EvidenceCaptureOptions, EvidenceWindow, ToolEvidenceCapture } from './captureContracts.js';
import type { TaskToolEvidenceBinding } from './bindTaskToolEvidence.js';

import { qualifyNativeFileEffect } from './qualifyNativeFileEffect.js';

const identity = (binding: TaskToolEvidenceBinding) => digest({ ...binding, provenance: undefined });
// Native batch serialization may reorder object keys; arrays and every value remain significant.
function canonical(value: ClaudeCaptureValue): ClaudeCaptureValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const fingerprint = (toolName: string, toolInput: ClaudeCaptureValue) => digest({ toolName, input: canonical(toolInput) });

/** Best-effort awaited observations only. It never decides whether a native tool may run. */
export function createClaudeToolEvidenceCapture(options: EvidenceCaptureOptions): ToolEvidenceCapture {
  const journal = new TaskEvidenceJournal(options.ledgerProjectDir);
  const active = new Map<string, EvidenceWindow>();
  const seen = new Set<string>();
  let sealed = false;
  let state: ReturnType<ToolEvidenceCapture['readStatus']> = { phase: 'idle' };
  const keyOf = (request: Pick<ClaudeCaptureRequest, 'sessionRef' | 'inputId' | 'operationRef' | 'toolUseId'>) => digest({
    sessionRef: request.sessionRef, inputId: request.inputId, operationRef: request.operationRef,
    toolUseId: request.toolUseId, host: options.captured.hostIncarnation,
  });
  const guard = (request: ClaudeCaptureRequest): void => {
    if (sealed || request.signal.aborted) throw new Error('closed-or-aborted');
    options.assertCurrent();
    const workspace = options.captured.workspace;
    const info = lstatSync(workspace.path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(workspace.path) !== workspace.path ||
      digest({ dev: info.dev, ino: info.ino }) !== workspace.identity) throw new Error('workspace-changed');
  };
  const release = (key: string, window: EvidenceWindow): void => {
    if (active.get(key) === window) active.delete(key);
    options.windows.remove(key, window);
  };
  const boundGuard = (request: ClaudeCaptureRequest, key: string, window: EvidenceWindow, allowGap = false): void => {
    guard(request);
    if (active.get(key) !== window || (!allowGap && ((window.background?.signal ?? window.request.signal).aborted || window.invalidReason)))
      throw new Error('closed-window');
    const rebound = bindTaskToolEvidence({ ...options, request });
    if (rebound.kind !== 'bound' || identity(rebound.binding) !== identity(window.binding))
      throw new Error('causal-binding-changed');
  };
  const gap = (key: string, window: EvidenceWindow, reason: string, signal: AbortSignal): void => {
    window.invalidReason = reason;
    state = { phase: 'gap', reason };
    // A D gap has its own signal: the provisional original signal may already be aborted.
    const request = { ...window.request, signal };
    try {
      options.withWriteFence(() => {
        boundGuard(request, key, window, true);
        journal.notice(window.binding, 'native-gap', `Native capture gap: ${reason}.`,
          () => boundGuard(request, key, window, true));
      });
    } finally { release(key, window); }
  };
  const settle = async (batch: Readonly<{ boundary: 'post-tool-use-hooks' | 'native-task-notification'; signal: AbortSignal }>, key: string, window: EvidenceWindow): Promise<void> => {
    const request = { ...window.request, phase: 'after' as const, outcome: window.outcome!, signal: batch.signal };
    try {
      boundGuard(request, key, window);
      const final = await snapshotWorkspace({ workspace: options.captured.workspace,
        toolName: window.request.toolName, input: window.request.toolInput, prior: window.before!,
        guard: () => boundGuard(request, key, window) });
      boundGuard(request, key, window);
      for (const warning of final.warnings) window.warnings.add(warning);
      const captured = (snapshot: NonNullable<EvidenceWindow['before']>) => snapshot.complete ||
        (!!window.background && snapshot.warnings.length > 0 && snapshot.warnings.every(warning => warning === 'background-tool'));
      if (!captured(window.before!) || !captured(final)) {
        gap(key, window, 'incomplete-workspace-census', batch.signal);
        return;
      }
      options.withWriteFence(() => {
        boundGuard(request, key, window);
        const paths = new Set([...window.before!.files.keys(), ...final.files.keys()]);
        for (const path of paths) {
          // Git omission cannot prove absence: ignored or otherwise undiscovered preimages stay unknown.
          const before = window.before!.files.get(path) ?? { reason: 'Preimage was not captured before the effect.' };
          const after = final.files.get(path) ?? { reason: 'Final content was not captured.' };
          if ((before.exists === false && after.exists === false) || (before.sha256 && before.sha256 === after.sha256)) continue;
          const proof = !window.background && window.outcome === 'succeeded' && window.binding.provenance.outcome === 'handed-off'
            ? qualifyNativeFileEffect({ toolName: window.request.toolName, toolInput: window.request.toolInput,
                workspace: options.captured.workspace.path, file: path, before, after })
            : undefined;
          journal.event(window.binding, path, before, after, window.outcome!, [...window.warnings],
            () => boundGuard(request, key, window), proof);
        }
        journal.notice(window.binding, 'batch', NATIVE_INTERVAL_WARNING,
          () => boundGuard(request, key, window), { capturePhase: 'after', outcome: window.outcome,
            captureBoundary: batch.boundary, ...(window.background ? { nativeTaskRef: window.background.taskRef, nativeRunRef: window.background.runRef } : {}) });
      });
      state = { phase: 'gap', reason: 'unqualified-native-interval' };
      release(key, window);
    } catch {
      state = { phase: sealed ? 'sealed' : 'gap', reason: window.invalidReason ?? 'capture-unavailable' };
      if (active.get(key) === window) {
        try { gap(key, window, state.reason!, batch.signal); } catch { release(key, window); }
      }
    }
  };
  return {
    async observe(request) {
      const key = keyOf(request);
      let window = active.get(key);
      try {
        guard(request);
        if (request.phase === 'gap') {
          state = { phase: 'gap', reason: request.reason };
          if (window) gap(key, window, request.reason, request.signal);
          return;
        }
        if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'].includes(request.toolName)) {
          if (request.toolName === 'Agent' && request.phase === 'before') {
            const attribution = bindTaskToolEvidence({ ...options, request });
            if (attribution.kind === 'bound') options.withWriteFence(() => {
              const current = () => {
                guard(request);
                const latest = bindTaskToolEvidence({ ...options, request });
                if (latest.kind !== 'bound' || identity(latest.binding) !== identity(attribution.binding)) throw new Error('Child evidence attribution changed');
              };
              current();
              journal.notice(attribution.binding, 'ordinary-subagent-capture-gap',
                'Ordinary subagent file effects are unqualified; the parent Agent call does not prove child changes.', current);
            });
          }
          state = { phase: 'gap', reason: 'unsupported-tool' };
          return;
        }
        const attribution = bindTaskToolEvidence({ ...options, request });
        if (attribution.kind !== 'bound') {
          state = { phase: 'gap', reason: attribution.reason };
          if (window) release(key, window);
          return;
        }
        const inputFingerprint = fingerprint(request.toolName, request.toolInput);
        if (request.phase === 'before') {
          if (window || seen.has(key)) {
            if (window) gap(key, window, 'duplicate', request.signal);
            else state = { phase: 'gap', reason: 'duplicate' };
            return;
          }
          if (seen.size >= 1000) {
            sealed = true;
            state = { phase: 'sealed', reason: 'capture-limit' };
            for (const [oldKey, oldWindow] of active) release(oldKey, oldWindow);
            return;
          }
          seen.add(key);
          window = { binding: attribution.binding,
            request: { ...request, toolInput: structuredClone(request.toolInput) }, fingerprint: inputFingerprint,
            warnings: new Set([NATIVE_INTERVAL_WARNING, 'Execution sequence is unqualified; zero denotes unknown.',
              'Selected Git/direct paths only; ignored secondary files and global workspace coverage are unqualified.']) };
          if (!options.windows.add(key, window)) { state = { phase: 'gap', reason: 'capture-limit' }; return; }
          active.set(key, window);
          state = { phase: 'capturing' };
          // Overlap still retains the original pair to consume its eventual gap, but never publishes bytes.
          if (window.invalidReason) return;
          window.before = await snapshotWorkspace({ workspace: options.captured.workspace,
            toolName: request.toolName, input: window.request.toolInput,
            guard: () => boundGuard(request, key, window!) });
          for (const warning of window.before.warnings) window.warnings.add(warning);
          if (!window.before.complete) window.invalidReason ??= 'incomplete-workspace-census';
          options.withWriteFence(() => {
            boundGuard(request, key, window!, true);
            const proof = [...window!.before!.files].map(([path, image]) => ({ path,
              ...journal.image(image, () => boundGuard(request, key, window!, true)) }));
            journal.notice(window!.binding, 'before',
              'Native capture window opened; completion and external exclusivity remain unqualified.',
              () => boundGuard(request, key, window!, true), { capturePhase: 'before', preimages: proof });
          });
          return;
        }
        if (!window && seen.has(key)) return;
        if (!window || window.fingerprint !== inputFingerprint || identity(window.binding) !== identity(attribution.binding) ||
          (window.outcome !== undefined && window.outcome !== request.outcome)) {
          state = { phase: 'gap', reason: 'pair-mismatch' };
          if (window) gap(key, window, 'pair-mismatch', request.signal);
          return;
        }
        // The native PostToolUse observer is provisional: mapped sibling hooks may still be running.
        window.outcome = request.outcome;
        if (attribution.binding.provenance.outcome === 'unknown') window.warnings.add('Runtime input handoff outcome is unknown.');
      } catch {
        state = { phase: sealed ? 'sealed' : 'gap', reason: window?.invalidReason ?? 'capture-unavailable' };
        if (window) {
          // An overlap can invalidate an awaited before snapshot. Preserve its original-owner
          // gap notice when authority is still current; revoked/sealed work cannot write.
          if (!sealed && !request.signal.aborted && active.get(key) === window) {
            try { gap(key, window, state.reason!, request.signal); }
            catch { release(key, window); }
          } else release(key, window);
        }
      }
    },
    async observeBatch(batch) {
      const entries = batch.tools.map((tool) => ({ tool, key: keyOf({ ...batch, toolUseId: tool.toolUseId }) }));
      try {
        if (batch.boundary !== 'post-tool-use-hooks' || entries.length !== 1) {
          state = { phase: 'gap', reason: 'multi-tool-batch' };
          for (const { key } of entries) {
            const window = active.get(key);
            if (window) gap(key, window, 'multi-tool-batch', batch.signal);
          }
          return;
        }
        const { tool, key } = entries[0]!;
        const window = active.get(key);
        if (!window) { if (!seen.has(key)) state = { phase: 'gap', reason: 'batch-mismatch' }; return; }
        if (window.fingerprint !== fingerprint(tool.toolName, tool.toolInput) || !window.before || window.outcome !== tool.outcome) {
          gap(key, window, window.invalidReason ?? 'batch-mismatch', batch.signal);
          return;
        }
        if (window.background) return; // A native background placeholder is not its terminal boundary.
        if (window.invalidReason) { gap(key, window, window.invalidReason, batch.signal); return; }
        const request = { ...window.request, phase: 'after' as const, outcome: tool.outcome, signal: batch.signal };
        boundGuard(request, key, window);
        if (!window.settlement) window.settlement = settle(batch, key, window);
        await window.settlement;
      } catch {
        state = { phase: sealed ? 'sealed' : 'gap', reason: 'capture-unavailable' };
        for (const { key } of entries) { const window = active.get(key); if (window) release(key, window); }
      }
    },
    async observeBackground(observation) {
      const key = keyOf(observation), window = active.get(key);
      if (!window) { if (!seen.has(key)) state = { phase: 'gap', reason: 'background-mismatch' }; return; }
      const request = { ...window.request, phase: 'after' as const, outcome: window.outcome!, signal: observation.signal };
      try {
        if (observation.toolName !== 'Bash' || window.request.toolName !== 'Bash' || !window.before || !window.outcome ||
          window.fingerprint !== fingerprint(observation.toolName, observation.toolInput)) {
          gap(key, window, 'background-mismatch', observation.signal); return;
        }
        if (observation.phase === 'registered' && window.invalidReason === 'incomplete-workspace-census' &&
          !window.request.signal.aborted && window.before.warnings.length > 0 &&
          window.before.warnings.every(warning => warning === 'background-tool')) {
          // This warning describes the interval, not a missing path census; preserve it without qualification.
          delete window.invalidReason;
        }
        boundGuard(request, key, window);
        if (observation.phase === 'registered') {
          if (window.background || window.settlement) { gap(key, window, 'background-mismatch', observation.signal); return; }
          // Validate the original preimage/authority before transferring only the observational lifetime.
          window.background = { taskRef: observation.taskRef, ...(observation.runRef === undefined ? {} : { runRef: observation.runRef }), signal: observation.signal };
          window.warnings.add('Native task termination does not prove descendant quiescence, external exclusivity or authorship.');
          options.withWriteFence(() => {
            boundGuard(request, key, window);
            journal.notice(window.binding, 'background-registered', 'Original native background task registered; capture remains incomplete.',
              () => boundGuard(request, key, window), { nativeTaskRef: observation.taskRef, nativeRunRef: observation.runRef,
                captureBoundary: observation.boundary, reviewableComplete: false });
          });
          return;
        }
        if (!window.background || window.background.taskRef !== observation.taskRef || window.background.runRef !== observation.runRef) {
          gap(key, window, 'background-mismatch', observation.signal); return;
        }
        if (observation.status === 'stopped') { gap(key, window, 'background-stopped', observation.signal); return; }
        if (observation.status === 'failed') window.outcome = 'failed';
        if (!window.settlement) window.settlement = settle(observation, key, window);
        await window.settlement;
      } catch {
        state = { phase: sealed ? 'sealed' : 'gap', reason: window.invalidReason ?? 'capture-unavailable' };
        if (active.get(key) === window) {
          try { gap(key, window, state.reason!, observation.signal); } catch { release(key, window); }
        }
      }
    },
    seal() {
      sealed = true;
      state = { phase: 'sealed' };
      for (const [key, window] of active) release(key, window);
    },
    readStatus: () => Object.freeze({ ...state }),
  };
}
