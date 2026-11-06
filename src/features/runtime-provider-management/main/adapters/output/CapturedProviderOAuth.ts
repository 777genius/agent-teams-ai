import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { validOAuthOperationId } from '../../infrastructure/FileProviderOAuthIntentStore';

import { managementValue } from './capturedManagementCatalog';

import type * as Dto from '../../../contracts';
import type {
  ProviderOAuthIntent,
  ProviderOAuthIntentStore,
} from '../../infrastructure/FileProviderOAuthIntentStore';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

export interface CapturedProviderOAuthDependencies {
  intents: ProviderOAuthIntentStore;
  restore(targetId: string): Promise<CapturedProviderManagement>;
  openExternal(url: string): Promise<void>;
  emitProgress?(event: Dto.RuntimeProviderOAuthProgressDto): void;
}
const failed = () => ({ ok: false, error: 'Unable to confirm the original sign-in operation.' });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OAuth state unavailable');
  return value as Record<string, unknown>;
};

/** Main owns original routing and browser opening; Host owns native OAuth lifecycle and credentials. */
export class CapturedProviderOAuth {
  private readonly active = new Map<string, { fingerprint: string; result: Promise<void> }>();
  private readonly listeners = new Set<(event: Dto.RuntimeProviderOAuthProgressDto) => void>();
  constructor(private readonly deps: CapturedProviderOAuthDependencies) {}

