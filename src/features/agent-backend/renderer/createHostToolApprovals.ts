import { readBackendAttachmentChunk } from '../contracts/attachments';
import { parseHostTeamSelectionKey } from '../contracts/teamSelection';
import { readBackendToolApprovalSettings } from '../contracts/toolApprovals';

import { HostTeamOperationError } from './createHostTeamMutations';
import { hostTeamSelectionKey } from './hostTeamRouting';
import {
  captureHostToolReply,
  pendingHostToolInteractions,
  projectHostToolApproval,
} from './projectHostToolApproval';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type {
  AgentBackendApi,
  BackendActivityEvent,
  BackendActivitySnapshot,
  BackendActivityState,
  BackendOperationPayloads,
  BackendOperationRequest,
  BackendRuntimeSnapshot,
} from '../contracts/operations';
import type { HostPendingInteraction } from './projectHostToolApproval';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type {
  ToolApprovalFileContent,
  ToolApprovalReadScope,
  ToolApprovalSettings,
} from '@shared/types/team';
import type { ToolApprovalEvent, ToolApprovalRequest } from '@shared/types/team';

type Listener = (event: unknown, request: ToolApprovalEvent) => void;
type Connection = BackendConnectionSnapshot['bindings'][number];
type Current = () => boolean;
interface Resource {
  key: string;
  connection: Connection;
  memberId: string;
  generation: string;
  launchId: string;
  runId: string;
  label: string;
  cursor?: string;
  state: BackendActivityState | null;
  interactions: Map<string, BackendActivityEvent>;
}
interface Pending {
  resource: Resource;
  current: Current;
  fact: HostPendingInteraction;
  request: ToolApprovalRequest;
  visible: boolean;
  outcome: 'pending' | 'checking' | 'submitted' | 'unknown';
  originalReply?: {
    commandId: string;
    payload: BackendOperationPayloads['runtime.interaction'];
  };
}

