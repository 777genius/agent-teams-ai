import { sanitizeRuntimeDiagnosticText } from '@shared/utils/runtimeDiagnosticText';
import { extractToolPreview, extractToolResultPreview } from '@shared/utils/toolSummary';

import { hostTeamRunId } from '../contracts/teamRunSelection';
import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import { HostTeamOperationError } from './createHostTeamMutations';
import { captureHostProjectFamily } from './hostProjectBindings';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type {
  AgentBackendApi,
  BackendActivityEvent,
  BackendActivitySnapshot,
  BackendRuntimeSnapshot,
} from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { TeamChangeEvent, ToolActivityEventPayload } from '@shared/types/team';

type Listener = (event: unknown, change: TeamChangeEvent) => void;
type Current = () => boolean;
type Connection = BackendConnectionSnapshot['bindings'][number];
export interface HostToolActivityResource {
  key: string;
  connection: Connection;
  memberId: string;
  generation: string;
  launchId: string;
  rosterRevision: string;
  label: string;
}
interface Visible {
  teamName: string;
  runId: string;
  memberName: string;
  current: Current;
  starts: Map<string, BackendActivityEvent>;
  active: Map<string, NonNullable<ToolActivityEventPayload['activity']>>;
}
const proof = (connection: Connection) =>
  JSON.stringify([
    connection.handle,
    connection.ownerResourceRef,
    connection.teamResourceRef,
    connection.projectContextMode,
    connection.projectContext,
  ]);
const time = (value: string | undefined): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const safe = (value: string | undefined) =>
  value === undefined ? undefined : sanitizeRuntimeDiagnosticText(value, 256);

