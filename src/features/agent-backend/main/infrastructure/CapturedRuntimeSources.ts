import {
  runtimeSourceCandidateSchema,
  runtimeSourceGrantSchema,
  runtimeSourcePublicationSchema,
  runtimeSourceSummarySchema,
} from '@agent-teams/legacy-agent-host/runtime-sources';

import { BackendRoutingError } from '../application/backendBinding';

import type { CapturedHostClient } from './CapturedHostClient';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  RuntimeSourceCandidate,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '@agent-teams/legacy-agent-host/runtime-sources';

/** Private Main port for an existing descriptor grant; it is never exposed through generic management invoke. */
export interface CapturedRuntimeSources {
  current(): Promise<RuntimeSourceSummary>;
  retained(): Promise<RuntimeSourceSummary[]>;
  publish(input: {
    commandId: string;
    expectedRevision: string;
    candidate: RuntimeSourceCandidate;
  }): Promise<RuntimeSourcePublication>;
  lookup(commandId: string): Promise<RuntimeSourcePublication | null>;
}

export function captureRuntimeSources(options: {
  grant: RuntimeSourceGrant;
  client: Pick<CapturedHostClient, 'request'>;
  start(): Promise<unknown>;
  ownerAvailable(): boolean;
  foregroundCurrent(): boolean;
}): CapturedRuntimeSources {
  const grant = runtimeSourceGrantSchema.parse(structuredClone(options.grant));
  const summary = (raw: unknown) => {
    const selected = runtimeSourceSummarySchema.parse(raw);
    if (
      selected.sourceId !== grant.targetId ||
      (selected.sourceKind === 'captured'
        ? selected.profileId !== grant.profileId || selected.configRevision !== grant.configRevision
        : selected.profileId !== `runtime-source:${selected.revision}` ||
          selected.configRevision !== `runtime-source:${selected.revision}`)
    )
      throw new BackendRoutingError('hold', 'unknown');
    return selected;
  };
  const request = async (
    operation: 'current' | 'retained' | 'publish' | 'lookup',
    payload: object = {}
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
    const reply = await options.client.request(
      `runtime.source.${operation}`,
      JSON.parse(JSON.stringify({ ...payload, grant })) as JsonValue,
      { control: operation !== 'publish' }
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
      throw new BackendRoutingError(code === 'conflict' ? 'binding-conflict' : 'hold', 'unknown');
    }
    return reply.value;
  };
  return Object.freeze({
    current: async () => summary(await request('current')),
    retained: async () =>
      runtimeSourceSummarySchema
        .array()
        .max(1025)
        .parse(await request('retained'))
        .map(summary),
    publish: async (input: {
      commandId: string;
      expectedRevision: string;
      candidate: RuntimeSourceCandidate;
    }) => {
      const captured = {
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        candidate: runtimeSourceCandidateSchema.parse(structuredClone(input.candidate)),
      };
      const result = runtimeSourcePublicationSchema.parse(await request('publish', captured));
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
  });
}
