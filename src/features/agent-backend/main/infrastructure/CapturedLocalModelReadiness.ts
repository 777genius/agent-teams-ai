import {
  actualCaptureReadinessCommandId,
  localModelReadinessCaptureViewSchema,
  parseLiveRosterResponse,
} from '@agent-teams/legacy-agent-host/team-host/readiness';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import { parseLaunchModelPreparation } from '../adapters/input/teamOperationValues';
import { projectBackendResult } from '../adapters/output/projectBackendResult';
import { projectProjectLaunchSource } from '../adapters/output/projectProjectContext';
import { assertBackendRequestGuard, BackendRoutingError } from '../application/backendBinding';
import { capturedTeamModelProbeRootId } from '../application/prepareCapturedTeamModels';

import {
  capturedCreateReadiness,
  captureLocalModelReadinessOrigin,
  captureReadinessInputs,
  readinessOriginDigest,
  readinessRemaining,
} from './CapturedReadinessOrigin';

import type { BackendHandle } from '../../contracts';
import type {
  BackendLaunchConfigurationView,
  BackendLaunchModelSelection,
} from '../../contracts/launch';
import type { BackendOwnerRef, BackendScope } from '../application/backendBinding';
import type { BackendOwnerRouter, BoundBackendCommand } from '../application/BackendOwnerRouter';
import type { TeamModelProbeIntents } from '../application/TeamModelProbeIntents';
import type { LocalModelReadinessContext } from './CapturedReadinessOrigin';
import type { CapturedRosterCommands } from './CapturedRosterCommands';
import type { CapturedTeamRegistry } from './CapturedTeamRegistry';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  LocalModelReadinessCaptureView,
  LocalModelReadinessOrigin,
  LocalModelReadinessPreparation,
} from '@agent-teams/legacy-agent-host/team-host';
import type { TeamRegistryRecord } from '@agent-teams/legacy-agent-host/team-registry/contracts';
import type { CreateTeamLaunchPreparationInput } from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';

export type { LocalModelReadinessContext } from './CapturedReadinessOrigin';
export {
  capturedCreateReadiness,
  captureLocalModelReadinessOrigin,
  captureReadinessSource,
  readinessOriginDigest,
  readinessRemaining,
} from './CapturedReadinessOrigin';