/** One consumer of existing normalized activity. Maps carry presentation/binding metadata only. */
export function createHostToolApprovals(options: {
  backend: AgentBackendApi;
  captureScope(): Current;
  readOrder: TeamProductReadOrder;
}) {
  const listeners = new Map<symbol, Listener>();
  const resources = new Map<string, Resource>();
  const pending = new Map<string, Pending>();
  const requestByInteraction = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let epoch = 0;
  let priorScope: Current | undefined;

  function emit(event: ToolApprovalEvent): void {
    for (const [token, listener] of [...listeners]) {
      if (!listeners.has(token)) continue;
      try {
        listener(undefined, structuredClone(event));
      } catch {
        /* Isolate existing UI observers. */
      }
    }
  }
  function hide(entry: Pending): void {
    if (!entry.visible) return;
    entry.visible = false;
    emit({
      dismissed: true,
      teamName: entry.request.teamName,
      runId: entry.request.runId,
      requestId: entry.request.requestId,
    });
  }
  function forget(entry: Pending): void {
    hide(entry);
    pending.delete(entry.request.requestId);
    requestByInteraction.delete(
      JSON.stringify([entry.resource.key, entry.fact.inputId, entry.fact.interactionRef])
    );
  }
  function current(check: Current, outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'): void {
    if (!check()) throw new HostTeamOperationError('forbidden', outcome);
  }
  async function read(request: BackendOperationRequest, check: Current) {
    current(check);
    options.readOrder.capture(check);
    const fence = options.readOrder.readFence(request.handle.handleId);
    const result = await options.backend.invoke(request);
    current(check);
    fence();
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    return result.value;
  }
  async function activity(resource: Resource, check: Current): Promise<BackendActivitySnapshot> {
    const payload = {
      memberId: resource.memberId,
      expectedGeneration: resource.generation,
    };
    const snapshot = async () => {
      const value = await read(
        {
          handle: resource.connection.handle,
          commandId: crypto.randomUUID(),
          operation: 'runtime.activity.snapshot',
          payload,
        },
        check
      );
      if (!value || !('latest' in value) || value.memberId !== resource.memberId)
        throw new HostTeamOperationError('invalid-result', 'unknown');
      resource.cursor = value.cursor;
      resource.state = value.state;
      resource.interactions = new Map(
        value.latest.interactions.flatMap((event) =>
          event.data.kind === 'interaction' ? [[event.data.interactionRef, event] as const] : []
        )
      );
      return value;
    };
    if (!resource.cursor) return snapshot();
    const value = await read(
      {
        handle: resource.connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'runtime.activity.feed',
        payload: { ...payload, cursor: resource.cursor },
      },
      check
    );
    if (!value || !('retainedFrom' in value) || value.memberId !== resource.memberId)
      throw new HostTeamOperationError('invalid-result', 'unknown');
    if (value.gap || value.hasMore) return snapshot();
    resource.cursor = value.cursor;
    for (const event of value.events) {
      if (event.data.kind === 'state') resource.state = event.data.state;
      else if (event.data.kind === 'interaction')
        resource.interactions.set(event.data.interactionRef, event);
    }
    const retained = new Set(resource.state?.interactions.map((row) => row.interactionRef));
    for (const key of resource.interactions.keys())
      if (!retained.has(key)) resource.interactions.delete(key);
    return {
      ...value,
      state: resource.state,
      latest: {
        text: [],
        tools: [],
        usage: [],
        compaction: null,
        interactions: [...resource.interactions.values()],
      },
    };
  }
  function accept(resource: Resource, facts: HostPendingInteraction[], check: Current): void {
    const present = new Set<string>();
    for (const fact of facts) {
      const key = JSON.stringify([resource.key, fact.inputId, fact.interactionRef]);
      const requestId = requestByInteraction.get(key) ?? `host-interaction:${crypto.randomUUID()}`;
      let entry = pending.get(requestId);
      present.add(requestId);
      if (entry && JSON.stringify(entry.fact) !== JSON.stringify(fact)) {
        hide(entry); // A changed payload cannot reuse a retained interaction identity.
        entry.outcome = 'unknown';
        continue;
      }
      if (!entry) {
        entry = {
          resource,
          current: check,
          fact: structuredClone(fact),
          visible: false,
          outcome: 'pending',
          request: projectHostToolApproval(
            fact,
            {
              teamName: hostTeamSelectionKey(resource.connection.handle.handleId),
              teamDisplayName: resource.connection.label,
              memberName: resource.label,
              runId: resource.runId,
              requestId,
            },
            Date.now()
          ),
        };
        pending.set(requestId, entry);
        requestByInteraction.set(key, requestId);
      }
      if (!entry.visible) {
        entry.visible = true;
        emit(entry.request);
      }
    }
    for (const entry of [...pending.values()])
      if (entry.resource.key === resource.key && !present.has(entry.request.requestId))
        forget(entry);
  }
  async function poll(): Promise<void> {
    if (polling || !listeners.size) return;
    polling = true;
    const capturedEpoch = epoch;
    const check = options.captureScope();
    const active = () => check() && capturedEpoch === epoch && listeners.size > 0;
    try {
      if (priorScope && !priorScope()) {
        for (const entry of [...pending.values()]) forget(entry);
        resources.clear();
      }
      priorScope = check;
      const connections = await options.backend.getConnections();
      if (!active()) return;
      if (connections.state !== 'ready') {
        for (const entry of pending.values()) hide(entry);
        return;
      }
      const retained = new Set<string>();
      for (const connection of connections.bindings) {
        if (!active()) return;
        try {
          const launch = await read(
            {
              handle: connection.handle,
              commandId: crypto.randomUUID(),
              operation: 'team.launch.read',
              payload: {},
            },
            active
          );
          if (launch === null) continue;
          if (!('launchId' in launch) || !('members' in launch))
            throw new Error('Invalid Host launch');
          for (const member of launch.members) {
            if (!active()) return;
            if (!member.generation || !member.controlAvailable) continue;
            const key = JSON.stringify([
              connection.handle.handleId,
              launch.launchId,
              member.memberId,
              member.generation,
            ]);
            retained.add(key);
            let resource = resources.get(key);
            if (!resource) {
              resource = {
                key,
                connection: structuredClone(connection),
                memberId: member.memberId,
                generation: member.generation,
                launchId: launch.launchId,
                runId: crypto.randomUUID(),
                label:
                  connection.members.find((row) => row.memberId === member.memberId)?.label ??
                  member.memberId,
                state: null,
                interactions: new Map(),
              };
              resources.set(key, resource);
            }
            try {
              const snapshot = await activity(resource, active);
              if (!active()) return;
              accept(resource, pendingHostToolInteractions(snapshot, Date.now()), check);
            } catch {
              if (!active()) return;
              for (const entry of pending.values()) if (entry.resource.key === key) hide(entry);
            }
          }
        } catch {
          if (!active()) return;
          // Failed reads grant nothing and never resolve the original user decision.
          for (const [key, resource] of resources)
            if (resource.connection.handle.handleId === connection.handle.handleId) {
              retained.add(key);
              for (const entry of pending.values()) if (entry.resource.key === key) hide(entry);
            }
        }
      }
      if (!active()) return;
      for (const [key] of resources)
        if (!retained.has(key)) {
          for (const entry of [...pending.values()]) if (entry.resource.key === key) forget(entry);
          resources.delete(key);
        }
    } catch {
      if (active()) for (const entry of pending.values()) hide(entry);
    } finally {
      polling = false;
      if (listeners.size)
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, 1000);
    }
  }
  function subscribe(listener: Listener): () => void {
    const token = Symbol();
    listeners.set(token, listener);
    for (const entry of pending.values())
      if (entry.visible && entry.current() && entry.fact.expiresAt > Date.now())
        listener(undefined, structuredClone(entry.request));
    if (!timer && !polling) void poll();
    return () => {
      listeners.delete(token);
      if (listeners.size) return;
      epoch++;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
  }
  async function respond(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    const entry = pending.get(requestId);
    if (!entry || entry.request.teamName !== teamName || entry.request.runId !== runId)
      throw new HostTeamOperationError('forbidden', 'not-dispatched');
    current(entry.current);
    if (entry.outcome !== 'pending' || entry.fact.expiresAt <= Date.now())
      throw new HostTeamOperationError('hold', 'not-dispatched');
    const reply = captureHostToolReply(entry.fact, allow, message);
    const payload = {
      memberId: entry.resource.memberId,
      expectedGeneration: entry.resource.generation,
      inputId: entry.fact.inputId,
      interactionRef: entry.fact.interactionRef,
      reply,
    };
    const commandId = crypto.randomUUID();
    entry.outcome = 'checking';
    let dispatched = false;
    try {
      const value = await read(
        {
          handle: entry.resource.connection.handle,
          commandId: crypto.randomUUID(),
          operation: 'runtime.read',
          payload: {
            memberId: payload.memberId,
            expectedGeneration: payload.expectedGeneration,
          },
        },
        entry.current
      );
      assertPending(value, entry);
      current(entry.current);
      entry.originalReply = { commandId, payload: structuredClone(payload) };
      entry.outcome = 'submitted';
      dispatched = true;
      const response = await options.backend.invoke({
        handle: entry.resource.connection.handle,
        commandId,
        operation: 'runtime.interaction',
        payload,
      });
      current(entry.current, 'unknown');
      if (!response.ok) {
        if (response.outcome !== 'unknown') dispatched = false;
        throw new HostTeamOperationError(response.code, response.outcome, commandId);
      }
      const state = response.value;
      if (
        !state ||
        !('attached' in state) ||
        state.memberId !== payload.memberId ||
        state.generation !== payload.expectedGeneration ||
        state.interactions.find(
          (row) => row.interactionRef === payload.interactionRef && row.inputId === payload.inputId
        )?.phase !== 'resolved'
      )
        throw new HostTeamOperationError('hold', 'unknown', commandId);
      forget(entry);
    } catch (error) {
      entry.outcome = dispatched ? 'unknown' : 'pending';
      throw error;
    }
  }
  async function updateSettings(teamName: string, raw: ToolApprovalSettings): Promise<void> {
    const settings = readBackendToolApprovalSettings(raw),
      check = options.captureScope();
    current(check);
    const handleId = parseHostTeamSelectionKey(teamName);
    const connections = await options.backend.getConnections();
    current(check);
    const matches = connections.bindings.filter(
      (connection) => connection.handle.handleId === handleId
    );
    if (connections.state !== 'ready' || matches.length !== 1)
      throw new HostTeamOperationError('forbidden', 'not-dispatched');
    const result = await options.backend.invoke({
      handle: matches[0].handle,
      commandId: crypto.randomUUID(),
      operation: 'runtime.approval.settings.update',
      payload: { settings },
    });
    current(check, 'unknown');
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    const value = result.value;
    if (
      !value ||
      !('settings' in value) ||
      JSON.stringify(readBackendToolApprovalSettings(value.settings)) !== JSON.stringify(settings)
    )
      throw new HostTeamOperationError('invalid-result', 'unknown');
  }
  async function readPreview(
    filePath: string,
    scope: ToolApprovalReadScope
  ): Promise<ToolApprovalFileContent> {
    const entry = pending.get(scope.requestId);
    if (
      !entry ||
      entry.request.teamName !== scope.teamName ||
      entry.request.runId !== scope.runId ||
      entry.outcome !== 'pending' ||
      !entry.visible ||
      entry.fact.expiresAt <= Date.now() ||
      filePath !== (entry.fact.toolInput.file_path ?? entry.fact.toolInput.notebook_path)
    )
      throw new HostTeamOperationError('forbidden', 'not-dispatched');
    current(entry.current);
    let offset = 0,
      expectedSha256: string | undefined,
      expectedSource: string | undefined;
    let previousFlags: string | undefined;
    const chunks: string[] = [];
    for (let count = 0; count < 7; count++) {
      current(entry.current);
      const payload = {
        memberId: entry.resource.memberId,
        expectedGeneration: entry.resource.generation,
        inputId: entry.fact.inputId,
        interactionRef: entry.fact.interactionRef,
        offset,
        ...(expectedSha256 ? { expectedSha256 } : {}),
        ...(expectedSource ? { expectedSource } : {}),
      };
      const value = await read(
        {
          handle: entry.resource.connection.handle,
          commandId: crypto.randomUUID(),
          operation: 'runtime.interaction.preview.read',
          payload,
        },
        entry.current
      );
      if (
        !value ||
        !('sourceFingerprint' in value) ||
        !('file' in value) ||
        (expectedSource !== undefined && expectedSource !== value.sourceFingerprint)
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      const flags = JSON.stringify([
        value.sourceFingerprint,
        value.exists,
        value.truncated,
        value.isBinary,
      ]);
      if (previousFlags !== undefined && previousFlags !== flags)
        throw new HostTeamOperationError('conflict', 'unknown');
      previousFlags = flags;
      const chunk = readBackendAttachmentChunk(value.file, { ...payload, attachmentId: 'preview' });
      if (!chunk) {
        if (chunks.length || (value.exists && !value.isBinary))
          throw new HostTeamOperationError('invalid-result', 'unknown');
        return {
          content: '',
          exists: value.exists,
          truncated: value.truncated,
          isBinary: value.isBinary,
        };
      }
      if (
        chunk.attachment.size > 2 * 1024 * 1024 ||
        chunk.attachment.filename !== 'preview' ||
        chunk.attachment.mimeType !== 'text/plain'
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      expectedSha256 = chunk.sha256;
      expectedSource = value.sourceFingerprint;
      chunks.push(chunk.base64);
      if (chunk.nextOffset === null) {
        const bytes = Uint8Array.from(atob(chunks.join('')), (character) =>
          character.charCodeAt(0)
        );
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        current(entry.current);
        const digest = [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (digest !== expectedSha256) throw new HostTeamOperationError('conflict', 'unknown');
        const latest = await read(
          {
            handle: entry.resource.connection.handle,
            commandId: crypto.randomUUID(),
            operation: 'runtime.read',
            payload: { memberId: payload.memberId, expectedGeneration: payload.expectedGeneration },
          },
          entry.current
        );
        assertPending(latest, entry);
        return {
          content: new TextDecoder().decode(bytes),
          exists: value.exists,
          truncated: value.truncated,
          isBinary: value.isBinary,
        };
      }
      offset = chunk.nextOffset;
    }
    throw new HostTeamOperationError('hold', 'unknown');
  }
  return {
    subscribe,
    respond,
    updateSettings,
    readPreview,
    isHostRequestId: (id: string) => id.startsWith('host-interaction:'),
    isPendingPreviewPath: (path: string) =>
      [...pending.values()].some(
        (entry) =>
          entry.visible &&
          path === (entry.fact.toolInput.file_path ?? entry.fact.toolInput.notebook_path)
      ),
  };
}

function assertPending(value: unknown, entry: Pending): asserts value is BackendRuntimeSnapshot {
  const state = value as BackendRuntimeSnapshot | null;
  const fact = state?.interactions?.find(
    (row) => row.interactionRef === entry.fact.interactionRef && row.inputId === entry.fact.inputId
  );
  const input = state?.inputs?.find((row) => row.inputId === entry.fact.inputId);
  if (
    !state ||
    state.memberId !== entry.resource.memberId ||
    state.generation !== entry.resource.generation ||
    state.sealed ||
    state.phase !== 'allocated' ||
    state.custody !== 'owned' ||
    !state.attached ||
    !fact ||
    fact.kind !== entry.fact.kind ||
    fact.phase !== 'pending' ||
    fact.expiresAt !== entry.fact.expiresAt ||
    fact.expiresAt <= Date.now() ||
    !input ||
    !['claimed', 'consumed', 'unknown'].includes(input.phase)
  )
    throw new HostTeamOperationError('hold', 'not-dispatched');
}