/** Presentation only. The existing approval activity observer owns all reads and its single timer. */
export function createHostToolActivity(options: {
  backend: AgentBackendApi;
  captureScope(): Current;
  readOrder: TeamProductReadOrder;
  wake(): void;
}) {
  const listeners = new Map<symbol, Listener>();
  const tracked = new Map<
    string,
    { teamName: string; current: Current; proof: string; token: symbol }
  >();
  const requests = new Map<string, symbol>();
  const visible = new Map<string, Visible>();
  const emit = (owner: Pick<Visible, 'teamName' | 'runId'>, payload: ToolActivityEventPayload) => {
    for (const [token, listener] of [...listeners]) {
      if (!listeners.has(token)) continue;
      try {
        listener(undefined, {
          teamName: owner.teamName,
          runId: owner.runId,
          type: 'tool-activity',
          detail: JSON.stringify(payload),
        });
      } catch {
        /* Isolate the ordinary Team observers. */
      }
    }
  };
  function reset(entry: Visible, ids = [...entry.active.keys()]): void {
    if (ids.length) emit(entry, { action: 'reset', memberName: entry.memberName, toolUseIds: ids });
    for (const id of ids) entry.active.delete(id);
  }
  function clear(teamName?: string): void {
    for (const [key, entry] of visible)
      if (!teamName || entry.teamName === teamName) {
        reset(entry);
        visible.delete(key);
      }
  }
  function hasWork(): boolean {
    return listeners.size > 0 && [...tracked.values()].some((entry) => entry.current());
  }
  async function setTracking(teamName: string, enabled: boolean): Promise<void> {
    const handleId = parseHostTeamSelectionKey(teamName);
    if (typeof enabled !== 'boolean') throw new HostTeamOperationError('invalid', 'not-dispatched');
    const token = Symbol();
    requests.set(handleId, token);
    if (!enabled) {
      tracked.delete(handleId);
      clear(teamName);
      options.wake();
      return;
    }
    const current = options.captureScope();
    if (!current()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
    const snapshot = await options.backend.getConnections();
    if (!current()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
    if (requests.get(handleId) !== token) return;
    const family = captureHostProjectFamily(snapshot, teamName);
    tracked.set(handleId, { teamName, current, token, proof: proof(family.selected) });
    options.wake();
  }
  function consume(
    resource: HostToolActivityResource,
    view: BackendActivitySnapshot,
    runtime: BackendRuntimeSnapshot,
    resynced: boolean,
    current: Current,
    teamName: string
  ): void {
    let entry = visible.get(resource.key);
    if (!entry || resynced) {
      if (entry) reset(entry);
      entry = {
        teamName,
        runId: hostTeamRunId(
          resource.connection.handle.handleId,
          resource.launchId,
          resource.rosterRevision
        ),
        memberName: resource.label,
        current,
        starts: new Map(),
        active: new Map(),
      };
      visible.set(resource.key, entry);
    }
    entry.current = current;
    if (view.gap || view.state?.partial) {
      reset(entry);
      entry.starts.clear();
      return;
    }
    const open =
      runtime.phase === 'allocated' &&
      runtime.custody === 'owned' &&
      runtime.attached &&
      !runtime.sealed;
    const activeInputs = new Set(
      open
        ? runtime.inputs
            .filter((input) => !input.terminal && ['claimed', 'consumed'].includes(input.phase))
            .map((input) => input.inputId)
        : []
    );
    const events = (resynced ? view.latest.tools : view.events).toSorted(
      (a, b) => a.sequence - b.sequence
    );
    const ended = new Set(
      events
        .filter((event) => event.data.kind === 'tool-result')
        .map((event) =>
          JSON.stringify([event.inputId, 'toolRef' in event.data ? event.data.toolRef : undefined])
        )
    );
    for (const event of events) {
      if (
        !event.inputId ||
        !['tool', 'tool-result'].includes(event.data.kind) ||
        !('toolRef' in event.data)
      )
        continue;
      const id = JSON.stringify([resource.key, event.inputId, event.data.toolRef]);
      if (event.data.kind === 'tool') {
        if (!time(event.observedAt)) continue;
        entry.starts.set(id, event);
        if (resynced && ended.has(JSON.stringify([event.inputId, event.data.toolRef]))) continue;
        if (
          !activeInputs.has(event.inputId) &&
          !ended.has(JSON.stringify([event.inputId, event.data.toolRef]))
        )
          continue;
        if (entry.active.has(id)) continue;
        const input = event.data.input;
        const activity: NonNullable<ToolActivityEventPayload['activity']> = {
          memberName: resource.label,
          toolUseId: id,
          toolName: safe(event.data.name) ?? 'Tool',
          preview: safe(
            input && typeof input === 'object' && !Array.isArray(input)
              ? extractToolPreview(event.data.name, input)
              : undefined
          ),
          startedAt: event.observedAt,
          source: 'runtime',
        };
        entry.active.set(id, activity);
        emit(entry, { action: 'start', activity });
      } else if (event.data.kind === 'tool-result') {
        const start = entry.starts.get(id);
        if (
          entry.active.has(id) &&
          start &&
          time(event.observedAt) &&
          time(start.observedAt) &&
          event.observedAt >= start.observedAt
        ) {
          emit(entry, {
            action: 'finish',
            memberName: resource.label,
            toolUseId: id,
            finishedAt: event.observedAt,
            isError: event.data.isError,
            resultPreview: safe(extractToolResultPreview(event.data.content)),
          });
          entry.active.delete(id);
        } else reset(entry, entry.active.has(id) ? [id] : []);
        entry.starts.delete(id);
      }
    }
    for (const [id, start] of entry.starts)
      if (!start.inputId || !activeInputs.has(start.inputId)) {
        reset(entry, entry.active.has(id) ? [id] : []);
        entry.starts.delete(id);
      }
    if (entry.starts.size > 256) {
      reset(entry);
      entry.starts.clear();
    }
  }
  function begin(snapshot: BackendConnectionSnapshot, active: Current) {
    const permits = new Map<
      string,
      {
        entry: NonNullable<ReturnType<typeof tracked.get>>;
        family: ReturnType<typeof captureHostProjectFamily>;
        assertCurrent(): void;
      }
    >();
    options.readOrder.capture(active);
    for (const [handleId, entry] of tracked) {
      try {
        const family = captureHostProjectFamily(snapshot, entry.teamName);
        if (!entry.current() || proof(family.selected) !== entry.proof)
          throw new Error('Changed owner');
        const fence = options.readOrder.readFence(handleId);
        permits.set(handleId, {
          entry,
          family,
          assertCurrent: () => {
            if (!active() || !entry.current() || tracked.get(handleId) !== entry)
              throw new Error('Changed visibility');
            fence();
          },
        });
      } catch {
        clear(entry.teamName);
      }
    }
    const staged: {
      resource: HostToolActivityResource;
      view: BackendActivitySnapshot;
      runtime: BackendRuntimeSnapshot;
      resynced: boolean;
    }[] = [];
    return {
      hasWork: permits.size > 0,
      tracks(handleId: string): boolean {
        const permit = permits.get(handleId);
        if (!permit) return false;
        try {
          permit.assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      stage(
        resource: HostToolActivityResource,
        view: BackendActivitySnapshot,
        runtime: BackendRuntimeSnapshot,
        resynced: boolean
      ): void {
        staged.push({ resource, view, runtime, resynced });
      },
      reject(handleId: string): void {
        permits.delete(handleId);
      },
      commit(next: BackendConnectionSnapshot): void {
        const retained = new Set<string>();
        for (const item of staged) {
          const permit = permits.get(item.resource.connection.handle.handleId);
          if (!permit) continue;
          try {
            permit.assertCurrent();
            permit.family.assertSame(next);
            consume(
              item.resource,
              item.view,
              item.runtime,
              item.resynced,
              () => {
                try {
                  permit.assertCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
              permit.entry.teamName
            );
            retained.add(item.resource.key);
          } catch {
            /* An unavailable or retired observation cannot keep a tool running. */
          }
        }
        for (const [key, entry] of visible)
          if (!retained.has(key)) {
            reset(entry);
            visible.delete(key);
          }
      },
    };
  }
  function subscribe(listener: Listener): () => void {
    const token = Symbol();
    listeners.set(token, listener);
    for (const entry of visible.values())
      if (entry.current())
        for (const activity of entry.active.values()) {
          try {
            listener(undefined, {
              type: 'tool-activity',
              teamName: entry.teamName,
              runId: entry.runId,
              detail: JSON.stringify({ action: 'start', activity }),
            });
          } catch {
            /* Replay has the same observer isolation as live events. */
          }
        }
    options.wake();
    return () => {
      listeners.delete(token);
      if (!listeners.size) clear();
      options.wake();
    };
  }
  return {
    setTracking,
    subscribe,
    hasWork,
    begin,
    clear,
    hasResource: (key: string) => visible.get(key)?.current() === true,
  };
}
