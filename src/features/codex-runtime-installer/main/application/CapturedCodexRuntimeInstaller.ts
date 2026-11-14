import { randomUUID } from 'node:crypto';

import { runtimeSourceNativeExecutableDigest } from '@agent-teams/legacy-agent-host/runtime-sources';

import { codexRuntimeVersionStatus } from '../infrastructure/codexRuntimeInstallerPresentation';

import type {
  CapturedCodexAcquisitionRequest,
  CodexRuntimeInstallerService,
} from '../infrastructure/CodexRuntimeInstallerService';
import type {
  RuntimeSourceNativeSelection,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '@agent-teams/legacy-agent-host/runtime-sources';
import type { CapturedRuntimeSources } from '@features/agent-backend/main';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type {
  CapturedCodexResolution,
  CapturedCodexResolver,
} from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';

export interface CapturedCodexInstallRequest {
  readonly sources: Promise<CapturedRuntimeSources>;
  readonly resolver: CapturedCodexResolver;
}

type NativeInstaller = Pick<
  CodexRuntimeInstallerService,
  'installCaptured' | 'readLatestVersion' | 'publishCapturedStatus'
>;
type Pending = {
  intent: string;
  original: string;
  resolver: string;
  status: CodexRuntimeStatus;
  result: Promise<CodexRuntimeStatus>;
};

function sourceStatus(
  source: RuntimeSourceSummary,
  version = source.cliVersion
): CodexRuntimeStatus {
  return {
    installed: version !== undefined,
    ...(version ? { version } : {}),
    latestVersion: null,
    updateAvailable: false,
    source:
      source.sourceKind === 'captured' || source.sourceKind === 'bundled'
        ? 'captured-host'
        : source.sourceKind,
    state: version ? 'ready' : 'idle',
    sourceRevision: source.revision,
  };
}

function sameSource(a: RuntimeSourceSummary, b: RuntimeSourceSummary): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSelection(
  source: RuntimeSourceSummary,
  selected: RuntimeSourceNativeSelection
): boolean {
  return (
    source.nativeExecutableDigest ===
      runtimeSourceNativeExecutableDigest(selected.nativeCli.executable) &&
    (source.cliVersion === undefined || source.cliVersion === selected.nativeCli.version) &&
    (source.sourceKind === 'captured' || source.sourceKind === selected.sourceKind)
  );
}

function held(): never {
  throw new Error('The original Codex runtime selection could not be confirmed.');
}

/** One original acquisition, then the existing Host source command. No legacy metadata process. */
export class CapturedCodexRuntimeInstaller {
  private readonly pending = new Map<string, Pending>();
  private lastSelection:
    | { sourceId: string; revision: string; commandId: string; input: string }
    | undefined;

  constructor(private readonly native: NativeInstaller) {}

  private async checked<T>(
    request: CapturedCodexInstallRequest,
    work: () => Promise<T>
  ): Promise<T> {
    request.resolver.assertCurrent();
    try {
      return await work();
    } finally {
      request.resolver.assertCurrent();
    }
  }

  private async current(
    request: CapturedCodexInstallRequest,
    sources: CapturedRuntimeSources,
    expected: RuntimeSourceSummary
  ) {
    const current = await this.checked(request, () => sources.current());
    if (!sameSource(current, expected)) held();
  }

  private async latest(
    request: CapturedCodexInstallRequest,
    sources: CapturedRuntimeSources,
    expected: RuntimeSourceSummary,
    status: CodexRuntimeStatus
  ): Promise<CodexRuntimeStatus> {
    const latest = await this.checked(request, () => this.native.readLatestVersion());
    await this.current(request, sources, expected);
    return codexRuntimeVersionStatus(status, latest);
  }

  async getStatus(request: CapturedCodexInstallRequest): Promise<CodexRuntimeStatus> {
    const sources = await this.checked(request, () => request.sources);
    const original = await this.checked(request, () => sources.current());
    const pending = this.pending.get(original.sourceId);
    if (pending) {
      if (
        pending.original !== JSON.stringify(original) ||
        pending.resolver !== request.resolver.fingerprint
      )
        held();
      return pending.status;
    }
    let version = original.cliVersion;
    if (version === undefined) {
      const resolved = await this.checked(request, () => request.resolver.resolve());
      if (resolved && sameSelection(original, resolved.selection))
        version = resolved.selection.nativeCli.version;
      await this.current(request, sources, original);
      if (resolved) await this.checked(request, () => resolved.assertCurrent());
    }
    // A different installed candidate never supplies the current captured runtime's version.
    return this.latest(request, sources, original, sourceStatus(original, version));
  }

  install(request: CapturedCodexInstallRequest): Promise<CodexRuntimeStatus> {
    return this.select(request, 'install');
  }

  selectInstalled(request: CapturedCodexInstallRequest): Promise<CodexRuntimeStatus> {
    return this.select(request, 'select');
  }

  private async select(request: CapturedCodexInstallRequest, operation: 'install' | 'select') {
    const sources = await this.checked(request, () => request.sources);
    const original = await this.checked(request, () => sources.current());
    const originalKey = JSON.stringify(original);
    const intent = JSON.stringify({ operation, original, resolver: request.resolver.fingerprint });
    const previous = this.pending.get(original.sourceId);
    if (previous) {
      if (previous.intent !== intent)
        throw new Error('Another Codex selection is still in progress.');
      const result = await previous.result;
      // Joining its result does not turn the second invocation's obsolete manifest into authority.
      request.resolver.assertAuthority();
      if ((await sources.current()).revision !== result.sourceRevision) held();
      request.resolver.assertAuthority();
      return result;
    }
    const result = Promise.resolve().then(() =>
      this.execute(request, sources, original, operation, (status) => {
        pending.status = status;
      })
    );
    const pending: Pending = {
      intent,
      original: originalKey,
      resolver: request.resolver.fingerprint,
      status: { ...sourceStatus(original), state: 'checking' },
      result,
    };
    this.pending.set(original.sourceId, pending);
    try {
      return await result;
    } finally {
      if (this.pending.get(original.sourceId)?.result === result)
        this.pending.delete(original.sourceId);
    }
  }

  private async published(
    request: CapturedCodexInstallRequest,
    sources: CapturedRuntimeSources,
    publication: RuntimeSourcePublication,
    expected?: RuntimeSourceNativeSelection
  ): Promise<RuntimeSourceSummary> {
    const selected = publication.selection;
    if (
      publication.phase !== 'published' ||
      !selected?.cliVersion ||
      !selected.nativeExecutableDigest ||
      (expected &&
        (!sameSelection(selected, expected) || selected.sourceKind !== expected.sourceKind))
    )
      held();
    await this.current(request, sources, selected);
    return selected;
  }

  private async execute(
    request: CapturedCodexInstallRequest,
    sources: CapturedRuntimeSources,
    original: RuntimeSourceSummary,
    operation: 'install' | 'select',
    observe: (status: CodexRuntimeStatus) => void
  ): Promise<CodexRuntimeStatus> {
    const emit = (status: CodexRuntimeStatus) => {
      request.resolver.assertCurrent();
      observe(status);
      this.native.publishCapturedStatus(status);
      request.resolver.assertCurrent();
    };
    try {
      const recovered = await this.checked(request, () => sources.recover());
      if (recovered) {
        const selected = await this.published(request, sources, recovered);
        const status = await this.latest(request, sources, selected, sourceStatus(selected));
        const completed = {
          ...status,
          progress: {
            phase: 'ready' as const,
            percent: 100,
            detail: 'The original Codex runtime selection is confirmed.',
          },
        };
        emit(completed);
        return completed;
      }
      await this.current(request, sources, original);
      let acquired = false;
      if (operation === 'install') {
        const acquisition: CapturedCodexAcquisitionRequest = {
          assertCurrent: request.resolver.assertCurrent,
          acceptAcquired: request.resolver.acceptAcquired,
          onProgress: (status) => {
            const phase = status.state === 'ready' ? 'installing' : status.state;
            emit({
              ...sourceStatus(original),
              state: phase,
              progress: {
                phase,
                ...(status.progress?.downloadedBytes !== undefined
                  ? { downloadedBytes: status.progress.downloadedBytes }
                  : {}),
                ...(status.progress?.totalBytes !== undefined
                  ? { totalBytes: status.progress.totalBytes }
                  : {}),
                ...(status.progress?.percent !== undefined
                  ? { percent: status.progress.percent }
                  : {}),
                detail:
                  status.state === 'ready'
                    ? 'Codex package verified; confirming the runtime selection.'
                    : status.state === 'failed'
                      ? 'Codex acquisition could not be confirmed.'
                      : status.progress?.detail,
              },
            });
          },
        };
        await this.checked(request, () => this.native.installCaptured(acquisition));
        acquired = true;
        await this.current(request, sources, original);
      }
      const resolved: CapturedCodexResolution | null = await this.checked(request, () =>
        request.resolver.resolve()
      );
      if (!resolved) held();
      await this.current(request, sources, original);
      await this.checked(request, () => resolved.assertCurrent());
      const nativeSelection = resolved.selection;
      let selected = original;
      if (sameSelection(original, nativeSelection)) {
        const last = this.lastSelection;
        if (last?.sourceId === original.sourceId && last.revision === original.revision) {
          if (last.input !== JSON.stringify(nativeSelection)) held();
          const known = await this.checked(request, () => sources.lookup(last.commandId));
          if (!known) held();
          selected = await this.published(request, sources, known, nativeSelection);
        }
      } else {
        await this.current(request, sources, original);
        await this.checked(request, () => resolved.assertCurrent());
        const commandId = randomUUID();
        let publication: RuntimeSourcePublication;
        try {
          publication = await this.checked(request, () =>
            sources.publish({ commandId, expectedRevision: original.revision, nativeSelection })
          );
        } catch (error) {
          const known = await this.checked(request, () => sources.lookup(commandId)).catch(
            () => null
          );
          if (!known) throw error;
          publication = known;
        }
        selected = await this.published(request, sources, publication, nativeSelection);
        this.lastSelection = {
          sourceId: selected.sourceId,
          revision: selected.revision,
          commandId,
          input: JSON.stringify(nativeSelection),
        };
      }
      await this.checked(request, () => resolved.assertCurrent());
      const status = await this.latest(
        request,
        sources,
        selected,
        sourceStatus(selected, nativeSelection.nativeCli.version)
      );
      const completed = {
        ...status,
        progress: {
          phase: 'ready' as const,
          percent: 100,
          detail:
            acquired && nativeSelection.sourceKind === 'override'
              ? 'Codex package installed; the original custom override is still selected.'
              : 'Codex is ready for new launches.',
        },
      };
      emit(completed);
      return completed;
    } catch (cause) {
      // Native errors may contain private paths/output. The original Host command/debt remains retained.
      const error = 'Codex selection could not be confirmed. The previous runtime is retained.';
      const status: CodexRuntimeStatus = {
        ...sourceStatus(original),
        state: 'failed',
        error,
        progress: { phase: 'failed', detail: error },
      };
      observe(status);
      try {
        emit(status);
      } catch {
        /* A revoked original sender receives no progress. */
      }
      throw new Error(error, { cause });
    }
  }
}
