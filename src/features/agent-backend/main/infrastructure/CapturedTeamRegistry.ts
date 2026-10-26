import {
  createTeamRegistryPayloadSchema,
  teamRegistryListSchema,
  teamRegistryReceiptSchema,
} from '@agent-teams/legacy-agent-host/team-registry/contracts';
import {
  type CreateTeamLaunchPreparationInput,
  createTeamLaunchPreparationInputSchema,
  createTeamLaunchPreparationSnapshotSchema,
  createTeamLaunchSubmitResultSchema,
} from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';

import {
  assertBackendRequestGuard,
  BackendRoutingError,
  captureBackendPayload,
} from '../application/backendBinding';

import { type CapturedHostClient, observeCapturedHostStartup } from './CapturedHostClient';

import type { BackendOwnerBinding, BackendRequestGuard } from '../application/backendBinding';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  CreateTeamRegistryPayload,
  TeamRegistryReceipt,
} from '@agent-teams/legacy-agent-host/team-registry/contracts';

/** Main captures the owner and context; creation outcomes remain only at that Host. */
export class CapturedTeamRegistry {
  constructor(
    private readonly options: {
      owner: BackendOwnerBinding;
      client: Pick<CapturedHostClient, 'request'>;
      start(): Promise<unknown>;
      available(): boolean;
    }
  ) {}

  private async request(
    method:
      | 'team.registry.create'
      | 'team.registry.lookup'
      | 'team.registry.list'
      | 'team.creation.prepare'
      | 'team.creation.probe.read'
      | 'team.creation.probe.cancel'
      | 'team.creation.submit'
      | 'team.creation.lookup',
    commandId: string,
    payload: unknown,
    guard?: BackendRequestGuard
  ) {
    const captured = captureBackendPayload(payload);
    this.current(guard);
    if (method === 'team.registry.list') observeCapturedHostStartup('owner-start', 'registry-list');
    await this.options.start();
    if (method === 'team.registry.list')
      observeCapturedHostStartup('owner-started', 'registry-list');
    this.current(guard);
    if (method === 'team.registry.list') observeCapturedHostStartup('read-start', 'registry-list');
    const result = await this.options.client.request(
      method,
      {
        owner: this.options.owner as unknown as JsonValue,
        commandId,
        payload: captured,
      },
      {
        control: ![
          'team.registry.create',
          'team.creation.prepare',
          'team.creation.submit',
        ].includes(method),
      }
    );
    if (method === 'team.registry.list')
      observeCapturedHostStartup('read-complete', 'registry-list');
    this.current(guard, 'unknown');
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true)
      throw new BackendRoutingError(
        'hold',
        method === 'team.registry.list' ? 'not-dispatched' : 'unknown'
      );
    return result.value;
  }

  private current(
    guard?: BackendRequestGuard,
    outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'
  ): void {
    if (!this.options.available()) throw new BackendRoutingError('unavailable', outcome);
    assertBackendRequestGuard(guard, outcome);
  }

  async list(contextId: string, guard?: BackendRequestGuard) {
    return teamRegistryListSchema.parse(
      await this.request('team.registry.list', crypto.randomUUID(), { contextId }, guard)
    );
  }

  async create(
    commandId: string,
    value: CreateTeamRegistryPayload,
    guard?: BackendRequestGuard
  ): Promise<TeamRegistryReceipt> {
    const payload = createTeamRegistryPayloadSchema.parse(structuredClone(value));
    return teamRegistryReceiptSchema.parse(
      await this.request('team.registry.create', commandId, payload, guard)
    );
  }

  async lookup(
    commandId: string,
    expected: CreateTeamRegistryPayload,
    guard?: BackendRequestGuard
  ): Promise<TeamRegistryReceipt | null> {
    const payload = createTeamRegistryPayloadSchema.parse(structuredClone(expected));
    const value = await this.request(
      'team.registry.lookup',
      commandId,
      { contextId: payload.contextId, expected: payload },
      guard
    );
    return value === null ? null : teamRegistryReceiptSchema.parse(value);
  }

  async prepareCreation(
    action: 'prepare' | 'probe.read' | 'probe.cancel',
    input: CreateTeamLaunchPreparationInput,
    guard?: BackendRequestGuard
  ) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    return createTeamLaunchPreparationSnapshotSchema.parse(
      await this.request(`team.creation.${action}`, captured.preparationId, captured, guard)
    );
  }

  async submitCreation(
    commandId: string,
    input: CreateTeamLaunchPreparationInput,
    guard?: BackendRequestGuard
  ) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    let value;
    try {
      value = await this.request('team.creation.submit', commandId, captured, guard);
    } catch (error) {
      // Transport uncertainty permits only one original read, never a replacement submit.
      value = await this.request('team.creation.lookup', commandId, captured, guard);
      if (value === null) throw error;
    }
    return createTeamLaunchSubmitResultSchema.parse(value);
  }
}
