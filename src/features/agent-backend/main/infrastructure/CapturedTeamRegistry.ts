import {
  createTeamRegistryPayloadSchema,
  teamRegistryListSchema,
  teamRegistryReceiptSchema,
} from '@agent-teams/legacy-agent-host/team-registry/contracts';
import {
  createTeamLaunchCaptureResultSchema,
  type CreateTeamLaunchPreparationInput,
  createTeamLaunchPreparationInputSchema,
  createTeamLaunchPreparationSnapshotSchema,
  createTeamLaunchSubmitResultSchema,
} from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';

import { TeamCreationRefusal } from '../../contracts/creation';
import {
  assertBackendRequestGuard,
  BackendRoutingError,
  captureBackendPayload,
} from '../application/backendBinding';

import { type CapturedHostClient, observeCapturedHostStartup } from './CapturedHostClient';
import { readinessPreparationWire, readinessRemaining } from './CapturedLocalModelReadiness';

import type { BackendOwnerBinding, BackendRequestGuard } from '../application/backendBinding';
import type { CapturedReadinessOrigin, LocalModelReadinessContext } from './CapturedLocalModelReadiness';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { LocalModelReadinessCapture } from '@agent-teams/legacy-agent-host/team-host';
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
      | 'team.creation.capture'
      | 'team.creation.submit'
      | 'team.creation.lookup',
    commandId: string,
    payload: unknown,
    guard?: BackendRequestGuard,
    readiness?: CapturedReadinessOrigin,
    allocation?: { capture?: LocalModelReadinessCapture; budget?: LocalModelReadinessContext }
  ) {
    const captured = captureBackendPayload(payload);
    const origin = readiness ? { ...readiness, origin: structuredClone(readiness.origin) } : undefined;
    const selectedCapture = allocation?.capture ? structuredClone(allocation.capture) : undefined;
    const budget = allocation?.budget ?? origin?.budget;
    if (origin && method !== 'team.creation.prepare') throw new BackendRoutingError('invalid-binding');
    if (selectedCapture && method !== 'team.creation.submit' || method === 'team.creation.capture' && !budget)
      throw new BackendRoutingError('invalid-binding');
    this.current(guard);
    if (method === 'team.registry.list') observeCapturedHostStartup('owner-start', 'registry-list');
    await this.options.start();
    if (method === 'team.registry.list')
      observeCapturedHostStartup('owner-started', 'registry-list');
    const wire = origin ? readinessPreparationWire(origin) : undefined;
    const remaining = budget ? readinessRemaining(budget) : undefined;
    this.current(guard);
    if (method === 'team.registry.list') observeCapturedHostStartup('read-start', 'registry-list');
    const result = await this.options.client.request(
      method,
      {
        owner: this.options.owner as unknown as JsonValue,
        commandId,
        payload: captured,
        ...(wire ? { localModelReadinessOrigin: wire as unknown as JsonValue } : {}),
        ...(selectedCapture ? { localModelReadinessCapture: selectedCapture as unknown as JsonValue } : {}),
        ...(method === 'team.creation.capture' ? { localModelReadinessRemainingMs: remaining! } : {}),
      },
      {
        control: ![
          'team.registry.create',
          'team.creation.prepare',
          'team.creation.capture',
          'team.creation.submit',
        ].includes(method),
        ...(budget ? { remainingMs: budget.remainingMs.bind(budget) } : {}),
      }
    );
    if (method === 'team.registry.list')
      observeCapturedHostStartup('read-complete', 'registry-list');
    this.current(guard, 'unknown');
    if (budget) readinessRemaining(budget, 'unknown');
    if (
      (method === 'team.registry.create' || method === 'team.creation.capture' || method === 'team.creation.submit') &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      result.ok === false &&
      result.outcome === 'rejected' &&
      (result.code === 'invalid' ||
        result.code === 'conflict' ||
        result.code === 'forbidden' ||
        result.code === 'unavailable')
    )
      throw new TeamCreationRefusal(result.code, 'rejected');
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
    guard?: BackendRequestGuard,
    readiness?: CapturedReadinessOrigin
  ) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    return createTeamLaunchPreparationSnapshotSchema.parse(
      await this.request(`team.creation.${action}`, captured.preparationId, captured, guard, readiness)
    );
  }

  async submitCreation(
    commandId: string,
    input: CreateTeamLaunchPreparationInput,
    guard?: BackendRequestGuard,
    capture?: LocalModelReadinessCapture,
    budget?: LocalModelReadinessContext
  ) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    let value;
    try {
      value = await this.request('team.creation.submit', commandId, captured, guard, undefined, { capture, budget });
    } catch (error) {
      // One original read can recover a completed capture without claiming native admission.
      // A published Team with an incomplete/in-flight capture remains held at this owner.
      value = await this.request('team.creation.lookup', commandId, captured, guard);
      if (value === null) throw error;
    }
    return createTeamLaunchSubmitResultSchema.parse(value);
  }

  async captureCreation(commandId: string, input: CreateTeamLaunchPreparationInput,
    guard: BackendRequestGuard, budget: LocalModelReadinessContext) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    return createTeamLaunchCaptureResultSchema.parse(
      await this.request('team.creation.capture', commandId, captured, guard, undefined, { budget })
    );
  }

  async lookupCreation(commandId: string, input: CreateTeamLaunchPreparationInput, guard?: BackendRequestGuard) {
    const captured = createTeamLaunchPreparationInputSchema.parse(structuredClone(input));
    const value = await this.request('team.creation.lookup', commandId, captured, guard);
    return value === null ? null : createTeamLaunchSubmitResultSchema.parse(value);
  }
}
