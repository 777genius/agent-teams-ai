import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Textarea } from '@renderer/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { type Cursor, parseMemberId, type Revision, type TeamId } from '@shared/contracts/hosted';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import {
  HOSTED_TASK_BOARD_COLUMNS,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  HOSTED_TASK_STATUSES,
  type HostedTaskBoardColumn,
  type HostedTaskBoardCoreV1MutationCommand,
  type HostedTaskBoardItem,
  type HostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskIdempotencyKey,
} from '../../contracts/hosted';

import type { HostedTaskBoardTransport } from '../ports/HostedTaskBoardRendererPorts';

const SAFE_ERROR_MESSAGE = 'The task board is temporarily unavailable. Refresh to try again.';
type LoadStatus = 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'error';
type HostedTaskMutationBase = Pick<
  HostedTaskBoardCoreV1MutationCommand,
  | 'schemaVersion'
  | 'commandId'
  | 'idempotencyKey'
  | 'teamId'
  | 'expectedSourceGeneration'
  | 'expectedRevision'
>;
interface HostedTaskBoardViewState {
  readonly items: readonly HostedTaskBoardItem[];
  readonly nextCursor: Cursor | null;
  readonly sourceGeneration: HostedTaskBoardSourceGeneration | null;
  readonly revision: Revision | null;
  readonly status: LoadStatus;
  readonly error: string | null;
  readonly stale: boolean;
  readonly degraded: boolean;
}
export interface HostedTaskBoardPageProps {
  readonly teamId: TeamId;
  readonly transport: HostedTaskBoardTransport;
  readonly heading?: string;
  readonly description?: string;
  readonly pageLimit?: number;
}
const COLUMN_LABELS: Readonly<Record<HostedTaskBoardColumn, string>> = Object.freeze({
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  approved: 'Approved',
  done: 'Done',
});
function initialState(): HostedTaskBoardViewState {
  return Object.freeze({
    items: Object.freeze([]),
    nextCursor: null,
    sourceGeneration: null,
    revision: null,
    status: 'loading',
    error: null,
    stale: false,
    degraded: false,
  });
}
function unstablePage(
  current: HostedTaskBoardViewState,
  incomingItems: readonly HostedTaskBoardItem[],
  sourceGeneration: HostedTaskBoardSourceGeneration,
  revision: Revision,
  nextCursor: Cursor | null,
  seenCursors: ReadonlySet<Cursor>
): boolean {
  const currentIds = new Set(current.items.map((item) => item.taskId));
  return (
    current.sourceGeneration !== sourceGeneration ||
    current.revision !== revision ||
    incomingItems.some((item) => currentIds.has(item.taskId)) ||
    (nextCursor !== null && seenCursors.has(nextCursor))
  );
}
function opaqueNonce(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  } catch {
    /* process-local fallback */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function mutationIdentity() {
  const nonce = opaqueNonce();
  return Object.freeze({
    commandId: parseHostedTaskCommandId(`command_${nonce}`),
    idempotencyKey: parseHostedTaskIdempotencyKey(`mutation_${nonce}`),
  });
}
function nextOrder(items: readonly HostedTaskBoardItem[], column: HostedTaskBoardColumn): number {
  const highestOrder = items
    .filter((item) => item.column === column)
    .reduce((highest, item) => Math.max(highest, item.order), -1);
  return Math.min(1_000_000, highestOrder + 1);
}
function nextStatus(status: HostedTaskBoardItem['status']): HostedTaskBoardItem['status'] {
  const index = HOSTED_TASK_STATUSES.indexOf(status);
  return HOSTED_TASK_STATUSES[(index + 1) % HOSTED_TASK_STATUSES.length] ?? 'pending';
}
interface TaskMutationControlsProps {
  readonly item: HostedTaskBoardItem;
  readonly allItems: readonly HostedTaskBoardItem[];
  readonly columnItems: readonly HostedTaskBoardItem[];
  readonly disabled: boolean;
  readonly orderingDisabled: boolean;
  readonly dispatch: (
    build: (base: HostedTaskMutationBase) => HostedTaskBoardCoreV1MutationCommand
  ) => void;
}
const TaskMutationControls = ({
  item,
  allItems,
  columnItems,
  disabled,
  orderingDisabled,
  dispatch,
}: TaskMutationControlsProps): React.JSX.Element => {
  const [subject, setSubject] = useState(item.subject);
  const [description, setDescription] = useState(item.description ?? '');
  const [ownerId, setOwnerId] = useState(item.ownerId ?? '');
  const columnIndex = HOSTED_TASK_BOARD_COLUMNS.indexOf(item.column);
  const itemIndex = columnItems.findIndex(({ taskId }) => taskId === item.taskId);
  const mutationButtonProps = {
    type: 'button' as const,
    variant: 'outline' as const,
    size: 'sm' as const,
    disabled,
  };
  const reorder = (offset: -1 | 1): void => {
    if (orderingDisabled) return;
    const targetIndex = itemIndex + offset;
    if (itemIndex < 0 || targetIndex < 0 || targetIndex >= columnItems.length) return;
    const orderedTaskIds = columnItems.map(({ taskId }) => taskId);
    [orderedTaskIds[itemIndex], orderedTaskIds[targetIndex]] = [
      orderedTaskIds[targetIndex],
      orderedTaskIds[itemIndex],
    ];
    dispatch((base) =>
      Object.freeze({
        ...base,
        kind: 'reorder_column',
        column: item.column,
        orderedTaskIds: Object.freeze(orderedTaskIds),
      })
    );
  };
  const moveTask = (offset: -1 | 1): void => {
    if (orderingDisabled) return;
    const column = HOSTED_TASK_BOARD_COLUMNS[columnIndex + offset];
    if (column === undefined) return;
    dispatch((base) =>
      Object.freeze({
        ...base,
        kind: 'move_task',
        taskId: item.taskId,
        column,
        order: nextOrder(allItems, column),
      })
    );
  };
  return (
    <div className="mt-3 space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const nextSubject = subject.trim();
          if (nextSubject.length === 0) return;
          dispatch((base) =>
            Object.freeze({
              ...base,
              kind: 'update_details',
              taskId: item.taskId,
              subject: nextSubject,
              description: description.trim().length === 0 ? null : description,
            })
          );
        }}
      >
        <Input
          aria-label={`Title for ${item.subject}`}
          disabled={disabled}
          maxLength={200}
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Textarea
          aria-label={`Description for ${item.subject}`}
          disabled={disabled}
          maxLength={20_000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !subject.trim()}>
          Save details
        </Button>
      </form>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          let parsedOwnerId: HostedTaskBoardItem['ownerId'];
          try {
            parsedOwnerId = ownerId.trim().length === 0 ? null : parseMemberId(ownerId.trim());
          } catch {
            return;
          }
          dispatch((base) =>
            Object.freeze({
              ...base,
              kind: 'update_owner',
              taskId: item.taskId,
              ownerId: parsedOwnerId,
            })
          );
        }}
      >
        <Input
          aria-label={`Owner for ${item.subject}`}
          disabled={disabled}
          pattern="member_[0-9a-f]{32}"
          placeholder="Member ID (blank for unassigned)"
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled}>
          Save owner
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        <Button
          {...mutationButtonProps}
          aria-label={`Next status for ${item.subject}`}
          onClick={() =>
            dispatch((base) =>
              Object.freeze({
                ...base,
                kind: 'update_status',
                taskId: item.taskId,
                status: nextStatus(item.status),
              })
            )
          }
        >
          Next status
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} left`}
          disabled={disabled || orderingDisabled || columnIndex <= 0}
          onClick={() => moveTask(-1)}
        >
          Move left
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} right`}
          disabled={
            disabled || orderingDisabled || columnIndex >= HOSTED_TASK_BOARD_COLUMNS.length - 1
          }
          onClick={() => moveTask(1)}
        >
          Move right
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} up`}
          disabled={disabled || orderingDisabled || itemIndex <= 0}
          onClick={() => reorder(-1)}
        >
          Move up
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} down`}
          disabled={
            disabled || orderingDisabled || itemIndex < 0 || itemIndex >= columnItems.length - 1
          }
          onClick={() => reorder(1)}
        >
          Move down
        </Button>
      </div>
    </div>
  );
};
export const HostedTaskBoardPage = ({
  teamId,
  transport,
  heading = 'Task board',
  description = 'Current team tasks grouped by workflow stage.',
  pageLimit = 25,
}: HostedTaskBoardPageProps): React.JSX.Element => {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new TypeError('hosted-task-board-renderer-page-limit-invalid');
  }
  const headingId = useId();
  const descriptionId = useId();
  const [state, setState] = useState<HostedTaskBoardViewState>(initialState);
  const operationGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const seenCursors = useRef(new Set<Cursor>());
  const transportGeneration = useRef(0);
  const revisionEventWatermark = useRef(0);
  const pendingMutation = useRef<HostedTaskBoardCoreV1MutationCommand | null>(null);
  const [createSubject, setCreateSubject] = useState('');
  useLayoutEffect(() => {
    transportGeneration.current += 1;
    return () => {
      transportGeneration.current += 1;
    };
  }, [transport]);
  const publishError = useCallback((generation: number, currentTransportGeneration: number) => {
    if (
      operationGeneration.current !== generation ||
      transportGeneration.current !== currentTransportGeneration
    )
      return;
    busy.current = false;
    activeController.current = null;
    setState((current) =>
      Object.freeze({ ...current, status: 'error', error: SAFE_ERROR_MESSAGE })
    );
  }, []);
  const isCurrentOperation = useCallback(
    (generation: number, currentTransportGeneration: number, signal: AbortSignal): boolean =>
      operationGeneration.current === generation &&
      transportGeneration.current === currentTransportGeneration &&
      !signal.aborted,
    []
  );
  const markStale = useCallback(() => {
    busy.current = false;
    setState((current) =>
      Object.freeze({ ...current, status: 'refreshing', error: null, stale: true })
    );
  }, []);
  const loadFirstPage = useCallback(
    async (reason: 'initial' | 'manual' | 'mutation' | 'stale'): Promise<void> => {
      const generation = operationGeneration.current + 1;
      operationGeneration.current = generation;
      const currentTransportGeneration = transportGeneration.current;
      const requestEventWatermark = revisionEventWatermark.current;
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      busy.current = true;
      seenCursors.current = new Set();
      setState((current) =>
        Object.freeze({
          ...current,
          items: reason === 'initial' ? Object.freeze([]) : current.items,
          nextCursor: reason === 'initial' ? null : current.nextCursor,
          sourceGeneration: reason === 'initial' ? null : current.sourceGeneration,
          revision: reason === 'initial' ? null : current.revision,
          status: reason === 'initial' || current.items.length === 0 ? 'loading' : 'refreshing',
          error: null,
          stale: reason === 'stale',
          degraded: reason === 'initial' ? false : current.degraded,
        })
      );
      try {
        const result = await transport.getPage(
          Object.freeze({
            schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
            teamId,
            cursor: null,
            expectedSourceGeneration: null,
            limit: pageLimit,
          }),
          Object.freeze({ signal: controller.signal })
        );
        if (!isCurrentOperation(generation, currentTransportGeneration, controller.signal)) return;
        if (result.kind !== 'success' || result.page.teamId !== teamId) {
          publishError(generation, currentTransportGeneration);
          return;
        }
        if (revisionEventWatermark.current !== requestEventWatermark) return;
        if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
        busy.current = false;
        activeController.current = null;
        setState(
          Object.freeze({
            items: result.page.items,
            nextCursor: result.page.nextCursor,
            sourceGeneration: result.page.sourceGeneration,
            revision: result.page.revision,
            status: 'ready',
            error: null,
            stale: false,
            degraded: result.page.degraded.active,
          })
        );
      } catch {
        publishError(generation, currentTransportGeneration);
      }
    },
    [isCurrentOperation, pageLimit, publishError, teamId, transport]
  );
  const executeMutation = useCallback(
    async (command: HostedTaskBoardCoreV1MutationCommand): Promise<void> => {
      const mutation = transport.executeMutation;
      if (mutation === undefined || busy.current) return;
      const execute = mutation.bind(transport);
      const generation = operationGeneration.current + 1;
      operationGeneration.current = generation;
      const currentTransportGeneration = transportGeneration.current;
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      busy.current = true;
      pendingMutation.current = command;
      setState((current) =>
        Object.freeze({ ...current, status: 'refreshing', error: null, stale: false })
      );
      try {
        const result = await execute(command, Object.freeze({ signal: controller.signal }));
        if (!isCurrentOperation(generation, currentTransportGeneration, controller.signal)) return;
        if (result.kind === 'committed' || result.kind === 'idempotent_replay') {
          pendingMutation.current = null;
          busy.current = false;
          await loadFirstPage('mutation');
          return;
        }
        if (
          result.kind === 'stale_generation' ||
          result.kind === 'stale_revision' ||
          result.kind === 'conflict' ||
          result.kind === 'not_found' ||
          result.kind === 'unsafe_active'
        ) {
          pendingMutation.current = null;
          markStale();
          await loadFirstPage('stale');
          return;
        }
        if (result.kind === 'invalid_request') pendingMutation.current = null;
        publishError(generation, currentTransportGeneration);
      } catch {
        publishError(generation, currentTransportGeneration);
      }
    },
    [isCurrentOperation, loadFirstPage, markStale, publishError, transport]
  );
  const retryMutation = useCallback((): void => {
    const command = pendingMutation.current;
    if (command !== null) void executeMutation(command);
  }, [executeMutation]);
  const loadMore = useCallback(async (): Promise<void> => {
    if (
      busy.current ||
      state.nextCursor === null ||
      state.sourceGeneration === null ||
      state.revision === null
    ) {
      return;
    }
    const requestCursor = state.nextCursor;
    const expectedSourceGeneration = state.sourceGeneration;
    const expectedRevision = state.revision;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    const currentTransportGeneration = transportGeneration.current;
    const controller = new AbortController();
    activeController.current = controller;
    busy.current = true;
    setState((current) =>
      Object.freeze({ ...current, status: 'loading_more', error: null, stale: false })
    );
    try {
      const result = await transport.getPage(
        Object.freeze({
          schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
          teamId,
          cursor: requestCursor,
          expectedSourceGeneration,
          limit: pageLimit,
        }),
        Object.freeze({ signal: controller.signal })
      );
      if (!isCurrentOperation(generation, currentTransportGeneration, controller.signal)) return;
      if (result.kind === 'stale_generation') {
        markStale();
        await loadFirstPage('stale');
        return;
      }
      if (
        result.kind !== 'success' ||
        result.page.teamId !== teamId ||
        unstablePage(
          state,
          result.page.items,
          result.page.sourceGeneration,
          result.page.revision,
          result.page.nextCursor,
          seenCursors.current
        ) ||
        expectedRevision !== result.page.revision
      ) {
        if (result.kind === 'success') {
          markStale();
          await loadFirstPage('stale');
        } else {
          publishError(generation, currentTransportGeneration);
        }
        return;
      }
      if (result.page.nextCursor !== null) seenCursors.current.add(result.page.nextCursor);
      busy.current = false;
      activeController.current = null;
      setState((current) =>
        Object.freeze({
          ...current,
          items: Object.freeze([...current.items, ...result.page.items]),
          nextCursor: result.page.nextCursor,
          sourceGeneration: result.page.sourceGeneration,
          revision: result.page.revision,
          status: 'ready',
          error: null,
          stale: false,
          degraded: current.degraded || result.page.degraded.active,
        })
      );
    } catch {
      publishError(generation, currentTransportGeneration);
    }
  }, [
    isCurrentOperation,
    loadFirstPage,
    markStale,
    pageLimit,
    publishError,
    state,
    teamId,
    transport,
  ]);
  const createMutationBase = useCallback((): HostedTaskMutationBase | null => {
    if (state.sourceGeneration === null || state.revision === null) return null;
    return Object.freeze({
      schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
      ...mutationIdentity(),
      teamId,
      expectedSourceGeneration: state.sourceGeneration,
      expectedRevision: state.revision,
    });
  }, [state.revision, state.sourceGeneration, teamId]);
  const dispatchMutation = useCallback(
    (build: (base: HostedTaskMutationBase) => HostedTaskBoardCoreV1MutationCommand): void => {
      const base = createMutationBase();
      if (base !== null) void executeMutation(build(base));
    },
    [createMutationBase, executeMutation]
  );
  useEffect(() => {
    void loadFirstPage('initial');
    const subscribeToInvalidations = transport.subscribeToInvalidations;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe =
        typeof subscribeToInvalidations === 'function'
          ? subscribeToInvalidations.call(transport, teamId, (event) => {
              if (event.teamId !== teamId) return;
              revisionEventWatermark.current += 1;
              void loadFirstPage('stale');
            })
          : undefined;
    } catch {
      // Optional event wiring must not block the HTTP task-board view.
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* optional event teardown */
      }
      operationGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      busy.current = false;
      pendingMutation.current = null;
      seenCursors.current = new Set();
    };
  }, [loadFirstPage, teamId, transport]);
  const isBusy = ['loading', 'refreshing', 'loading_more'].includes(state.status);
  const mutationsEnabled = typeof transport.executeMutation === 'function';
  return (
    <main
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={isBusy}
      className="min-h-full bg-[var(--color-background)] p-4 text-[var(--color-text)]"
    >
      <div className="mx-auto max-w-[1600px]">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 id={headingId} className="text-lg font-semibold">
              {heading}
            </h1>
            <p id={descriptionId} className="mt-1 text-sm text-[var(--color-text-muted)]">
              {description}
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Refresh task board"
                  disabled={isBusy}
                  onClick={() => void loadFirstPage('manual')}
                >
                  {state.status === 'refreshing' ? (
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh task board</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </header>
        {mutationsEnabled ? (
          <form
            className="mt-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const subject = createSubject.trim();
              if (subject.length === 0) return;
              dispatchMutation((base) =>
                Object.freeze({
                  ...base,
                  kind: 'create_task',
                  subject,
                  description: null,
                  status: 'pending',
                  ownerId: null,
                  column: 'todo',
                  order: nextOrder(state.items, 'todo'),
                } satisfies HostedTaskBoardCoreV1MutationCommand)
              );
              setCreateSubject('');
            }}
          >
            <Input
              aria-label="New task title"
              maxLength={200}
              placeholder="Task title"
              required
              value={createSubject}
              onChange={(event) => setCreateSubject(event.target.value)}
            />
            <Button
              type="submit"
              className="justify-self-end"
              disabled={isBusy || createSubject.trim().length === 0}
            >
              Save task
            </Button>
          </form>
        ) : null}
        {state.status === 'loading' && state.items.length === 0 ? (
          <p
            role="status"
            className="mt-6 flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Loading task board…
          </p>
        ) : null}
        {state.stale ? (
          <p
            role="status"
            className="mt-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600"
          >
            <RefreshCw aria-hidden="true" className="size-4 animate-spin" />
            The task board changed. Refreshing the current board…
          </p>
        ) : null}
        {state.error !== null ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500"
          >
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            {state.error}
            {mutationsEnabled && pendingMutation.current !== null ? (
              <Button type="button" variant="outline" size="sm" onClick={retryMutation}>
                Retry task change
              </Button>
            ) : null}
          </div>
        ) : null}
        {state.degraded ? (
          <p className="mt-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-600">
            Some task data may be delayed. Refresh for the latest available view.
          </p>
        ) : null}
        {state.items.length > 0 ? (
          <div
            className="mt-5 grid gap-3 lg:grid-cols-5"
            aria-label={mutationsEnabled ? 'Task board' : 'Read-only task board'}
          >
            {HOSTED_TASK_BOARD_COLUMNS.map((column) => {
              const items = state.items.filter((item) => item.column === column);
              return (
                <section
                  key={column}
                  aria-label={COLUMN_LABELS[column]}
                  className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <h2 className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                    <span>{COLUMN_LABELS[column]}</span>
                    <span aria-label={`${items.length} tasks`}>{items.length}</span>
                  </h2>
                  {items.length === 0 ? (
                    <p className="mt-3 text-xs text-[var(--color-text-subtle)]">No tasks</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {items.map((item) => (
                        <li
                          key={item.taskId}
                          data-task-id={item.taskId}
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
                        >
                          <h3 className="break-words text-sm font-medium">{item.subject}</h3>
                          {item.description !== null && item.description.length > 0 ? (
                            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[var(--color-text-muted)]">
                              {item.description}
                            </p>
                          ) : null}
                          <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">
                            {item.status.replace('_', ' ')}
                          </p>
                          {mutationsEnabled ? (
                            <TaskMutationControls
                              key={[item.taskId, state.sourceGeneration, state.revision].join(':')}
                              item={item}
                              allItems={state.items}
                              columnItems={items}
                              disabled={isBusy}
                              orderingDisabled={state.nextCursor !== null}
                              dispatch={dispatchMutation}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
        {state.status === 'ready' && state.items.length === 0 ? (
          <p className="mt-6 rounded-md bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
            This team has no tasks.
          </p>
        ) : null}
        {state.nextCursor !== null ? (
          <Button
            type="button"
            variant="outline"
            className="mt-4 w-full"
            aria-label="Load more tasks; task moves and whole-column ordering stay disabled until all tasks load"
            disabled={isBusy || state.status === 'error'}
            onClick={() => void loadMore()}
          >
            {state.status === 'loading_more' ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            Load more tasks
          </Button>
        ) : null}
      </div>
    </main>
  );
};