  subscribe(listener: (event: Dto.RuntimeProviderOAuthProgressDto) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(
    target: CapturedProviderManagement,
    input: {
      operationId: string;
      runtimeId?: Dto.RuntimeProviderManagementRuntimeId;
      providerId: string;
      methodIndex: number;
      displayName: string;
      authOptionId: string;
      fields?: Record<string, string>;
    }
  ): Promise<void> {
    // Capture fields before reading the durable journal or waiting on another request.
    const captured = { ...input, ...(input.fields ? { fields: { ...input.fields } } : {}) };
    if (
      !validOAuthOperationId(captured.operationId) ||
      !Number.isSafeInteger(captured.methodIndex) ||
      captured.methodIndex < 0
    )
      throw new Error('OAuth intent invalid');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          ...(captured.runtimeId === 'claude' ? ['claude'] : []),
          target.targetId,
          captured.providerId,
          captured.methodIndex,
          captured.authOptionId,
          Object.entries(captured.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ])
      )
      .digest('hex');
    const running = this.active.get(captured.operationId);
    if (running) {
      if (running.fingerprint !== fingerprint) throw new Error('OAuth intent conflict');
      return running.result;
    }
    const intent: ProviderOAuthIntent = {
      schemaVersion: 1,
      ...(captured.runtimeId === 'claude' ? { runtimeId: 'claude' as const } : {}),
      operationId: captured.operationId,
      targetId: target.targetId,
      providerId: captured.providerId,
      methodIndex: captured.methodIndex,
      authOptionId: captured.authOptionId,
      displayName: captured.displayName,
      fingerprint,
    };
    const previous = await this.deps.intents.read(intent.operationId);
    if (previous || !(await this.deps.intents.create(intent))) {
      const originalRun = this.active.get(intent.operationId);
      if (originalRun) {
        if (originalRun.fingerprint !== fingerprint) throw new Error('OAuth intent conflict');
        return originalRun.result;
      }
      const saved = previous ?? (await this.deps.intents.read(intent.operationId));
      if (!saved || saved.fingerprint !== fingerprint || saved.targetId !== target.targetId)
        throw new Error('OAuth intent conflict');
      // Re-entry after loss/restart only reads the original owner, never re-authorizes or reopens a browser.
      const original = await this.deps.restore(saved.targetId);
      const snapshot = this.snapshot(
        await original.request('oauth.read', { operationId: saved.operationId }),
        saved,
        original
      );
      if (snapshot.phase !== 'completed')
        throw new Error('Original OAuth operation remains unconfirmed');
      return;
    }
    const result = this.run(target, intent, captured.fields);
    this.active.set(intent.operationId, { fingerprint, result });
    try {
      await result;
    } catch {
      try {
        await target.request('oauth.cancel', { operationId: intent.operationId });
      } catch {
        /* Original route remains available for explicit later reconciliation. */
      }
      throw new Error('Original sign-in operation unconfirmed');
    } finally {
      if (this.active.get(intent.operationId)?.result === result)
        this.active.delete(intent.operationId);
    }
  }

  private snapshot(
    value: unknown,
    intent: ProviderOAuthIntent,
    target: CapturedProviderManagement
  ): ProviderOAuthSnapshot {
    const snapshot = object(managementValue(value));
    if (
      snapshot.operationId !== intent.operationId ||
      snapshot.providerId !== intent.providerId ||
      snapshot.profileId !== target.profileId ||
      snapshot.configRevision !== target.configRevision ||
      snapshot.methodIndex !== intent.methodIndex ||
      ![
        'authorizing',
        'waiting-for-code',
        'waiting-for-browser',
        'completing',
        'cancelling',
        'completed',
        'cancelled',
        'held',
      ].includes(String(snapshot.phase)) ||
      ![null, 'code', 'auto'].includes(snapshot.completionMethod as string | null) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      Number(snapshot.sequence) < 1 ||
      !Number.isSafeInteger(snapshot.expiresAt) ||
      Number(snapshot.expiresAt) <= 0
    )
      throw new Error('OAuth state unavailable');
    return snapshot as unknown as ProviderOAuthSnapshot;
  }

  private emit(intent: ProviderOAuthIntent, snapshot: ProviderOAuthSnapshot): void {
    const phase: Dto.RuntimeProviderOAuthProgressPhaseDto =
      snapshot.phase === 'held'
        ? 'failed'
        : snapshot.phase === 'cancelling' || snapshot.phase === 'cancelled'
          ? 'cancelled'
          : snapshot.phase === 'completed'
            ? 'completing'
            : snapshot.phase;
    const event: Dto.RuntimeProviderOAuthProgressDto = {
      operationId: intent.operationId,
      runtimeId: intent.runtimeId ?? 'opencode',
      providerId: intent.providerId,
      displayName: intent.displayName,
      authOptionId: intent.authOptionId,
      methodIndex: intent.methodIndex,
      phase,
      completionMethod: snapshot.completionMethod,
      instructions:
        snapshot.phase === 'waiting-for-code'
          ? 'Complete sign-in in your browser and enter the returned code.'
          : null,
      message: null,
    };
    // Never forward native URLs/instructions or raw Host snapshots to the renderer.
    for (const listener of [this.deps.emitProgress, ...this.listeners]) {
      try {
        listener?.({ ...event });
      } catch {
        /* A renderer listener cannot alter native auth ownership. */
      }
    }
  }

  private async run(
    target: CapturedProviderManagement,
    intent: ProviderOAuthIntent,
    fields?: Record<string, string>
  ): Promise<void> {
    let snapshot = this.snapshot(
      await target.request('oauth.start', {
        operationId: intent.operationId,
        providerId: intent.providerId,
        methodIndex: intent.methodIndex,
        ...(fields ? { fields } : {}),
      }),
      intent,
      target
    );
    let opened = false,
      autoSubmitted = false,
      sequence = 0;
    for (;;) {
      if (!target.isCurrent()) {
        // Control is retained against the old owner even after the foreground context switched.
        await target.request('oauth.cancel', { operationId: intent.operationId });
        throw new Error('OAuth context changed');
      }
      if (snapshot.sequence < sequence) throw new Error('OAuth progress regressed');
      if (snapshot.sequence > sequence) {
        this.emit(intent, snapshot);
        sequence = snapshot.sequence;
      }
      if (snapshot.phase === 'completed') return;
      if (snapshot.phase === 'held' || snapshot.phase === 'cancelled')
        throw new Error('OAuth outcome unconfirmed');
      if (Date.now() >= snapshot.expiresAt) {
        await target.request('oauth.cancel', { operationId: intent.operationId });
        throw new Error('OAuth expired');
      }
      if (!opened && ['waiting-for-code', 'waiting-for-browser'].includes(snapshot.phase)) {
        const privateReply = managementValue(
          await target.request('oauth.authorization', { operationId: intent.operationId })
        );
        if (privateReply === null) {
          // A code/cancel may have won between progress and this private read.
          snapshot = this.snapshot(
            await target.request('oauth.read', { operationId: intent.operationId }),
            intent,
            target
          );
          continue;
        }
        const authorization = object(privateReply);
        if (
          typeof authorization.authorizationUrl !== 'string' ||
          authorization.authorizationUrl.length > 16384
        )
          throw new Error('OAuth authorization unavailable');
        const url = new URL(authorization.authorizationUrl);
        if (
          url.username ||
          url.password ||
          !(
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          )
        )
          throw new Error('OAuth authorization unavailable');
        if (!target.isCurrent()) continue;
        opened = true; // Never repeat an uncertain external-open effect.
        if (authorization.browserOwner !== undefined && authorization.browserOwner !== 'native')
          throw new Error('OAuth browser owner unavailable');
        if (authorization.browserOwner !== 'native') await this.deps.openExternal(url.href);
      }
      if (snapshot.phase === 'waiting-for-browser' && !autoSubmitted) {
        autoSubmitted = true;
        snapshot = this.snapshot(
          await target.request('oauth.complete', {
            operationId: intent.operationId,
            commandId: `${intent.operationId}:auto`,
          }),
          intent,
          target
        );
        continue;
      }
      await delay(100);
      snapshot = this.snapshot(
        await target.request('oauth.read', { operationId: intent.operationId }),
        intent,
        target
      );
    }
  }

  async submitCode(
    input: Dto.RuntimeProviderManagementSubmitOAuthCodeInput
  ): Promise<Dto.RuntimeProviderManagementOAuthControlResponse> {
    const { operationId, code } = input;
    try {
      if (typeof code !== 'string' || !code.trim() || code.length > 16384) return failed();
      const intent = await this.deps.intents.read(operationId);
      if (!intent) return failed();
      const target = await this.deps.restore(intent.targetId);
      if (!target.isCurrent()) return failed();
      const result = this.snapshot(
        await target.request('oauth.complete', {
          operationId,
          commandId: `${operationId}:code`,
          code,
        }),
        intent,
        target
      );
      return ['completing', 'completed'].includes(result.phase) ? { ok: true } : failed();
    } catch {
      return failed();
    }
  }

  async cancel(
    input: Dto.RuntimeProviderManagementCancelOAuthInput
  ): Promise<Dto.RuntimeProviderManagementOAuthControlResponse> {
    const { operationId } = input;
    try {
      const intent = await this.deps.intents.read(operationId);
      if (!intent) return failed();
      const target = await this.deps.restore(intent.targetId);
      const snapshot = this.snapshot(
        await target.request('oauth.cancel', { operationId }),
        intent,
        target
      );
      // completed means cancellation lost the race; credentials must not be silently deleted.
      return snapshot.phase === 'cancelled' ? { ok: true } : failed();
    } catch {
      return failed();
    }
  }
}