interface Definition {
  owner: BackendOwnerRef;
  contextId: string;
  scope: BackendScope;
}
export interface CapturedRuntimeReadinessTarget {
  launchId: string;
  memberId: string;
  expectedGeneration: string;
}
interface ReadinessRouting {
  requestTimeoutMs?: number;
  intents?: TeamModelProbeIntents;
  rosterCommands?: Pick<CapturedRosterCommands, 'readOriginalIntent'>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const held = (): never => {
  throw new BackendRoutingError('hold');
};

export interface CapturedReadinessOrigin {
  readonly origin: LocalModelReadinessOrigin;
  readonly budget: LocalModelReadinessContext;
}
export function createReadinessPreparation(
  origin: LocalModelReadinessOrigin,
  budget: LocalModelReadinessContext
): CapturedReadinessOrigin {
  return { origin: structuredClone(origin), budget };
}
export function readinessPreparationWire(
  value: CapturedReadinessOrigin
): LocalModelReadinessPreparation {
  return { origin: value.origin, remainingMs: readinessRemaining(value.budget) };
}

/** Original selected client budget; reading another phase never restarts this clock. */
export function captureRequestReadinessBudget(
  requestTimeoutMs: number | undefined
): LocalModelReadinessContext {
  if (!Number.isSafeInteger(requestTimeoutMs) || !requestTimeoutMs || requestTimeoutMs <= 0)
    return held();
  const admitted = performance.now(),
    duration = Math.min(100000, requestTimeoutMs);
  return { remainingMs: () => duration - (performance.now() - admitted) };
}

function currentReadiness(
  router: BackendOwnerRouter,
  definition: Definition,
  guard: BoundBackendCommand['guard'],
  budget: LocalModelReadinessContext
) {
  const owner = router.ownerBinding(definition.owner),
    fingerprint = readinessOriginDigest(owner);
  const current = () => {
    assertBackendRequestGuard(guard);
    if (readinessOriginDigest(router.ownerBinding(definition.owner)) !== fingerprint) return held();
    readinessRemaining(budget);
  };
  current();
  return { owner, current };
}

/** The requested private attachment is stripped before the ordinary public projection. */
export async function readCapturedLaunchReadiness(options: {
  router: BackendOwnerRouter;
  handle: BackendHandle;
  definition: Definition;
  commandId: string;
  launchId: string;
  rosterRevision?: string;
  guard?: BoundBackendCommand['guard'];
  budget: LocalModelReadinessContext;
  capture?: true;
}) {
  const { router, handle, definition, budget } = options;
  if (options.capture && !options.rosterRevision) return held();
  const { current } = currentReadiness(router, definition, options.guard, budget);
  const request = {
    handle,
    commandId: `readiness-read-${readinessOriginDigest([options.commandId, options.launchId])}`,
    operation: 'team.launch.configuration.read' as const,
    payload: { launchId: options.launchId },
  };
  const raw = await router.request(handle, {
    commandId: request.commandId,
    method: request.operation,
    payload: request.payload,
    control: true,
    guard: options.guard,
    requestBudget: budget,
    ...(options.capture && options.rosterRevision
      ? {
          localModelReadinessCapture: {
            launchId: options.launchId,
            rosterRevision: options.rosterRevision,
          },
        }
      : {}),
  });
  current();
  if (!object(raw)) return held();
  const { localModelReadinessCapture, ...publicResult } = raw;
  if (
    options.capture &&
    (!Object.hasOwn(raw, 'localModelReadinessCapture') || localModelReadinessCapture === undefined)
  )
    return held();
  if (!options.capture && localModelReadinessCapture !== undefined) return held();
  const result = projectBackendResult(request, publicResult as JsonValue);
  if (
    !result.ok ||
    !result.value ||
    !('launch' in result.value) ||
    !('members' in result.value) ||
    result.value.launch.launchId !== options.launchId ||
    (options.rosterRevision !== undefined &&
      result.value.launch.rosterRevision !== options.rosterRevision)
  )
    return held();
  let capture: LocalModelReadinessCaptureView | null = null;
  if (localModelReadinessCapture !== null && localModelReadinessCapture !== undefined) {
    const parsed = localModelReadinessCaptureViewSchema.safeParse(localModelReadinessCapture);
    if (!parsed.success) return held();
    capture = parsed.data;
  }
  if (
    capture &&
    (capture.launchId !== options.launchId || capture.rosterRevision !== options.rosterRevision)
  )
    return held();
  return { view: result.value, capture };
}

/** Only a changed actual cwd starts its one already committed child; Host awaits that same probe. */
export async function prepareCapturedWorkspaces(options: {
  router: BackendOwnerRouter;
  handle: BackendHandle;
  definition: Definition;
  view: BackendLaunchConfigurationView;
  capture: LocalModelReadinessCaptureView;
  guard?: BoundBackendCommand['guard'];
  budget: LocalModelReadinessContext;
}): Promise<LocalModelReadinessContext> {
  const { router, handle, definition, view, capture, guard } = options;
  const received = performance.now(),
    remaining = capture.remainingMs;
  const budget = {
    remainingMs: () =>
      Math.min(options.budget.remainingMs(), remaining - (performance.now() - received)),
  };
  const { owner, current } = currentReadiness(router, definition, guard, budget);
  if (
    capture.launchId !== view.launch.launchId ||
    capture.rosterRevision !== view.launch.rosterRevision
  )
    return held();
  const selected = view.members.filter((row) => {
    if (row.selected?.provider !== 'opencode') return false;
    const member = view.launch.members.find((member) => member.memberId === row.memberId);
    if (!member) return held();
    return member.status !== 'skipped';
  });
  if (
    new Set(capture.targets.map((row) => row.memberId)).size !== capture.targets.length ||
    capture.targets.some((target) => !selected.some((row) => row.memberId === target.memberId))
  )
    return held();
  let inputs: ReturnType<typeof captureReadinessInputs> | undefined;
  for (const target of capture.targets) {
    const row = selected.find((member) => member.memberId === target.memberId)!.selected!;
    if (row.context !== undefined) return held();
    if (row.workspace === target.originalWorkspace) continue;
    inputs ??= captureReadinessInputs();
    const commandId = actualCaptureReadinessCommandId(
      capture.preparationId,
      capture.captureCommandId,
      target.memberId
    );
    const payload: BackendLaunchModelSelection = {
      launchId: capture.launchId,
      rosterRevision: capture.rosterRevision,
      memberId: target.memberId,
      model: row.model,
      ...(row.effort === undefined ? {} : { effort: row.effort }),
    };
    const origin = await captureLocalModelReadinessOrigin({
      ...inputs,
      kind: 'team',
      owner,
      contextId: definition.contextId,
      commandId,
      selection: { handleId: handle.handleId, scope: definition.scope, payload },
      workspaces: [row.workspace],
      targets: [
        {
          workspace: row.workspace,
          providerId: parseOpenCodeQualifiedModelRef(row.model)?.sourceId ?? null,
        },
      ],
      current,
      budget,
    });
    current();
    const request = { handle, commandId, operation: 'team.launch.probe.start' as const, payload };
    const raw = await router.request(handle, {
      commandId,
      method: request.operation,
      payload: payload as unknown as JsonValue,
      guard,
      requestBudget: budget,
      localModelReadinessOrigin: createReadinessPreparation(origin, budget),
    });
    current();
    const result = projectBackendResult(request, raw);
    if (
      !result.ok ||
      !result.value ||
      !('phase' in result.value) ||
      !('model' in result.value) ||
      (result.value.phase !== 'running' && (result.value.phase !== 'completed' || !result.value.ok))
    )
      return held();
  }
  current();
  return budget;
}

/** Trusted Main phases retain their original owner, payload and remaining action time. */
export async function requestWithLocalModelReadiness(
  acquire: () => Promise<BackendOwnerRouter>,
  handle: BackendHandle,
  command: BoundBackendCommand,
  definition: Definition | undefined,
  routing: ReadinessRouting = {}
): Promise<JsonValue> {
  handle = { ...handle };
  command = {
    ...command,
    payload: structuredClone(command.payload),
    ...(command.localModelReadinessTarget
      ? { localModelReadinessTarget: structuredClone(command.localModelReadinessTarget) }
      : {}),
  };
  definition = definition ? structuredClone(definition) : undefined;
  const original = command.localModelReadinessContext;
  const preparation = original
    ? {
        remainingMs: original.remainingMs.bind(original),
        ...(original.view ? { view: structuredClone(original.view) } : {}),
      }
    : undefined;
  let payload = object(command.payload) ? command.payload : undefined;
  const locator =
    payload?.modelPreparation === undefined
      ? undefined
      : parseLaunchModelPreparation(payload.modelPreparation);
  if (locator) {
    if (!['team.launch.capture', 'team.launch.start'].includes(command.method)) return held();
    const { modelPreparation: _locator, ...wire } = payload!;
    command = { ...command, payload: wire as JsonValue };
    payload = wire;
  }
  const savedCapture = command.method === 'team.launch.capture' && locator;
  const live = command.method === 'team.roster.replace' && routing.rosterCommands;
  const probe = command.method === 'team.launch.probe.start' && preparation;
  const aggregate = command.method === 'team.launch.start';
  const restart = command.method === 'team.member.action.execute' && payload?.action === 'restart';
  const open = command.method === 'runtime.open' && command.localModelReadinessTarget;
  if (!savedCapture && !live && !probe && !aggregate && !restart && !open) {
    const lookup = command.method === 'team.roster.lookup' && object(payload?.expected);
    const raw = await (
      await acquire()
    ).request(handle, {
      ...command,
      ...(lookup ? { liveRoster: { phase: 'read' as const } } : {}),
    });
    if (object(raw) && ('liveRosterCapture' in raw || 'liveRosterPending' in raw))
      throw new BackendRoutingError('hold', 'unknown');
    return raw;
  }
  const draft = object(payload?.draft) ? payload.draft : undefined;
  const knownProvider = probe
    ? (draft?.providerId ??
      preparation.view?.members.find((row) => row.memberId === payload?.memberId)?.selected
        ?.provider)
    : undefined;
  if (knownProvider === 'claude' || knownProvider === 'anthropic' || knownProvider === 'codex')
    return (await acquire()).request(handle, command);
  const budget = preparation ?? captureRequestReadinessBudget(routing.requestTimeoutMs);
  assertBackendRequestGuard(command.guard);
  readinessRemaining(budget);
  const router = await acquire();
  if (!definition || !payload) return held();
  const { owner, current } = currentReadiness(router, definition, command.guard, budget);
  if (savedCapture) {
    if (!routing.intents || typeof payload.rosterCommandId !== 'string') return held();
    let originalRoster: {
      commandId: string;
      payload: import('../../contracts/roster').BackendRosterReplacement;
    };
    let probeHandle = handle;
    if (locator.projectContext) {
      const raw = await router.request(handle, {
        commandId: `project-source:${readinessOriginDigest({ handle, commandId: command.commandId })}`,
        method: 'team.project-context.launch-source.read',
        payload: {
          logicalHandleId: locator.projectContext.logicalHandleId,
          commandId: locator.projectContext.commandId,
        },
        control: true,
        guard: command.guard,
      });
      current();
      if (!object(raw) || raw.ok !== true) return held();
      const source = projectProjectLaunchSource(raw.value);
      if (
        source.logicalHandleId !== locator.projectContext.logicalHandleId ||
        source.roster.commandId !== payload.rosterCommandId
      )
        return held();
      originalRoster = { commandId: source.roster.commandId, payload: source.roster.expected };
      probeHandle = { handleId: source.logicalHandleId };
    } else {
      if (!routing.rosterCommands) return held();
      originalRoster = await routing.rosterCommands.readOriginalIntent(
        handle.handleId,
        payload.rosterCommandId,
        command.guard
      );
    }
    current();
    const probes = [];
    for (const selection of locator.selections) {
      const retained = await routing.intents.read(
        capturedTeamModelProbeRootId(probeHandle, selection),
        locator.preparationId
      );
      current();
      if (!retained.retained) return held();
      probes.push({ commandId: retained.commandId, selection });
    }
    return router.request(handle, {
      ...command,
      requestBudget: budget,
      localModelReadinessTransfer: {
        preparationId: locator.preparationId,
        probes,
        roster: { commandId: originalRoster.commandId, expected: originalRoster.payload },
        ...(locator.projectContext ? { projectContext: locator.projectContext } : {}),
      },
    });
  }
  if (live) {
    const raw = await router.request(handle, {
      ...command,
      requestBudget: budget,
      liveRoster: { phase: 'capture', remainingMs: readinessRemaining(budget) },
    });
    current();
    if (!object(raw) || !('liveRosterCapture' in raw || 'liveRosterPending' in raw)) return raw;
    const response = parseLiveRosterResponse(raw);
    if (!response.ok || !('liveRosterCapture' in response))
      throw new BackendRoutingError('hold', 'unknown');
    const capture = response.liveRosterCapture;
    const project = response.projectDefinition;
    if (
      project
        ? project.logicalCommandId !== command.commandId ||
          project.logicalHandleId !== handle.handleId ||
          project.logicalTeamId !== definition.scope.teamId ||
          project.logicalExpectedRevision !== payload.expectedRevision ||
          project.logicalRequestDigest !==
            readinessOriginDigest({ commandId: command.commandId, payload })
        : capture.commandId !== command.commandId ||
          capture.teamId !== definition.scope.teamId ||
          capture.requestDigest !==
            readinessOriginDigest({ commandId: command.commandId, payload }) ||
          capture.expectedRevision !== payload.expectedRevision
    )
      return held();
    let origin: CapturedReadinessOrigin | undefined;
    if (capture.target.provider === 'opencode') {
      const inputs = captureReadinessInputs();
      origin = createReadinessPreparation(
        await captureLocalModelReadinessOrigin({
          ...inputs,
          kind: 'team',
          owner,
          contextId: definition.contextId,
          commandId: project ? capture.commandId : command.commandId,
          ...(project ? { projectDefinitionSelectionDigest: project.selectionDigest } : {}),
          selection: {
            handleId: handle.handleId,
            scope: definition.scope,
            payload,
            liveRosterCapture: capture,
          },
          workspaces: [capture.target.workspace],
          targets: [
            { workspace: capture.target.workspace, providerId: capture.target.modelProviderId },
          ],
          current,
          budget,
        }),
        budget
      );
      current();
    }
    const result = await router.request(handle, {
      ...command,
      requestBudget: budget,
      liveRoster: {
        phase: 'continue',
        captureDigest: capture.captureDigest,
        remainingMs: readinessRemaining(budget),
      },
      ...(origin ? { localModelReadinessOrigin: origin } : {}),
    });
    current();
    if (object(result) && ('liveRosterCapture' in result || 'liveRosterPending' in result))
      throw new BackendRoutingError('hold', 'unknown');
    return result;
  }
  let view = preparation?.view;
  let capture: LocalModelReadinessCaptureView | null | undefined;
  const target = command.localModelReadinessTarget;
  const launchId = target?.launchId ?? payload.launchId;
  if (typeof launchId !== 'string') return held();
  if (!view) {
    const read = await readCapturedLaunchReadiness({
      router,
      handle,
      definition,
      commandId: command.commandId,
      launchId,
      ...(typeof payload.rosterRevision === 'string'
        ? { rosterRevision: payload.rosterRevision }
        : {}),
      guard: command.guard,
      budget,
      ...(aggregate ? { capture: true } : {}),
    });
    view = read.view;
    capture = read.capture;
  }
  if (
    view.launch.launchId !== launchId ||
    (payload.rosterRevision !== undefined && view.launch.rosterRevision !== payload.rosterRevision)
  )
    return held();
  if (aggregate && view.launch.admission?.commandId === command.commandId)
    return router.request(handle, command);
  if (
    target &&
    (target.memberId !== payload.memberId ||
      target.expectedGeneration !== payload.expectedGeneration ||
      view.launch.members?.find((row) => row.memberId === target.memberId)?.generation !==
        target.expectedGeneration)
  )
    return held();
  const rows = aggregate
    ? view.members.filter(
        (row) =>
          !view.launch.members?.some(
            (member) => member.memberId === row.memberId && member.status === 'skipped'
          )
      )
    : view.members.filter((row) => row.memberId === payload.memberId);
  const row = rows[0];
  if (!aggregate && !row && !draft) return held();
  const opencode = draft
    ? draft.providerId === 'opencode'
    : rows.some((row) => row.selected?.provider === 'opencode');
  if (!opencode) {
    if (
      draft ||
      rows.every(
        (row) =>
          row.selected?.provider === 'claude' ||
          row.selected?.provider === 'codex' ||
          view.launch.members?.some(
            (member) => member.memberId === row.memberId && member.status === 'skipped'
          )
      )
    )
      return router.request(handle, command);
    return held();
  }
  current();
  if (aggregate) {
    if (capture !== null) {
      if (!capture || (locator && locator.preparationId !== capture.preparationId)) return held();
      const remaining = await prepareCapturedWorkspaces({
        router,
        handle,
        definition,
        view: view as BackendLaunchConfigurationView,
        capture,
        guard: command.guard,
        budget,
      });
      return router.request(handle, { ...command, requestBudget: remaining });
    }
    // Only the successful original Host read can establish this initial no-capture branch.
    if (
      locator ||
      view.launch.admission ||
      rows.some(
        (member) =>
          !member.selected ||
          (member.selected.provider === 'opencode' &&
            view.launch.members?.find((row) => row.memberId === member.memberId)?.status !==
              'not-started')
      )
    )
      return held();
    const configuration = payload.configuration;
    if (
      configuration !== undefined &&
      (!object(configuration) || !Array.isArray(configuration.members))
    )
      return held();
    const configured: unknown[] =
      object(configuration) && Array.isArray(configuration.members) ? configuration.members : [];
    const targets = rows
      .filter((member) => member.selected?.provider === 'opencode')
      .map((member) => {
        const selected = member.selected!;
        const choice = configured.find(
          (value) => object(value) && value.memberId === member.memberId
        );
        if (object(choice) && choice.model !== undefined && typeof choice.model !== 'string')
          return held();
        const model =
          object(choice) && typeof choice.model === 'string' ? choice.model : selected.model;
        return {
          workspace: selected.workspace,
          providerId: parseOpenCodeQualifiedModelRef(model)?.sourceId ?? null,
        };
      });
    const inputs = captureReadinessInputs();
    const origin = await captureLocalModelReadinessOrigin({
      ...inputs,
      kind: 'team',
      owner,
      contextId: definition.contextId,
      commandId: command.commandId,
      selection: { handleId: handle.handleId, scope: definition.scope, payload },
      workspaces: targets.map((row) => row.workspace),
      targets,
      current,
      budget,
    });
    current();
    return router.request(handle, {
      ...command,
      requestBudget: budget,
      localModelReadinessOrigin: createReadinessPreparation(origin, budget),
    });
  }
  const workspace =
    draft && typeof draft.workspace === 'string' ? draft.workspace : row?.selected?.workspace;
  if (!workspace) return held();
  const inputs = captureReadinessInputs();
  const model = typeof payload.model === 'string' ? payload.model : row?.selected?.model;
  const origin = await captureLocalModelReadinessOrigin({
    ...inputs,
    kind: 'team',
    owner,
    contextId: definition.contextId,
    commandId: command.commandId,
    selection: { handleId: handle.handleId, scope: definition.scope, payload },
    workspaces: [workspace],
    targets: [
      { workspace, providerId: parseOpenCodeQualifiedModelRef(model ?? null)?.sourceId ?? null },
    ],
    current,
    budget,
  });
  current();
  return router.request(handle, {
    ...command,
    requestBudget: budget,
    localModelReadinessOrigin: createReadinessPreparation(origin, budget),
  });
}

/** One captured Create conversation; recovered partial results never continue native work. */
export function captureCreatedTeamConversation(options: {
  client: CapturedTeamRegistry;
  router: BackendOwnerRouter;
  owner: BackendOwnerRef;
  contextId: string;
  guard: NonNullable<BoundBackendCommand['guard']>;
  requestTimeoutMs: number;
  refreshSources(cwd: string): Promise<void>;
  register(record: TeamRegistryRecord): Promise<void>;
}) {
  let preparedSources: Promise<void> | undefined;
  let captureOrigin: ReturnType<typeof capturedCreateReadiness> | undefined;
  const selected = (input: CreateTeamLaunchPreparationInput) => {
    if (input.draft.contextId !== options.contextId) throw new BackendRoutingError('forbidden');
    return structuredClone(input);
  };
  const hasOpenCode = (input: CreateTeamLaunchPreparationInput) =>
    input.draft.savedSettings.providerId === 'opencode' ||
    input.draft.members.some((row) => row.memberSettings.providerId === 'opencode');
  const retain = async <
    T extends {
      creation: { commandId: string; phase: string; record: TeamRegistryRecord };
      execution?: TeamRegistryRecord;
    },
  >(
    commandId: string,
    result: T
  ) => {
    if (result.creation.commandId !== commandId || result.creation.phase !== 'published')
      throw new BackendRoutingError('hold', 'unknown');
    await options.register(result.creation.record);
    if (result.execution) await options.register(result.execution);
    return result;
  };
  return {
    prepare: async (
      action: 'prepare' | 'probe.read' | 'probe.cancel',
      input: CreateTeamLaunchPreparationInput,
      readiness?: LocalModelReadinessContext
    ) => {
      const captured = selected(input);
      let origin: CapturedReadinessOrigin | undefined;
      if (action === 'prepare' && hasOpenCode(captured)) {
        if (!readiness) return held();
        const budget = { remainingMs: readiness.remainingMs.bind(readiness) };
        captureOrigin ??= capturedCreateReadiness(options.router, options.owner, () =>
          assertBackendRequestGuard(options.guard)
        );
        preparedSources ??= options.refreshSources(captured.draft.savedSettings.cwd);
        await preparedSources;
        origin = createReadinessPreparation(await captureOrigin(captured, budget), budget);
      }
      return options.client.prepareCreation(
        action,
        captured,
        action === 'probe.cancel' ? undefined : options.guard,
        origin
      );
    },
    submit: async (commandId: string, input: CreateTeamLaunchPreparationInput) => {
      const captured = selected(input);
      if (!hasOpenCode(captured))
        return retain(
          commandId,
          await options.client.submitCreation(commandId, captured, options.guard)
        );
      const budget = captureRequestReadinessBudget(options.requestTimeoutMs);
      let result;
      try {
        result = await options.client.captureCreation(commandId, captured, options.guard, budget);
      } catch (error) {
        const retained = await options.client.lookupCreation(commandId, captured, options.guard);
        if (!retained) throw error;
        return retain(commandId, retained);
      }
      await retain(commandId, result);
      const execution = result.execution ?? result.creation.record;
      const handle = { handleId: execution.binding.handleId };
      const definition = {
        owner: options.owner,
        contextId: options.contextId,
        scope: execution.binding.scope,
      };
      const read = await readCapturedLaunchReadiness({
        router: options.router,
        handle,
        definition,
        commandId,
        launchId: result.launch.launchId,
        rosterRevision: result.launch.rosterRevision,
        guard: options.guard,
        budget,
        capture: true,
      });
      if (!read.capture || read.capture.preparationId !== captured.preparationId) return held();
      const remaining = await prepareCapturedWorkspaces({
        router: options.router,
        handle,
        definition,
        ...read,
        capture: read.capture,
        guard: options.guard,
        budget,
      });
      return retain(
        commandId,
        await options.client.submitCreation(
          commandId,
          captured,
          options.guard,
          { launchId: result.launch.launchId, rosterRevision: result.launch.rosterRevision },
          remaining
        )
      );
    },
  };
}
