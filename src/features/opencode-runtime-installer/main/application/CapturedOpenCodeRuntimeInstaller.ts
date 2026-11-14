import { randomUUID } from 'node:crypto';

import { parseOpenCodeInstallOptions } from '../../core/domain/installPolicy';

import type {
  RuntimeSourceNativeSelection,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '@agent-teams/legacy-agent-host/runtime-sources';
import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { OpenCodeRuntimeInstallOptions, OpenCodeRuntimeStatus } from '@shared/types';

export interface CapturedOpenCodeInstallDependencies {
  native: {
    install(options: OpenCodeRuntimeInstallOptions): Promise<OpenCodeRuntimeStatus>;
    getReadinessStatus(): Promise<OpenCodeRuntimeStatus>;
  };
  captureSelection(
    status: OpenCodeRuntimeStatus,
    original: RuntimeSourceSummary
  ): Promise<RuntimeSourceNativeSelection>;
}

function sourceStatus(selection: RuntimeSourceSummary): OpenCodeRuntimeStatus {
  return {
    installed: selection.cliVersion !== undefined || selection.engineVersion !== undefined,
    source:
      selection.sourceKind === 'captured' || selection.sourceKind === 'bundled'
        ? 'captured-host'
        : selection.sourceKind,
    state: 'ready',
    ...((selection.cliVersion ?? selection.engineVersion)
      ? { version: selection.cliVersion ?? selection.engineVersion }
      : {}),
    ...(selection.engineVersion
      ? { engineVersion: selection.engineVersion, v2Support: 'ready' as const }
      : {}),
    sourceRevision: selection.revision,
  };
}

/** Existing native acquisition, then one original Host publication. Only the Host receipt is durable. */
export class CapturedOpenCodeRuntimeInstaller {
  private readonly pending = new Map<
    string,
    { intent: string; result: Promise<OpenCodeRuntimeStatus> }
  >();
  private lastSelection:
    | { sourceId: string; revision: string; input: string; commandId: string }
    | undefined;

  constructor(private readonly deps: CapturedOpenCodeInstallDependencies) {}

  install(sources: CapturedRuntimeSources, raw?: OpenCodeRuntimeInstallOptions) {
    return this.select(sources, parseOpenCodeInstallOptions(structuredClone(raw)));
  }

  /** The existing Refresh action may select the already installed/overridden CLI without a download. */
  selectInstalled(sources: CapturedRuntimeSources) {
    return this.select(sources);
  }

  private async select(sources: CapturedRuntimeSources, options?: OpenCodeRuntimeInstallOptions) {
    const original = await sources.current();
    const intent = JSON.stringify(options ?? null),
      previous = this.pending.get(original.sourceId);
    if (previous) {
      if (previous.intent !== intent)
        throw new Error('Another OpenCode selection is still in progress.');
      return previous.result;
    }
    const result = this.execute(sources, original, options);
    this.pending.set(original.sourceId, { intent, result });
    try {
      return await result;
    } finally {
      if (this.pending.get(original.sourceId)?.result === result)
        this.pending.delete(original.sourceId);
    }
  }

  private async execute(
    sources: CapturedRuntimeSources,
    original: RuntimeSourceSummary,
    options?: OpenCodeRuntimeInstallOptions
  ): Promise<OpenCodeRuntimeStatus> {
    try {
      // Recovery uses the saved command and full candidate, never this request's current/default input.
      const recovered = await sources.recover();
      if (recovered) return this.completed(recovered);
      if (options?.generation && options.generation !== original.nativeGeneration)
        throw new Error('Switching OpenCode generations is not yet qualified for this runtime.');
      const native = options
        ? await this.deps.native.install({
            ...options,
            generation: options.generation ?? original.nativeGeneration,
          })
        : await this.deps.native.getReadinessStatus();
      if (!native.installed || native.state !== 'ready' || native.v2Support === 'required')
        throw new Error(native.error ?? 'OpenCode installation could not be confirmed.');
      const nativeSelection = await this.deps.captureSelection(native, original);
      // Re-read only as an original selection fence. It cannot supply a replacement expectedRevision.
      if ((await sources.current()).revision !== original.revision)
        throw new Error('OpenCode selection changed. Refresh before repeating this action.');
      const observed = await this.deps.native.getReadinessStatus();
      if (
        !observed.installed ||
        observed.binaryPath !== native.binaryPath ||
        observed.version !== native.version ||
        observed.source !== native.source
      )
        throw new Error('The installed OpenCode selection changed during verification.');
      const selectionInput = JSON.stringify(nativeSelection),
        last = this.lastSelection;
      // One disposable cache avoids re-publishing the install's immediate Refresh. The receipt remains authority.
      if (
        last?.sourceId === original.sourceId &&
        last.revision === original.revision &&
        last.input === selectionInput
      ) {
        const known = await sources.lookup(last.commandId);
        if (known?.selection?.revision !== original.revision)
          throw new Error('The original OpenCode selection could not be confirmed.');
        return this.completed(known);
      }
      const commandId = randomUUID();
      let published: RuntimeSourcePublication;
      try {
        published = await sources.publish({
          commandId,
          expectedRevision: original.revision,
          nativeSelection,
        });
      } catch (error) {
        // A lost response can only be reconciled with this original command's receipt.
        const known = await sources.lookup(commandId).catch(() => null);
        if (!known) throw error;
        published = known;
      }
      const completed = this.completed(published);
      this.lastSelection = {
        sourceId: original.sourceId,
        revision: published.selection!.revision,
        input: selectionInput,
        commandId,
      };
      return completed;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'OpenCode selection could not be confirmed.';
      return {
        ...sourceStatus(original),
        ...(original.sourceKind === 'captured' ? { installed: false } : {}),
        state: 'failed',
        error: message,
        progress: { phase: 'failed', detail: message },
      };
    }
  }

  private completed(publication: RuntimeSourcePublication): OpenCodeRuntimeStatus {
    if (publication.phase !== 'published' || !publication.selection?.cliVersion)
      throw new Error(
        'OpenCode verification has not completed. Retry to check the original operation.'
      );
    return {
      ...sourceStatus(publication.selection),
      progress: { phase: 'ready', percent: 100, detail: 'OpenCode is ready for new launches.' },
    };
  }
}
