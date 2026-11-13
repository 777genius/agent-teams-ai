import { randomUUID } from 'node:crypto';

import type {
  RuntimeSourceNativeSelection,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '@agent-teams/legacy-agent-host/runtime-sources';
import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

export interface CapturedCodexInstallDependencies {
  native: {
    install(
      accept: (status: CodexRuntimeStatus) => Promise<CodexRuntimeStatus>
    ): Promise<CodexRuntimeStatus>;
    getReadinessStatus(): Promise<CodexRuntimeStatus>;
  };
  captureSelection(status: CodexRuntimeStatus): Promise<RuntimeSourceNativeSelection>;
}

/** The installer acquires files; the existing Host command owns their selection and replay. */
export class CapturedCodexRuntimeInstaller {
  private pending:
    | { sourceId: string; revision: string; install: boolean; result: Promise<CodexRuntimeStatus> }
    | undefined;
  private lastSelection:
    | { sourceId: string; revision: string; input: string; commandId: string }
    | undefined;

  constructor(private readonly deps: CapturedCodexInstallDependencies) {}

  install(sources: CapturedRuntimeSources) {
    return this.select(sources, true);
  }

  selectInstalled(sources: CapturedRuntimeSources) {
    return this.select(sources, false);
  }

  private async select(
    sources: CapturedRuntimeSources,
    install: boolean
  ): Promise<CodexRuntimeStatus> {
    const original = await sources.current();
    const previous = this.pending;
    if (previous) {
      if (
        previous.sourceId !== original.sourceId ||
        previous.revision !== original.revision ||
        previous.install !== install
      )
        throw new Error('Another Codex selection is still in progress.');
      return previous.result;
    }
    const result = this.execute(sources, original, install);
    this.pending = { sourceId: original.sourceId, revision: original.revision, install, result };
    try {
      return await result;
    } finally {
      if (this.pending?.result === result) this.pending = undefined;
    }
  }

  private async execute(
    sources: CapturedRuntimeSources,
    original: RuntimeSourceSummary,
    install: boolean
  ): Promise<CodexRuntimeStatus> {
    let physical: CodexRuntimeStatus | undefined,
      selecting = false;
    try {
      const recovered = await sources.recover();
      if (recovered?.phase === 'published') return this.completed(recovered);
      physical = await this.deps.native.getReadinessStatus();
      if (recovered) {
        selecting = true;
        return this.completed(recovered);
      }
      const accept = async (status: CodexRuntimeStatus) => {
        physical = status;
        selecting = true;
        return this.publish(sources, original, status);
      };
      const result = install ? await this.deps.native.install(accept) : await accept(physical);
      if (!result.installed || result.state !== 'ready')
        throw new Error(result.error ?? 'Codex installation could not be confirmed.');
      return result;
    } catch (error) {
      if (!physical) throw error;
      const cause =
        error instanceof Error ? error.message : 'Codex selection could not be confirmed.';
      const message =
        selecting && physical.installed
          ? `Codex is installed, but its Host selection was not confirmed. ${cause}`
          : cause;
      return {
        ...physical,
        state: 'failed',
        error: message,
        progress: { phase: 'failed', detail: message },
      };
    }
  }

  private async publish(
    sources: CapturedRuntimeSources,
    original: RuntimeSourceSummary,
    native: CodexRuntimeStatus
  ): Promise<CodexRuntimeStatus> {
    if (!native.installed || native.state !== 'ready')
      throw new Error(native.error ?? 'Codex installation could not be confirmed.');
    const nativeSelection = await this.deps.captureSelection(native);
    if ((await sources.current()).revision !== original.revision)
      throw new Error('Codex selection changed. Refresh before repeating this action.');
    const observed = await this.deps.native.getReadinessStatus();
    if (
      !observed.installed ||
      observed.binaryPath !== native.binaryPath ||
      observed.version !== native.version ||
      observed.source !== native.source
    )
      throw new Error('The installed Codex selection changed during verification.');
    const input = JSON.stringify(nativeSelection),
      last = this.lastSelection;
    if (
      last?.sourceId === original.sourceId &&
      last.input === input &&
      last.revision !== original.revision
    )
      throw new Error(
        'Codex selection changed after installation. Install again to select this version.'
      );
    if (
      last?.sourceId === original.sourceId &&
      last.revision === original.revision &&
      last.input === input
    ) {
      const known = await sources.lookup(last.commandId);
      if (known?.selection?.revision !== original.revision)
        throw new Error('The original Codex selection could not be confirmed.');
      return this.completed(known, native);
    }
    const commandId = randomUUID();
    let publication: RuntimeSourcePublication;
    try {
      publication = await sources.publish({
        commandId,
        expectedRevision: original.revision,
        nativeSelection,
      });
    } catch (error) {
      const known = await sources.lookup(commandId).catch(() => null);
      if (!known) throw error;
      publication = known;
    }
    const result = this.completed(publication, native);
    this.lastSelection = {
      sourceId: original.sourceId,
      revision: publication.selection!.revision,
      input,
      commandId,
    };
    return result;
  }

  private completed(
    publication: RuntimeSourcePublication,
    native?: CodexRuntimeStatus
  ): CodexRuntimeStatus {
    const selection = publication.selection;
    if (
      publication.phase !== 'published' ||
      !selection?.cliVersion ||
      !['app-managed', 'path'].includes(selection.sourceKind)
    )
      throw new Error(
        'Codex verification has not completed. Retry to check the original operation.'
      );
    return {
      ...native,
      installed: true,
      source: selection.sourceKind as 'app-managed' | 'path',
      version: selection.cliVersion,
      latestVersion: native?.latestVersion ?? null,
      updateAvailable: native?.updateAvailable ?? false,
      state: 'ready',
      progress: { phase: 'ready', percent: 100, detail: 'Codex is ready for new launches.' },
    };
  }
}
