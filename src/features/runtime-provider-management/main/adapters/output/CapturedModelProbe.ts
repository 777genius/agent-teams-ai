import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { BackendRoutingError, HostClientError } from '@features/agent-backend/main';

import { managementValue } from './capturedManagementCatalog';

import type * as Dto from '../../../contracts';
import type {
  ProviderModelProbeLimits,
  ProviderModelProbeSnapshot,
} from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

interface ActiveProbe {
  commandId: string;
  cancelled: boolean;
  target?: CapturedProviderManagement;
  admission?: Promise<unknown>;
  cancellation?: Promise<Dto.RuntimeProviderManagementModelTestControlResponse>;
}
const unavailable = (
  runtimeId: Dto.RuntimeProviderModelTestRuntimeId = 'opencode'
): Dto.RuntimeProviderManagementModelTestResponse => ({
  schemaVersion: 1,
  runtimeId,
  error: {
    code: 'model-test-failed',
    message: 'The model test did not confirm access. Refresh before repeating it.',
    recoverable: true,
  },
});

/** One caller intent per native probe. Cancelling a superseded UI group retains its old capture. */
export class CapturedModelProbe {
  private readonly active = new Map<string, ActiveProbe>();
  constructor(
    private readonly capture: (
      projectPath: string | null,
      isCurrent?: () => boolean
    ) => Promise<CapturedProviderManagement>,
    private readonly limitsFor?: (
      target: CapturedProviderManagement,
      input: Dto.RuntimeProviderManagementTestModelInput
    ) => Promise<ProviderModelProbeLimits | undefined>,
    private readonly captureClaude?: (
      projectPath: string | null,
      isCurrent?: () => boolean
    ) => Promise<CapturedProviderManagement>
  ) {}

  async test(
    input: Dto.RuntimeProviderManagementTestModelInput,
    limits?: ProviderModelProbeLimits
  ): Promise<Dto.RuntimeProviderManagementModelTestResponse> {
    const captured = { ...input };
    let selectedLimits = limits ? { ...limits } : undefined;
    const commandId = randomUUID(),
      group = captured.requestGroupId ?? commandId;
    if (
      !['opencode', 'claude'].includes(captured.runtimeId) ||
      !captured.providerId ||
      !captured.modelId ||
      !group ||
      group.length > 8192
    )
      return unavailable();
    const fail = () => unavailable(captured.runtimeId);
    const previous = this.active.get(group);
    const entry: ActiveProbe = { commandId, cancelled: false };
    this.active.set(group, entry);
    try {
      if (previous && !(await this.cancelEntry(previous)).ok) return fail();
      if (entry.cancelled) return fail();
      const capture = captured.runtimeId === 'claude' ? this.captureClaude : this.capture;
      if (
        !capture ||
        (captured.runtimeId === 'claude' && (captured.providerId !== 'anthropic' || selectedLimits))
      )
        return fail();
      const target = await capture(captured.projectPath ?? null, () => !entry.cancelled);
      entry.target = target;
      if (entry.cancelled || !target.isCurrent()) return fail();
      if (!selectedLimits && this.limitsFor && captured.runtimeId === 'opencode')
        selectedLimits = await this.limitsFor(target, captured);
      if (entry.cancelled || !target.isCurrent()) return fail();
      entry.admission = target.request('probe.start', {
        commandId,
        providerId: captured.providerId,
        modelId: captured.modelId,
        ...(selectedLimits ? { limits: { ...selectedLimits } } : {}),
      });
      let result = this.snapshot(await entry.admission, entry, captured, selectedLimits);
      while (result.phase === 'running') {
        if (entry.cancelled || !target.isCurrent() || Date.now() >= result.expiresAt) {
          await this.cancelEntry(entry);
          return fail();
        }
        await delay(100);
        result = this.snapshot(
          await target.request('probe.read', { commandId }),
          entry,
          captured,
          selectedLimits
        );
      }
      if (entry.cancelled || !target.isCurrent() || result.phase !== 'completed') return fail();
      return {
        schemaVersion: 1,
        runtimeId: captured.runtimeId,
        result: {
          providerId: captured.providerId,
          modelId: captured.modelId,
          ok: result.ok,
          availability: result.ok ? 'available' : 'unknown',
          message: result.ok
            ? 'The selected model returned a text response.'
            : 'The native response did not confirm access to the selected model.',
          diagnostics: [],
          failureCode: result.ok ? null : 'execution-unconfirmed',
        },
      };
    } catch {
      await this.cancelEntry(entry); // A transport failure cannot be interpreted as no native submission.
      return fail();
    } finally {
      if (this.active.get(group) === entry) this.active.delete(group);
    }
  }

  private snapshot(
    raw: unknown,
    entry: ActiveProbe,
    input: Dto.RuntimeProviderManagementTestModelInput,
    limits?: ProviderModelProbeLimits
  ): ProviderModelProbeSnapshot {
    const value = managementValue(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Model test unavailable');
    const result = value as Record<string, unknown>;
    if (
      !entry.target ||
      !this.sameLimits(result.limits, limits) ||
      result.commandId !== entry.commandId ||
      result.profileId !== entry.target.profileId ||
      result.configRevision !== entry.target.configRevision ||
      result.providerId !== input.providerId ||
      result.modelId !== input.modelId ||
      !['running', 'completed', 'cancelled', 'held'].includes(String(result.phase)) ||
      typeof result.ok !== 'boolean' ||
      !Number.isSafeInteger(result.expiresAt) ||
      Number(result.expiresAt) > Date.now() + 195000
    )
      throw new Error('Model test unavailable');
    return result as unknown as ProviderModelProbeSnapshot;
  }

  private sameLimits(raw: unknown, expected?: ProviderModelProbeLimits): boolean {
    if (!expected) return raw === undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    return (
      Object.keys(value).length === 2 &&
      value.contextTokens === expected.contextTokens &&
      value.outputTokens === expected.outputTokens
    );
  }

  cancel(
    input: Dto.RuntimeProviderManagementCancelModelTestInput
  ): Promise<Dto.RuntimeProviderManagementModelTestControlResponse> {
    const entry = this.active.get(input.requestGroupId);
    return entry
      ? this.cancelEntry(entry)
      : Promise.resolve({ ok: false, error: 'The original model test is no longer available.' });
  }

  private cancelEntry(
    entry: ActiveProbe
  ): Promise<Dto.RuntimeProviderManagementModelTestControlResponse> {
    entry.cancelled = true; // Fence before target capture, lazy startup, or admission replies.
    entry.cancellation ??= (async () => {
      if (!entry.target || !entry.admission) return { ok: true };
      try {
        await entry.admission;
      } catch (error) {
        if (
          (error instanceof BackendRoutingError || error instanceof HostClientError) &&
          error.outcome === 'not-dispatched'
        )
          return { ok: true };
      }
      try {
        const raw = managementValue(
          await entry.target.request('probe.cancel', { commandId: entry.commandId })
        );
        if (
          raw &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          'phase' in raw &&
          raw.phase === 'cancelled'
        )
          return { ok: true };
      } catch {
        /* Original native result/stop remains unknown. No default route or retry. */
      }
      return { ok: false, error: 'Unable to confirm cancellation of the original model test.' };
    })();
    return entry.cancellation;
  }
}
