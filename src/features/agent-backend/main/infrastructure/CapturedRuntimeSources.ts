import {
  refreshRuntimeConfigurationSchema,
  runtimeSourceCandidateSchema,
  runtimeSourceGrantSchema,
  runtimeSourceNativeSelectionSchema,
  runtimeSourcePublicationSchema,
  runtimeSourceRefusalSchema,
  runtimeSourceSummarySchema,
} from '@agent-teams/legacy-agent-host/runtime-sources';

import { BackendRoutingError } from '../application/backendBinding';

import type { CapturedHostClient } from './CapturedHostClient';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  OpenCodeManagedPreferences,
  RuntimeConfigurationRefreshIntent,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourcePublishIntent,
  RuntimeSourceRefusal,
  RuntimeSourceSummary,
} from '@agent-teams/legacy-agent-host/runtime-sources';

export class CapturedRuntimeSourceError extends BackendRoutingError {
  constructor(readonly reason: RuntimeSourceRefusal) {
    super('hold', 'unknown');
    this.message = `Runtime source selection: ${reason}`;
  }
}

/** Private Main port for an existing descriptor grant; it is never exposed through generic management invoke. */
export interface CapturedRuntimeSources {
  capturePreferences?(): Promise<OpenCodeManagedPreferences>;
  current(): Promise<RuntimeSourceSummary>;
  retained(): Promise<RuntimeSourceSummary[]>;
  publish(input: RuntimeSourcePublishIntent): Promise<RuntimeSourcePublication>;
  refreshConfiguration(input: RuntimeConfigurationRefreshIntent): Promise<RuntimeSourcePublication>;
  recover(): Promise<RuntimeSourcePublication | null>;
  lookup(commandId: string): Promise<RuntimeSourcePublication | null>;
}

export function captureRuntimeSources(options: {
  grant: RuntimeSourceGrant;
  client: Pick<CapturedHostClient, 'request'>;
  start(): Promise<unknown>;
  ownerAvailable(): boolean;
  foregroundCurrent(): boolean;
  capturePreferences?(): Promise<OpenCodeManagedPreferences>;
  prepareNativePublication?(input: RuntimeSourcePublishIntent): () => void;
  prepareNativeRecovery?(): () => void;
  prepareNativeConfiguration?(input: RuntimeConfigurationRefreshIntent): () => void;
}): CapturedRuntimeSources {
  const grant = runtimeSourceGrantSchema.parse(structuredClone(options.grant));
  const summary = (raw: unknown) => {
    const selected = runtimeSourceSummarySchema.parse(raw);
    if (
      selected.sourceId !== grant.targetId ||
      !((selected.sourceKind === 'captured' && selected.profileId === grant.profileId &&
        selected.configRevision === grant.configRevision) ||
        (selected.profileId === `runtime-source:${selected.revision}` &&
          selected.configRevision === `runtime-source:${selected.revision}`))
    )
      throw new BackendRoutingError('hold', 'unknown');
    return selected;
  };
  const request = async (
    operation: 'current' | 'retained' | 'publish' | 'lookup' | 'recover' | 'refreshConfiguration',
    payload: object = {},
    beforeDispatch?: () => (() => void) | undefined
  ) => {
    const retained = operation === 'lookup' || operation === 'retained';
    const check = (outcome: 'not-dispatched' | 'unknown') => {
      let owner = false,
        foreground = false;
      try {
        owner = options.ownerAvailable();
        foreground = retained || options.foregroundCurrent();
      } catch {
        /* A failing context predicate never grants dispatch. */
      }
      if (!owner) throw new BackendRoutingError('unavailable', outcome);
      if (!foreground) throw new BackendRoutingError('forbidden', outcome);
    };
    check('not-dispatched');
    await options.start();
    check('not-dispatched');
    const release = beforeDispatch?.();
    try {
      const reply = await options.client.request(
        `runtime.source.${operation}`,
        JSON.parse(JSON.stringify({ ...payload, grant })) as JsonValue,
        { control: !['publish', 'recover', 'refreshConfiguration'].includes(operation) }
      );
      check('unknown');
      if (
        !reply ||
        typeof reply !== 'object' ||
        Array.isArray(reply) ||
        reply.ok !== true ||
        !Object.hasOwn(reply, 'value')
      ) {
        const code =
          reply && typeof reply === 'object' && !Array.isArray(reply) ? reply.code : undefined;
        const reason = runtimeSourceRefusalSchema.safeParse(
          reply && typeof reply === 'object' && !Array.isArray(reply) ? reply.reason : undefined
        );
        if (reason.success) throw new CapturedRuntimeSourceError(reason.data);
        throw new BackendRoutingError(code === 'conflict' ? 'binding-conflict' : 'hold', 'unknown');
      }
      return reply.value;
    } finally {
      release?.();
    }
  };
  return Object.freeze({
    ...(options.capturePreferences ? { capturePreferences: options.capturePreferences } : {}),
    current: async () => summary(await request('current')),
    retained: async () =>
      runtimeSourceSummarySchema
        .array()
        .max(1025)
        .parse(await request('retained'))
        .map(summary),
    publish: async (input: RuntimeSourcePublishIntent) => {
      const base = { commandId: input.commandId, expectedRevision: input.expectedRevision };
      const captured: RuntimeSourcePublishIntent = input.nativeSelection !== undefined
        ? { ...base, nativeSelection: runtimeSourceNativeSelectionSchema.parse(structuredClone(input.nativeSelection)) }
        : { ...base, candidate: runtimeSourceCandidateSchema.parse(structuredClone(input.candidate)) };
      const result = runtimeSourcePublicationSchema.parse(await request('publish', captured,
        () => options.prepareNativePublication?.(captured)));
      if (result.selection) summary(result.selection);
      if (result.commandId !== captured.commandId) throw new BackendRoutingError('hold', 'unknown');
      return result;
    },
    lookup: async (commandId: string) => {
      const result = runtimeSourcePublicationSchema
        .nullable()
        .parse(await request('lookup', { commandId }));
      if (result?.selection) summary(result.selection);
      if (result && result.commandId !== commandId)
        throw new BackendRoutingError('hold', 'unknown');
      return result;
    },
    refreshConfiguration: async (input: RuntimeConfigurationRefreshIntent) => {
      const captured = refreshRuntimeConfigurationSchema.omit({ grant: true }).parse(structuredClone(input));
      const result = runtimeSourcePublicationSchema.parse(await request('refreshConfiguration', captured,
        () => options.prepareNativeConfiguration?.(captured)));
      if (result.selection) summary(result.selection);
      if (result.commandId !== captured.commandId) throw new BackendRoutingError('hold', 'unknown');
      return result;
    },
    recover: async () => {
      const result = runtimeSourcePublicationSchema.nullable().parse(await request('recover', {},
        options.prepareNativeRecovery));
      if (result?.selection) summary(result.selection);
      return result;
    },
  });
}
